// The supervisor: spawns one worker per file with the SAME yk (realpath'd
// executable in compiled mode), owns events.jsonl as the single writer,
// keeps a wall-clock watchdog per load/hook/case, and kills the worker's
// whole process group on overrun. Reports come from the same reduction as
// history — never from optimistic in-memory counters.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { isCompiledRuntime } from "@ya-skills/computer-runtime";
import {
  ARTIFACTS_DIR,
  EVENTS_FILE,
  REPORT_FILE,
  SUMMARY_FILE,
  createRunDir,
  formatReport,
  reduceEvents,
  type RunEvent,
  type RunSummary
} from "./history.js";
import type { WorkerEventType } from "./types.js";
import packageJson from "../../../package.json" with { type: "json" };

export const WORKER_COMMAND = "__computer-e2e-worker";
export const DEFAULT_RUN_TIMEOUT_MS = 900_000;
export const DEFAULT_CLEANUP_GRACE_MS = 15_000;
export const LOAD_BUDGET_MS = 30_000;
const WATCHDOG_GRACE_MS = 5_000;
const MAX_EVENT_LINE = 1024 * 1024;

const WORKER_EVENT_TYPES = new Set<string>([
  "runtime",
  "suite_collected",
  "hook_started",
  "hook_finished",
  "case_started",
  "case_finished",
  "step_started",
  "step_finished",
  "action_started",
  "action_finished",
  "application",
  "artifact"
]);

export interface RunOptions {
  files: string[];
  params: Record<string, string>;
  outDir: string;
  timeoutMs: number;
  requireVersion?: string;
}

export type SuperviseOptions = RunOptions & {
  /** @internal test injection — the production CLI never sets this */
  cleanupGraceMs?: number;
  /** @internal abort the run from outside (CLI signal wiring) */
  stopSignal?: AbortSignal;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitRepoInfo(): { revision: string | null; dirty: boolean | null } {
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (rev.status !== 0 || !rev.stdout.trim()) return { revision: null, dirty: null };
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return {
    revision: rev.stdout.trim(),
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  };
}

function toDisplayFile(absolute: string): string {
  const rel = relative(process.cwd(), absolute);
  return rel.startsWith("..") ? absolute : rel;
}

function cliEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "packages", "cli", "src", "cli.ts");
}

interface WorkerOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export async function supervise(options: SuperviseOptions): Promise<RunSummary> {
  if (options.requireVersion !== undefined && options.requireVersion !== packageJson.version) {
    throw new Error(
      `yk version mismatch: --require-version ${options.requireVersion} but this yk is ${packageJson.version}`
    );
  }
  if (typeof Bun === "undefined") {
    throw new Error(
      "computer-e2e run requires the installed yk binary (Bun runtime); the node build cannot spawn workers — install ya-skills or run via bun"
    );
  }
  const absoluteFiles = options.files.map((f) => resolve(f));
  for (const file of absoluteFiles) {
    if (!isAbsolute(file) || !statSync(file).isFile()) {
      throw new Error(`suite file not found: ${file}`);
    }
  }

  const outRoot = resolve(options.outDir); // run records/config paths are always absolute
  const { runDir, runId } = createRunDir(outRoot);
  const eventsPath = join(runDir, EVENTS_FILE);
  let seq = 0;
  const append = (type: RunEvent["type"], payload: Record<string, unknown>): RunEvent => {
    seq += 1;
    const event: RunEvent = { schemaVersion: 1, runId, seq, time: new Date().toISOString(), type, payload };
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  };

  const repo = gitRepoInfo();
  const runtimeFacts = {
    ykVersion: packageJson.version,
    ykExecutableSha256: sha256File(realpathSync(process.execPath)),
    bunVersion: process.versions.bun ?? null,
    platform: process.platform,
    arch: process.arch,
    apiVersion: 1,
    sdkVersion: null,
    testsRepo: repo,
    testSources: absoluteFiles.map((file) => ({ file, sha256: sha256File(file) })),
    files: absoluteFiles
  };
  append("run_started", runtimeFacts);

  const cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
  const overallDeadline = Date.now() + options.timeoutMs;
  let stopped = false;

  const stopSignal = options.stopSignal;
  let activeStop: (() => void) | null = null;
  const onAbort = () => {
    stopped = true;
    // A signal must stop the RUNNING worker (SIGTERM to its group, then the
    // bounded SIGKILL grace) — not just prevent the next file from starting.
    activeStop?.();
  };
  stopSignal?.addEventListener("abort", onAbort, { once: true });

  const workerExitCodes: number[] = [];
  const executed = new Set<string>();

