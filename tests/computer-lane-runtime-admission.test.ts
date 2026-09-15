import { describe, expect, test } from "bun:test";
import { createSessionWithBackend, ComputerError } from "../packages/computer-runtime/src/session.js";
import type { Backend, Target } from "../packages/computer-runtime/src/types.js";
import type { LeaseHandle } from "../packages/computer-runtime/src/target-lease.js";

const TARGET: Target = { pid: 4242, windowId: 12345n };

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "" }),
    observe: async () => { throw new Error("unexpected observe"); },
    clickToken: async () => ({ isError: false }),
    clickPoint: async () => ({ isError: false }),
    type: async () => ({ isError: false }),
    key: async () => ({ isError: false }),
    scroll: async () => ({ isError: false }),
    metadata: async () => ({ driverVersion: "lane", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined,
    ...overrides
  };
}

function immediateLease(released: { count: number }): LeaseHandle {
  return {
    owner: () => ({ generation: "lane", pid: process.pid, kind: "single-step" }),
    refreshOwner: async () => undefined,
    release: async () => { released.count += 1; }
  };
}

describe("runtime lane operation admission and close", () => {
  test("close drains a lease-waiting mutation and final guard prevents dispatch", async () => {
    let resolveLease!: (value: LeaseHandle) => void;
    const leasePromise = new Promise<LeaseHandle>((resolve) => { resolveLease = resolve; });
    const released = { count: 0 };
    let dispatches = 0;
    let creates = 0;
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: async () => {
          creates += 1;
          return backend({ type: async () => { dispatches += 1; return { isError: false }; } });
        }
      },
      {
        leases: { acquire: async () => leasePromise },
        cleanupDeadlineMs: 500
      }
    );

    const mutation = session.computer.type(TARGET, "must-not-send");
    // Let the mutation reserve admission and enter the unresolved lease.
    await Promise.resolve();
    const closing = session.close();
    resolveLease(immediateLease(released));

    const mutationError = await mutation.then(() => null, (error: unknown) => error);
    expect(mutationError).toBeInstanceOf(ComputerError);
    expect((mutationError as ComputerError).code).toBe("session_closed");
    await closing;
    expect(dispatches).toBe(0);
    expect(creates).toBe(0);
    expect(released.count).toBe(1);
  });

  test("close waits for driver setup, then cleans the late backend exactly once", async () => {
    let resolveCreate!: (value: Backend) => void;
    const createPromise = new Promise<Backend>((resolve) => { resolveCreate = resolve; });
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve; });
    const cleanup: string[] = [];
    let dispatches = 0;
    const events: string[] = [];
    const lateBackend = backend({
      apps: async () => [],
      type: async () => { dispatches += 1; return { isError: false }; },
      endSession: async () => { cleanup.push("endSession"); },
      shutdown: async () => { cleanup.push("shutdown"); },
      destroy: () => { cleanup.push("destroy"); }
    });
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: async () => {
          signalCreateStarted();
          return createPromise;
        }
      },
      { cleanupDeadlineMs: 500, onAction: (event) => events.push(`${event.phase}:${event.kind}:${event.outcome ?? ""}`) }
    );
    const read = session.computer.type(TARGET, "must-not-send");
    await createStarted;
    const closing = session.close();
    resolveCreate(lateBackend);
    const readError = await read.then(() => null, (error: unknown) => error);
    expect(readError).toBeInstanceOf(ComputerError);
    expect((readError as ComputerError).code).toBe("session_closed");
    await closing;
    expect(dispatches).toBe(0);
    expect(events).toEqual(["started:type:", "finished:type:not_delivered"]);
    expect(cleanup).toEqual(["endSession", "shutdown", "destroy"]);
  });

  test("public close remains repeatable after admission has drained", async () => {
    let closeCalls = 0;
    const session = createSessionWithBackend({
      load: async () => ({}),
      create: async () => backend({
        endSession: async () => { closeCalls += 1; },
        shutdown: async () => { closeCalls += 1; },
        destroy: () => { closeCalls += 1; }
      })
    });
    await session.computer.apps();
    await Promise.all([session.close(), session.close(), session.close()]);
    expect(closeCalls).toBe(3);
    await session.close();
    expect(closeCalls).toBe(3);
  });
});
