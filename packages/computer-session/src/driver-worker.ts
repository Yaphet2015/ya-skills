// Driver worker (B2): holds ONE ComputerSession for the session's lifetime
// and serves fixed-method requests over stdin/stdout NDJSON. Native calls
// live here so the host's control plane (status/cancel/close) stays
// responsive even when the driver is mid-call. The fixed method enum is the
// entire dispatch surface — no method names cross the pipe from callers.

import { createInterface } from "node:readline";
import {
  ComputerError,
  createComputerSession,
  createObservationStore,
  type BatchRequest,
  type ComputerSession,
  type ObserveOptions,
  type Target
} from "@ya-skills/computer-runtime";

export interface DriverConfig {
  sessionId: string;
  target: { pid: number; windowId: string };
  /** Internal-only test injection: absolute module path written by the
   * spawner. Never a public CLI flag. */
  driver?: { kind: "module"; path: string; export?: string };
  /** Host-side action-event sink (journal SSOT, F8). */
  onAction?: (event: { phase: "started" | "finished"; kind: string; outcome?: string }) => void;
}

export type DriverMethod = "observe" | "batch" | "close";

export interface DriverRequest {
  id: string;
  method: DriverMethod;
  args: Record<string, unknown>;
}

export type DriverResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export interface DriverNotification {
  event: "action" | "ready";
  phase?: "started" | "finished";
  kind?: string;
  outcome?: string;
  driverInitCount?: number;
}

/** Fixed-method session facade. Tests inject fakes with this shape;
 * production always builds the real Cua session exactly once. */
export interface DriverSessionLike {
  /** Optional signal aborts a batch between actions; native work already in
   * flight remains classified by the runtime rather than being replayed. */
  call(method: DriverMethod, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
  /** Test drivers may report the number of native initializations they
   * actually performed; production workers default to one. */
  initCount?: number;
}

export function createRealDriverSession(config: DriverConfig): DriverSessionLike {
  const target: Target = { pid: config.target.pid, windowId: BigInt(config.target.windowId) };
  let session: ComputerSession | null = null;
  let store: ReturnType<typeof createObservationStore> | null = null;
  const root = process.env.YK_CU_SESSION_ROOT;
  if (root) {
    store = createObservationStore(`${root}/observations`);
  }
  const ensure = (): ComputerSession => {
    session ??= createComputerSession({
      ...(root ? { artifactsDir: `${root}/artifacts`, observationStore: store! } : {}),
      ...(config.onAction ? { onAction: config.onAction as never } : {})
    });
    return session;
  };
  return {
    async call(method, args, signal) {
      const computer = ensure().computer;
      switch (method) {
        case "observe":
          return computer.observe(target, (args.options as ObserveOptions | undefined) ?? undefined);
        case "batch":
          return computer.batch(target, args.request as BatchRequest, signal);
        case "close":
          await ensure().close();
          return null;
        default:
          throw new ComputerError("invalid_request", `unknown driver method: ${String(method)}`);
      }
    },
    async close() {
      if (session) await session.close();
    }
  };
}

/** Build the driver session for a config: the real Cua session unless the
 * config injects a test module (internal entrypoint only). */
export async function buildDriverSession(config: DriverConfig): Promise<DriverSessionLike> {
  if (config.driver?.kind === "module") {
    const mod = (await import(config.driver.path)) as Record<string, unknown>;
    const factory = (config.driver.export ? mod[config.driver.export] : mod.default) as
      | ((config: DriverConfig) => DriverSessionLike | Promise<DriverSessionLike>)
      | undefined;
    if (typeof factory !== "function") {
      throw new Error("injected driver module has no usable factory export");
    }
    return factory(config);
  }
  return createRealDriverSession(config);
}

/** Subprocess entrypoint (`yk __computer-driver-worker <config>`). The
 * process exits via stdin close; the returned promise never resolves. */
export function driverWorkerMain(configPath: string): Promise<number> {
  return runDriverWorker(configPath);
}

async function runDriverWorker(configPath: string): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(configPath, "utf8")) as DriverConfig;
  // Action events cross the pipe as notifications; the host journals them
  // (F8). The host's own config callback only exists in-process.
  const workerConfig: DriverConfig = {
    ...config,
    onAction: (event) => send({ event: "action", ...event })
  };
  const session = await buildDriverSession(workerConfig);
  const send = (value: DriverResponse | DriverNotification) => {
    process.stdout.write(
      `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`
    );
  };
  send({ event: "ready", driverInitCount: 1 });
  // Serial native dispatch (F3): the host awaits each call, but the worker
  // itself also refuses a SECOND concurrent native entry — a bug anywhere in
  // the chain can never put two native calls in flight at once.
  let inFlightNative: Promise<void> = Promise.resolve();
  const activeRequests = new Map<string, AbortController>();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    void (async () => {
      let request: DriverRequest & { control?: "cancel"; requestId?: string };
      try {
        request = JSON.parse(line) as DriverRequest & { control?: "cancel"; requestId?: string };
      } catch {
        send({ id: "?", ok: false, error: { code: "protocol_json", message: "driver request is not JSON" } });
        return;
      }
      if (request.control === "cancel") {
        if (typeof request.requestId === "string") activeRequests.get(request.requestId)?.abort();
        return;
      }
      const controller = new AbortController();
      activeRequests.set(request.id, controller);
      const run = async (): Promise<void> => {
        try {
          const result = await session.call(request.method, request.args ?? {}, controller.signal);
          send({ id: request.id, ok: true, result: result ?? null });
        } catch (error) {
          send({
            id: request.id,
            ok: false,
            error: {
              code: error instanceof ComputerError ? error.code : "driver_error",
              message: error instanceof Error ? error.message : String(error)
            }
          });
        } finally {
          activeRequests.delete(request.id);
        }
      };
      inFlightNative = inFlightNative.then(run, run);
    })();
  });
  // stdin close = host is gone: exit promptly, driver cleanup best effort.
  rl.on("close", () => {
    void session
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
  await new Promise<void>(() => undefined); // long-lived: exits via stdin close
  return 0;
}
