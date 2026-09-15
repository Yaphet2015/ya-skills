// The supervisor: spawns one worker per file with the SAME yk (realpath'd
// executable in compiled mode), owns events.jsonl as the single writer,
// keeps a wall-clock watchdog per load/hook/case, and kills the worker's
// whole process group on overrun. Reports come from the same reduction as
// history — never from optimistic in-memory counters.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  closeSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isCompiledRuntime } from "@ya-skills/computer-runtime";
import { FrameReader } from "@ya-skills/computer-session";
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

function processGroupHasRunnableMember(pid: number): boolean {
  const ps = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (ps.status !== 0) return true; // conservative when process inventory is unavailable
  for (const line of (ps.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || Number(match[1]) !== pid) continue;
    if (!match[2]!.startsWith("Z")) return true;
  }
  // A group made only of zombies has no runnable/native work left. The OS
  // reaper may keep its pid visible briefly, so do not hold the next run on
  // kill(-pgid, 0) alone.
  return false;
}

async function waitForProcessGroupGone(pid: number | undefined, timeoutMs: number): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pid, 0);
      if (!processGroupHasRunnableMember(pid)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function reapWorkerGroup(pid: number | undefined, graceMs: number): Promise<boolean> {
  const waitMs = Math.max(graceMs, 2_000);
  if (!pid || await waitForProcessGroupGone(pid, 0)) return true;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (await waitForProcessGroupGone(pid, waitMs)) return true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  return waitForProcessGroupGone(pid, waitMs);
}

async function spawnWorkerWithRetry(
  executable: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
): Promise<ChildProcess> {
  let lastError: unknown;
  // Bun 1.3.14 can transiently report ENOENT while wiring several pipe
  // descriptors under concurrent test workers. The spawn has not created a
  // child in that case, so a bounded retry is safe and does not replay work.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return spawn(executable, args, options);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

// The supervisor owns process groups and the global desktop target lease. A
// single yk process serializes run records so Bun 1.3.14 cannot interleave
// child stdio setup across concurrent callers; separate yk processes still
// have independent run roots and their workers retain the runtime lease.
let superviseTail: Promise<void> = Promise.resolve();
const SUPERVISOR_LOCK = join(tmpdir(), "ya-skills-computer-e2e-supervisor.lock");

async function acquireSupervisorLock(): Promise<() => void> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (;;) {
    try {
      mkdirSync(SUPERVISOR_LOCK, { mode: 0o700 });
      writeFileSync(join(SUPERVISOR_LOCK, "owner.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      return () => rmSync(SUPERVISOR_LOCK, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(join(SUPERVISOR_LOCK, "owner.json"), "utf8")) as { pid?: unknown };
        if (typeof owner.pid === "number") {
          try {
            process.kill(owner.pid, 0);
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
              rmSync(SUPERVISOR_LOCK, { recursive: true, force: true });
              continue;
            }
          }
        }
      } catch {
        // An unreadable lock is conservatively retained for another pass;
        // it is never overwritten while its owner is uncertain.
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
    }
  }
}

export function supervise(options: SuperviseOptions): Promise<RunSummary> {
  const run = superviseTail.then(async () => {
    const release = await acquireSupervisorLock();
    try {
      return await superviseOnce(options);
    } finally {
      release();
    }
  });
  superviseTail = run.then(() => undefined, () => undefined);
  return run;
}

async function superviseOnce(options: SuperviseOptions): Promise<RunSummary> {
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

    const stdoutPath = join(runDir, `worker-${index}.stdout.log`);
    const stderrPath = join(runDir, `worker-${index}.stderr.log`);
    const eventSpoolPath = join(runDir, `.worker-${index}.events`);
    // Regular files avoid Bun 1.3.14's mixed numeric-fd/pipe race while
    // retaining fd3 as a distinct control transport. The parent tails this
    // private spool; the public events.jsonl remains parent-owned SSOT.
    const stdoutFd = openSync(stdoutPath, "a", 0o600);
    const stderrFd = openSync(stderrPath, "a", 0o600);
    const eventFd = openSync(eventSpoolPath, "a+", 0o600);
    let child: ChildProcess;
    try {
      child = await spawnWorkerWithRetry(invocation.executable, invocation.args, {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd, eventFd],
        env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" }
      });
    } catch (error) {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      closeSync(eventFd);
      rmSync(eventSpoolPath, { force: true });
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
      if (activeStop === requestStop) activeStop = null;
    };
    activeStop = requestStop;

    const processLine = (line: string): void => {
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE) {
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
    };
    const frameReader = new FrameReader();
    let spoolOffset = 0;
    const pollSpool = (): void => {
      let bytes: Buffer;
      try {
        bytes = readFileSync(eventSpoolPath);
      } catch {
        return;
      }
      if (bytes.length <= spoolOffset) return;
      const chunk = bytes.subarray(spoolOffset);
      spoolOffset = bytes.length;
      try {
        for (const line of frameReader.push(chunk)) processLine(line);
      } catch (error) {
        append("worker_protocol_error", { file: displayFile, reason: error instanceof Error ? error.message : String(error) });
        requestStop();
      }
    };
    // Polling a regular fd3 spool is intentionally small and bounded. It
    // avoids Bun 1.3.14's intermittent pipe event loss while preserving live
    // case/hook watchdog updates.
    const spoolTimer = setInterval(pollSpool, 20);
    spoolTimer.unref();

    const outcome = await new Promise<WorkerOutcome>((resolveExit) => {
      child.once("error", () => resolveExit({ exitCode: null, signal: null }));
      child.once("exit", (code, signal) => resolveExit({ exitCode: code, signal }));
    });
    // Do not lose the final events: read the completed fd3 spool once more
    // after the leader exits, then close all inherited descriptors.
    pollSpool();
    clearInterval(spoolTimer);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    closeSync(eventFd);
    rmSync(eventSpoolPath, { force: true });
    clearTimers();
    // A leader exit is not proof that a descendant is gone. Reap the whole
    // detached worker group before the next run can start; this also avoids
    // Bun 1.3.14 cold-start/stdio contention after a hard timeout.
    const groupReaped = await reapWorkerGroup(child.pid, cleanupGraceMs);
    if (!groupReaped) {
      append("worker_protocol_error", { file: displayFile, reason: `worker process group ${child.pid ?? "?"} could not be fully reaped` });
    }
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
