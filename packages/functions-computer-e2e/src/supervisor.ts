// The supervisor: spawns one worker per file with the SAME yk (realpath'd
// executable in compiled mode), owns events.jsonl as the single writer,
// keeps a wall-clock watchdog per load/hook/case, and kills the worker's
// whole process group on overrun. Reports come from the same reduction as
// history — never from optimistic in-memory counters.

import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  closeOwnedFd,
  createWorkerWatchdog,
  FileSpoolReader,
  spawnWorkerWithRetry,
  stopProcessGroup,
  type SpoolPoll,
  type SpoolTail
} from "@ya-skills/computer-session";
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
export const DEFAULT_SUPERVISOR_LOCK_TIMEOUT_MS = 30_000;
export const LOAD_BUDGET_MS = 30_000;
const WATCHDOG_GRACE_MS = 5_000;
const MAX_EVENT_LINE = 1024 * 1024;
// Preserve the supervisor's historical testing export while sharing the
// implementation with exec's regular-file control spool.
export { FileSpoolReader as IncrementalE2ESpoolReader };
export type { SpoolPoll, SpoolTail };

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

export class SupervisorLockError extends Error {
  constructor(
    public readonly code: "owner_identity_unknown" | "supervisor_lock_timeout" | "supervisor_lock_aborted",
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "SupervisorLockError";
  }
}

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
  /** @internal private lock path for desktop-free ownership tests */
  supervisorLockPath?: string;
  /** @internal bounded lock wait for ownership/recovery tests */
  supervisorLockTimeoutMs?: number;
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

interface SupervisorOwner {
  pid: number;
  token: string;
}

function isSupervisorOwner(value: unknown): value is SupervisorOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as { pid?: unknown; token?: unknown };
  return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.token === "string" && owner.token.length > 0;
}

function sleepForLock(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new SupervisorLockError("supervisor_lock_aborted", "lock acquisition was aborted"));
  }
  return new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new SupervisorLockError("supervisor_lock_aborted", "lock acquisition was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function removeDeadSupervisorLock(lockPath: string, expected: SupervisorOwner): boolean {
  // Reclaimers serialize through a marker inside the old lock directory. This
  // prevents two waiters that both observed one dead owner from one removing
  // the other's newly acquired lock. A stale marker is uncertainty, never a
  // reason to recursively delete the directory.
  const reclaimPath = join(lockPath, ".reclaim");
  try {
    mkdirSync(reclaimPath, { mode: 0o700 });
  } catch {
    return false;
  }
  let removed = false;
  try {
    // Re-read the owner before reclaiming. If another supervisor replaced the
    // directory, leave its lock untouched; an uncertain read is never a reason
    // to recursively delete a lock owned by somebody else.
    const current = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as unknown;
    if (!isSupervisorOwner(current) || current.pid !== expected.pid || current.token !== expected.token) return false;
    rmSync(lockPath, { recursive: true, force: false });
    removed = true;
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      removed = true;
      return true;
    }
    return false;
  } finally {
    if (!removed) {
      // Only remove our marker while the same owner is still present. If the
      // directory changed, leave all ownership evidence intact.
      try {
        const current = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as unknown;
        if (isSupervisorOwner(current) && current.pid === expected.pid && current.token === expected.token) {
          rmSync(reclaimPath, { recursive: true, force: false });
        }
      } catch {
        // Preserve an uncertain marker for explicit owner-side cleanup.
      }
    }
  }
}

