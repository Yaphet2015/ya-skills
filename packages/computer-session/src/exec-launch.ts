import { type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  closeOwnedFd,
  spawnWorkerWithRetry,
  stopProcessGroup,
  TERM_GRACE_MS
} from "./worker-lifecycle.js";
import type { ExecOptions, JsonValue } from "./exec-types.js";

export { closeOwnedFd } from "./worker-lifecycle.js";

export interface ExecWorkerLaunch {
  child: ChildProcess;
  configDir: string;
  controlPath: string;
  controlReadFd: number;
}

export interface ExecWorkerLaunchOptions {
  sessionId: string;
  generation: string;
  requestId: string;
  target: { pid: number; windowId: bigint };
  state: { version: number; value: Record<string, JsonValue> };
  options: ExecOptions;
  onSpawn?(pid: number | null): Promise<void> | void;
}

/** Create the disposable worker and attach its regular-file control spool. */
export async function launchExecWorker(args: ExecWorkerLaunchOptions): Promise<ExecWorkerLaunch> {
  const sourceAbsolute = isAbsolute(args.options.sourceName)
    ? args.options.sourceName
    : resolve(process.cwd(), args.options.sourceName);
  const scriptCwd = dirname(sourceAbsolute);
  const configDir = await mkdtemp(join(tmpdir(), "yk-cu-exec-"));
  const configPath = join(configDir, "exec.json");
  const controlPath = join(configDir, "control.spool");
  const bootCwd = join(configDir, "boot");
  await mkdir(bootCwd, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      sessionId: args.sessionId,
      requestId: args.requestId,
      generation: args.generation,
      target: { pid: args.target.pid, windowId: args.target.windowId.toString() },
      code: args.options.code,
      sourceName: args.options.sourceName,
      timeoutMs: args.options.timeoutMs,
      maxActions: args.options.maxActions,
      state: args.state.value,
      cwd: scriptCwd
    }),
    { mode: 0o600 }
  );

  // A regular file avoids Bun's concurrent fourth-pipe setup race while
  // retaining the worker's fd3 NDJSON protocol.
  const controlWriteFd = openSync(controlPath, "a", 0o600);
  let child: ChildProcess;
  try {
    child = await spawnWorkerWithRetry("__computer-exec-worker", configPath, {
      stdio: ["pipe", "pipe", "pipe", controlWriteFd],
      cwd: bootCwd,
      env: process.env
    });
  } catch (error) {
    closeOwnedFd(controlWriteFd);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  closeOwnedFd(controlWriteFd);
  const controlReadFd = openSync(controlPath, "r");
  try {
    await args.onSpawn?.(child.pid ?? null);
  } catch (error) {
    await stopProcessGroup(child, TERM_GRACE_MS).catch(() => undefined);
    closeOwnedFd(controlReadFd);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { child, configDir, controlPath, controlReadFd };
}
