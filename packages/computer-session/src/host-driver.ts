import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ComputerError,
  type ActionReceipt,
  type BatchAction,
  type StepExecutionResult
} from "@ya-skills/computer-runtime";
import { FrameReader } from "./protocol.js";
import {
  spawnInternalWorker,
  stopProcessGroup,
  TERM_GRACE_MS,
  type StopResult
} from "./process.js";
import { buildDriverSession } from "./driver-worker.js";
import type { DriverHandle, HostConfig } from "./host-types.js";

export type DriverActionEvent = { phase: "started" | "finished"; kind: string; outcome?: string };
export type DriverActionObserver = (event: DriverActionEvent) => void;
export interface StepDriverCall {
  supportsStep?: boolean;
  call(method: "step" | "batch", args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rawStepReceipt(value: unknown): Record<string, unknown> | undefined {
  const root = isRecord(value) ? value : undefined;
  if (root === undefined) return undefined;
  if (isRecord(root.receipt)) return root.receipt;
  if (Array.isArray(root.steps) && isRecord(root.steps[0])) return root.steps[0];
  return root;
}

function executionStatus(
  root: Record<string, unknown> | undefined,
  receiptStatus: ActionReceipt["status"]
): StepExecutionResult["status"] {
  switch (root?.status) {
    case "completed":
    case "failed":
    case "interrupted":
      return root.status;
  }
  if (receiptStatus === "unknown") return "interrupted";
  if (receiptStatus === "delivered" || receiptStatus === "satisfied") return "completed";
  return "failed";
}

function normalizeStepResult(
  value: unknown,
  action: BatchAction,
  index: number
): StepExecutionResult {
  const root = isRecord(value) ? value : undefined;
  const candidate = rawStepReceipt(value);
  const receiptStatus = candidate?.status;
  const status: ActionReceipt["status"] =
    receiptStatus === "delivered" ||
    receiptStatus === "not_delivered" ||
    receiptStatus === "unknown" ||
    receiptStatus === "satisfied" ||
    receiptStatus === "not_run"
      ? receiptStatus
      : "unknown";
  return {
    status: executionStatus(root, status),
    receipt: {
      index,
      kind: action.kind,
      status,
      ...(isRecord(candidate?.error) ? { error: candidate.error as ActionReceipt["error"] } : {})
    }
  };
}

/** Dispatch one action through a capability-selected driver method. Raw
 * transport shapes are normalized here, at the adapter seam. */
export async function callDriverStep(
  driver: StepDriverCall,
  action: BatchAction,
  context: { index: number; deadlineAt: number; signal?: AbortSignal }
): Promise<StepExecutionResult> {
  const method = driver.supportsStep === true ? "step" : "batch";
  const args = method === "step"
    ? {
      action,
      index: context.index,
      deadlineAt: context.deadlineAt
    }
    : {
      request: {
        actions: [action],
        maxActions: 1,
        timeoutMs: Math.max(1, context.deadlineAt - Date.now())
      }
    };
  const result = await driver.call(method, args, context.signal);
  return normalizeStepResult(result, action, context.index);
}

/** Build the persistent driver used by a session. Keeping the two transport
 * implementations behind one handle makes the host lifecycle independent of
 * whether tests inject an in-process driver or production uses a worker. */
export async function buildHostDriver(
  config: HostConfig,
  mode: "subprocess" | "in-process",
  onAction: DriverActionObserver
): Promise<DriverHandle> {
  return mode === "in-process"
    ? inProcessDriver(config, onAction)
    : subprocessDriver(config, onAction);
}

async function subprocessDriver(
  config: HostConfig,
  onAction: DriverActionObserver
): Promise<DriverHandle> {
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const configDir = await mkdtemp(join(tmpdir(), "yk-cu-drv-"));
  const workerConfig = join(configDir, "driver.json");
  await writeFile(
    workerConfig,
    JSON.stringify({
      sessionId: config.sessionId,
      target: config.target,
      ...(config.driver ? { driver: config.driver } : {})
    })
  );
  const { child } = spawnInternalWorker("__computer-driver-worker", workerConfig, {
    env: { YK_CU_SESSION_ROOT: config.root }
  });
  const stdoutReader = new FrameReader();
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  let initCount = 0;
  let exited = false;
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => (readyResolve = resolve));

  child.stdout!.on("data", (chunk: Buffer) => {
    let frames: string[];
    try {
      frames = stdoutReader.push(chunk);
    } catch {
      child.kill("SIGKILL");
      return;
    }
    for (const line of frames) {
      if (line.trim() === "") continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.event === "ready") {
        initCount = Number(message.driverInitCount ?? 1);
        readyResolve();
        continue;
      }
      if (message.event === "action") {
        onAction({
          phase: message.phase === "finished" ? "finished" : "started",
          kind: typeof message.kind === "string" ? message.kind : "unknown",
          outcome: typeof message.outcome === "string" ? message.outcome : undefined
        });
        continue;
      }
      const id = typeof message.id === "string" ? message.id : null;
      if (id && pending.has(id)) {
        const waiter = pending.get(id)!;
        pending.delete(id);
        if (message.ok === true) waiter.resolve(message.result);
        else {
          const error = message.error as { code?: string; message?: string } | undefined;
          waiter.reject(new ComputerError(error?.code ?? "driver_error", error?.message ?? "driver call failed"));
        }
      }
    }
  });
  child.on("exit", () => {
    exited = true;
    void rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    readyResolve();
    const error = new ComputerError("driver_worker_exited", "the driver worker exited unexpectedly", "unknown");
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  await ready;
  if (exited || child.pid === undefined) {
    throw new ComputerError("driver_worker_failed", "the driver worker exited before becoming ready");
  }
  return {
    ready,
    supportsStep: true,
    get initCount() {
      return initCount;
    },
    pid: () => child.pid ?? null,
    call(method, args, signal) {
      return new Promise((resolve, reject) => {
        if (exited) {
          reject(new ComputerError("driver_worker_exited", "the driver worker is gone", "unknown"));
          return;
        }
        if (signal?.aborted) {
          reject(new ComputerError("aborted", "the driver call was aborted", "not_delivered"));
          return;
        }
        const id = randomUUID();
        const onAbort = () => {
          try {
            child.stdin?.write(`${JSON.stringify({ control: "cancel", requestId: id })}\n`);
          } catch {
            // The worker exit path below classifies delivery as unknown.
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve: (value) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          }
        });
        try {
          child.stdin!.write(
            `${JSON.stringify({ id, method, args }, (_key, value) => (typeof value === "bigint" ? value.toString() : value))}\n`
          );
        } catch (error) {
          pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          reject(new ComputerError(
            "driver_worker_exited",
            `could not send driver request: ${error instanceof Error ? error.message : String(error)}`,
            "unknown"
          ));
        }
      });
    },
    alive: () => !exited,
    stop(graceMs = TERM_GRACE_MS) {
      return stopProcessGroup(child, graceMs);
    }
  };
}

async function inProcessDriver(config: HostConfig, onAction: DriverActionObserver): Promise<DriverHandle> {
  const session =
    config.inProcessDriver ??
    (await buildDriverSession({
      sessionId: config.sessionId,
      target: config.target,
      onAction,
      ...(config.driver ? { driver: config.driver } : {})
    }));
  let closed = false;
  return {
    ready: Promise.resolve(),
    initCount: session.initCount ?? 1,
    supportsStep: session.supportsStep === true,
    pid: () => null,
    async call(method, args, signal) {
      if (closed) throw new ComputerError("driver_worker_exited", "the driver worker is closed", "unknown");
      return session.call(method, args, signal);
    },
    alive: () => !closed,
    async stop() {
      closed = true;
      let cleanupFailed = false;
      try {
        await session.close();
      } catch {
        cleanupFailed = true;
      }
      return {
        exited: !cleanupFailed,
        signal: null,
        code: cleanupFailed ? null : 0,
        groupSurvivors: cleanupFailed ? 0 : null
      } satisfies StopResult;
    }
  };
}