  for (let index = 0; index < absoluteFiles.length; index++) {
    if (stopped) break;
    const file = absoluteFiles[index]!;
    const displayFile = toDisplayFile(file);
    executed.add(file);
    let sawCaseFinished = false;
    const artifactsDir = join(runDir, ARTIFACTS_DIR);
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    const configPath = join(runDir, `.worker-${index}.json`);
    writeFileSync(
      configPath,
      JSON.stringify({ file, runId, artifactsDir, params: options.params }),
      { mode: 0o600 }
    );

    const invocation = isCompiledRuntime()
      ? { executable: realpathSync(process.execPath), args: [WORKER_COMMAND, configPath] }
      : { executable: process.execPath, args: [cliEntryPath(), WORKER_COMMAND, configPath] };

    const stdoutFd = openSync(join(runDir, `worker-${index}.stdout.log`), "a", 0o600);
    const stderrFd = openSync(join(runDir, `worker-${index}.stderr.log`), "a", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd: process.cwd(),
        detached: true,
        // stdout/stderr go straight into the run record; fd3 is the protocol.
        stdio: ["ignore", stdoutFd, stderrFd, "pipe"],
        env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" }
      });
    } catch (error) {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      append("suite_collected", { file: displayFile, loadError: `spawn failed: ${error instanceof Error ? error.message : String(error)}` });
      stopped = true;
      break;
    }

    append("runtime", { workerPid: child.pid });

    // Watchdog: overall cap + per-load/hook/case budgets from the events.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stopped = true;
        requestStop();
      }, Math.max(ms, 1));
    };
    const remainingOverall = () => overallDeadline - Date.now();
    arm(Math.min(LOAD_BUDGET_MS + WATCHDOG_GRACE_MS, Math.max(remainingOverall(), 1)));

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stopRequested = false;
    const requestStop = (): void => {
      if (stopRequested || !child.pid) return;
      stopRequested = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      killTimer = setTimeout(() => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }, cleanupGraceMs);
    };
    const clearTimers = (): void => {
      if (watchdog) clearTimeout(watchdog);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (activeStop === requestStop) activeStop = null;
    };
    activeStop = requestStop;

    const fd3 = child.stdio[3] as import("node:stream").Readable | null;
    const rl = fd3 ? createInterface({ input: fd3 }) : null;
    const streamClosed = new Promise<void>((resolveStream) => {
      if (rl) rl.on("close", () => resolveStream());
      else resolveStream();
    });
    rl?.on("line", (line: string) => {
      if (line.length > MAX_EVENT_LINE) {
        append("worker_protocol_error", { file, reason: `event line exceeds ${MAX_EVENT_LINE} bytes` });
        return;
      }
      let parsed: { type?: unknown; payload?: unknown };
      try {
        parsed = JSON.parse(line) as { type?: unknown; payload?: unknown };
      } catch {
        append("worker_protocol_error", { file, reason: "unparseable event line" });
        return;
      }
      if (
        typeof parsed.type !== "string" ||
        !WORKER_EVENT_TYPES.has(parsed.type) ||
        typeof parsed.payload !== "object" ||
        parsed.payload === null
      ) {
        append("worker_protocol_error", { file, reason: `illegal event type or payload (${String(parsed.type)})` });
        return;
      }
      const payload = parsed.payload as Record<string, unknown>;
      // The watchdog trusts only budgets from collected/started events.
      if (parsed.type === "case_started" || parsed.type === "hook_started") {
        const budget = typeof payload.timeoutMs === "number" ? payload.timeoutMs : LOAD_BUDGET_MS;
        arm(Math.min(budget + WATCHDOG_GRACE_MS, Math.max(remainingOverall(), 1)));
      }
      if (parsed.type === "case_finished") sawCaseFinished = true;
      append(parsed.type as WorkerEventType, { ...payload, file: displayFile });
    });

    const outcome = await new Promise<WorkerOutcome>((resolveExit) => {
      child.once("error", () => resolveExit({ exitCode: null, signal: null }));
      child.once("exit", (code, signal) => resolveExit({ exitCode: code, signal }));
    });
    // Do not lose the final events: wait for fd3 to close (bounded).
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      streamClosed,
      new Promise((r) => {
        drainTimer = setTimeout(r, 500);
      })
    ]);
    clearTimers();
    closeSync(stdoutFd);
    closeSync(stderrFd);
    rmSync(configPath, { force: true });

    if (outcome.exitCode !== null) workerExitCodes.push(outcome.exitCode);
    if (outcome.exitCode === null) {
      append("suite_collected", { file: displayFile, loadError: `worker terminated by ${outcome.signal ?? "unknown signal"} — results unconfirmed` });
      stopped = true;
    } else if (!sawCaseFinished && outcome.exitCode !== 0) {
      // Non-zero exit WITHOUT any terminal case event: the file never
      // reported its outcome — refuse to guess, record it as unconfirmed.
      append("suite_collected", { file: displayFile, loadError: `worker exited with code ${outcome.exitCode} without a terminal case event — results unconfirmed (see worker-${index}.stderr.log)` });
      stopped = true;
    } else if (outcome.exitCode === 1) {
      stopped = true; // a real failure was recorded in events; fail-stop
    }
    // exit 0 (all passed) and exit 2 (skips only) continue to the next file.
  }
  stopSignal?.removeEventListener("abort", onAbort);

  // Final reduction from the recorded facts, then the terminal event. The
  // payload's exitCode must match the POST-terminal reduction: a "missing
  // terminal event" placeholder here would contradict the summary and break
  // the events-as-single-source-of-truth contract, so compute the final
  // shape with a synthetic terminal FIRST, then record it for real.
  const eventsSoFar = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunEvent);
  const syntheticTerminal: RunEvent = {
    schemaVersion: 1,
    runId,
    seq: seq + 1,
    time: "",
    type: "run_finished",
    payload: {}
  };
  const finalLike = reduceEvents([...eventsSoFar, syntheticTerminal]);
  const terminal = append("run_finished", {
    exitCode: finalLike.exitCode,
    status: finalLike.status,
    skippedFiles: absoluteFiles.filter((f) => !executed.has(f)).map((f) => toDisplayFile(f)),
    workerExitCodes
  });

  const finalEvents = [...eventsSoFar, terminal];
  const summary = reduceEvents(finalEvents);
  const tmp = join(runDir, `.${SUMMARY_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(runDir, SUMMARY_FILE));
  writeFileSync(join(runDir, REPORT_FILE), formatReport(summary), { mode: 0o600 });
  return summary;
}