async function acquireSupervisorLock(
  lockPath: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<() => void> {
  if (!isAbsolute(lockPath)) throw new Error("supervisor lock path must be absolute");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("supervisor lock timeout must be a positive safe integer");
  }
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let uncertainOwner: string | undefined;
  for (;;) {
    if (signal?.aborted) {
      throw new SupervisorLockError("supervisor_lock_aborted", "lock acquisition was aborted");
    }
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const owner: SupervisorOwner = { pid: process.pid, token };
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
      return () => {
        // Never release a lock that no longer names this acquisition. This is
        // deliberately fail-closed if the owner record was damaged/replaced.
        try {
          const current = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as unknown;
          if (!isSupervisorOwner(current) || current.pid !== process.pid || current.token !== token) return;
          rmSync(lockPath, { recursive: true, force: false });
        } catch {
          // Preserve an uncertain lock for an explicit owner-side cleanup.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: unknown;
      try {
        owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
      } catch {
        uncertainOwner = "owner.json is missing or corrupt";
      }
      if (isSupervisorOwner(owner)) {
        try {
          process.kill(owner.pid, 0);
          uncertainOwner = undefined;
        } catch (probeError) {
          const code = (probeError as NodeJS.ErrnoException).code;
          if (code === "ESRCH") {
            if (removeDeadSupervisorLock(lockPath, owner)) continue;
            uncertainOwner = "the recorded owner changed while reclamation was attempted";
          } else {
            uncertainOwner = `the recorded owner could not be verified (${code ?? "unknown error"})`;
          }
        }
      } else {
        uncertainOwner = "owner.json is missing or corrupt";
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (uncertainOwner !== undefined) {
        throw new SupervisorLockError("owner_identity_unknown", `${uncertainOwner}; lock was preserved`);
      }
      throw new SupervisorLockError("supervisor_lock_timeout", "the existing supervisor lock did not become available");
    }
    await sleepForLock(Math.min(25, remaining), signal);
  }
}

export function supervise(options: SuperviseOptions): Promise<RunSummary> {
  const lockPath = resolve(options.supervisorLockPath ?? SUPERVISOR_LOCK);
  const lockTimeoutMs = options.supervisorLockTimeoutMs ??
    Math.max(1, Math.min(DEFAULT_SUPERVISOR_LOCK_TIMEOUT_MS, options.timeoutMs));
  const run = superviseTail.then(async () => {
    // This admission is intentionally complete before superviseOnce creates a
    // run deadline. A missing/corrupt owner cannot consume an unbounded run or
    // silently hand ownership to a different process.
    const release = await acquireSupervisorLock(lockPath, lockTimeoutMs, options.stopSignal);
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
      child = await spawnWorkerWithRetry(WORKER_COMMAND, configPath, {
        cwd: process.cwd(),
        stdio: ["ignore", stdoutFd, stderrFd, eventFd],
        env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" }
      });
    } catch (error) {
      closeOwnedFd(stdoutFd);
      closeOwnedFd(stderrFd);
      closeOwnedFd(eventFd);
      rmSync(eventSpoolPath, { force: true });
      append("suite_collected", { file: displayFile, loadError: `spawn failed: ${error instanceof Error ? error.message : String(error)}` });
      stopped = true;
      break;
    }
    // The child now owns its duplicated stdio descriptors. Closing the
    // parent's copies before opening the incremental reader prevents Bun from
    // aliasing the reader fd with eventFd during group reaping.
    closeOwnedFd(stdoutFd);
    closeOwnedFd(stderrFd);
    closeOwnedFd(eventFd);

    append("runtime", { workerPid: child.pid });

    let stopRequested = false;
    let stopPromise: ReturnType<typeof stopProcessGroup> | null = null;
    const requestStop = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      stopPromise = stopProcessGroup(child, cleanupGraceMs);
    };
    // Watchdog: overall cap + per-load/hook/case budgets from the events.
    const watchdog = createWorkerWatchdog(() => {
      stopped = true;
      requestStop();
    });
    const arm = (ms: number): void => {
      watchdog.arm(Math.max(ms, 1));
    };
    const remainingOverall = () => overallDeadline - Date.now();
    arm(Math.min(LOAD_BUDGET_MS + WATCHDOG_GRACE_MS, Math.max(remainingOverall(), 1)));

    const clearTimers = (): void => {
      watchdog.clear();
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
    const spoolReader = new FileSpoolReader(eventSpoolPath);
    let spoolFailed = false;
    const pollSpool = (): void => {
      if (spoolFailed) return;
      try {
        const poll = spoolReader.poll();
        for (const line of poll.lines) processLine(line);
      } catch (error) {
        spoolFailed = true;
        append("worker_protocol_error", { file: displayFile, reason: error instanceof Error ? error.message : String(error) });
        requestStop();
      }
    };
    // Polling a regular fd3 spool is incremental and bounded. It avoids Bun
    // 1.3.14's intermittent pipe event loss while preserving live
    // case/hook watchdog updates without rereading the complete history.
    const spoolTimer = setInterval(pollSpool, 20);
    spoolTimer.unref();

    const outcome = await new Promise<WorkerOutcome>((resolveExit) => {
      child.once("error", () => resolveExit({ exitCode: null, signal: null }));
      child.once("exit", (code, signal) => resolveExit({ exitCode: code, signal }));
    });
    clearInterval(spoolTimer);
    // A leader exit is not proof that a descendant is gone. Reap the whole
    // detached worker group before declaring the regular-file spool at EOF;
    // otherwise an inherited fd3 could append after the final poll and its
    // terminal/cleanup events would be deleted with the spool.
    const groupStop = stopPromise ?? stopProcessGroup(child, cleanupGraceMs);
    const groupReaped = await groupStop;
    if (!groupReaped.exited) {
      append("worker_protocol_error", { file: displayFile, reason: `worker process group ${child.pid ?? "?"} could not be fully reaped` });
    }
    if (!spoolFailed) {
      try {
        // The live timer only gets one bounded chunk per tick. Once the worker
        // group is gone, continue in bounded chunks until two stable empty
        // polls prove that no unread tail remains, including a frame split at
        // either side of a chunk boundary.
        await spoolReader.drainToEof((lines) => {
          for (const line of lines) processLine(line);
        });
      } catch (error) {
        spoolFailed = true;
        append("worker_protocol_error", { file: displayFile, reason: error instanceof Error ? error.message : String(error) });
      }
      const tail = spoolReader.finalize();
      if (!tail.complete) {
        spoolFailed = true;
        append("worker_protocol_error", {
          file: displayFile,
          reason: `event spool ended with a truncated UTF-8 frame (${tail.pendingBytes} bytes without newline)`
        });
      }
    }
    spoolReader.close();
    rmSync(eventSpoolPath, { force: true });
    clearTimers();
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
