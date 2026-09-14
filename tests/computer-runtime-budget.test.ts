import { describe, expect, test } from "bun:test";
import { ComputerError, createSessionWithBackend } from "../packages/computer-runtime/src/session.js";
import type { Backend } from "../packages/computer-runtime/src/session.js";

// Budget mechanics: one absolute deadline per native operation shared across
// load/create/work; late-arriving creations get cleaned up and never run work;
// close is idempotent, bounded, ordered, and never masks a primary error.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function okBackend(overrides: Partial<Backend> = {}): Backend {
  const base: Backend = {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "" }),
    clickToken: async () => ({ isError: false }),
    type: async () => ({ isError: false }),
    key: async () => ({ isError: false }),
    scroll: async () => ({ isError: false }),
    metadata: async () => ({ driverVersion: "test", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined
  };
  return { ...base, ...overrides };
}

const target = { pid: 1, windowId: 2n };

describe("session budget (absolute deadline shared by load/create/work)", () => {
  test("load 40 + create 40 + work 40 exceeds a 100ms budget and poisons the session", async () => {
    const backend = okBackend({
      type: async () => {
        await sleep(40);
        return { isError: false };
      }
    });
    const session = createSessionWithBackend(
      {
        load: async () => {
          await sleep(40);
          return {};
        },
        create: async () => {
          await sleep(40);
          return backend;
        }
      },
      { deadlineAt: Date.now() + 100 }
    );
    const error = await session.computer.type(target, "x").then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("command_timeout");
    expect((error as ComputerError).actionOutcome).toBe("unknown");

    // poisoned: even a read is refused afterwards
    const after = await session.computer.apps().then(
      () => null,
      (e: unknown) => e
    );
    expect((after as ComputerError).code).toBe("session_unusable");
    await session.close();
  });

  test("work that fits the REMAINING budget succeeds (no per-stage reset)", async () => {
    const backend = okBackend({
      type: async () => {
        await sleep(5);
        return { isError: false };
      }
    });
    const session = createSessionWithBackend(
      {
        load: async () => {
          await sleep(40);
          return {};
        },
        create: async () => {
          await sleep(40);
          return backend;
        }
      },
      { deadlineAt: Date.now() + 100 }
    );
    await session.computer.type(target, "x"); // 80ms spent, 20ms left, work takes 5ms
    await session.close();
  });

  test("a late-resolving create cleans up its backend and never starts work", async () => {
    let workStarted = 0;
    const cleanupLog: string[] = [];
    const createGate: { resolve: (() => void) | null } = { resolve: null };
    const created = okBackend({
      apps: async () => {
        workStarted++;
        return [];
      },
      endSession: async () => {
        cleanupLog.push("endSession");
      },
      shutdown: async () => {
        cleanupLog.push("shutdown");
      },
      destroy: () => {
        cleanupLog.push("destroy");
      }
    });
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: async () => {
          await new Promise<void>((resolve) => {
            createGate.resolve = resolve;
          });
          return created;
        }
      },
      { deadlineAt: Date.now() + 60, cleanupDeadlineMs: 500 }
    );
    const error = await session.computer.apps().then(
      () => null,
      (e: unknown) => e
    );
    expect((error as ComputerError).code).toBe("command_timeout");
    expect(workStarted).toBe(0);

    createGate.resolve?.(); // the create promise resolves LATE
    await sleep(30);
    expect(cleanupLog).toEqual(["endSession", "shutdown", "destroy"]);
    expect(workStarted).toBe(0);
    await session.close().catch(() => undefined);
  });

  test("close is idempotent and ordered endSession -> shutdown -> destroy", async () => {
    const log: string[] = [];
    const backend = okBackend({
      endSession: async () => {
        log.push("endSession");
      },
      shutdown: async () => {
        log.push("shutdown");
      },
      destroy: () => {
        log.push("destroy");
      }
    });
    const session = createSessionWithBackend({ load: async () => ({}), create: async () => backend }, {});
    await session.computer.apps();
    await session.close();
    await session.close();
    expect(log).toEqual(["endSession", "shutdown", "destroy"]);
  });

  test("a hung endSession exceeds the cleanup budget, destroy still runs, close reports cleanup failure", async () => {
    const log: string[] = [];
    const backend = okBackend({
      endSession: async () => {
        await sleep(300);
        log.push("endSession-late");
      },
      shutdown: async () => {
        log.push("shutdown");
      },
      destroy: () => {
        log.push("destroy");
      }
    });
    const session = createSessionWithBackend(
      { load: async () => ({}), create: async () => backend },
      { cleanupDeadlineMs: 50 }
    );
    await session.computer.apps();
    const error = await session.close().then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("cleanup_failed");
    expect(log).toContain("destroy");
    expect(log).toContain("shutdown");
  });

  test("operations on a closed session are refused without touching the backend", async () => {
    let calls = 0;
    const backend = okBackend({
      apps: async () => {
        calls++;
        return [];
      }
    });
    const session = createSessionWithBackend({ load: async () => ({}), create: async () => backend }, {});
    await session.computer.apps();
    await session.close();
    const error = await session.computer.apps().then(
      () => null,
      (e: unknown) => e
    );
    expect((error as ComputerError).code).toBe("session_closed");
    expect(calls).toBe(1);
  });

  test("an aborted signal refuses before any load", async () => {
    let loads = 0;
    const session = createSessionWithBackend(
      {
        load: async () => {
          loads++;
          return {};
        },
        create: async () => okBackend()
      },
      { signal: AbortSignal.abort() }
    );
    const error = await session.computer.apps().then(
      () => null,
      (e: unknown) => e
    );
    expect((error as ComputerError).code).toBe("aborted");
    expect(loads).toBe(0);
    await session.close();
  });

  test("metadata is read once within the first operation and cached", async () => {
    let metaCalls = 0;
    const seen: string[] = [];
    const backend = okBackend({
      metadata: async () => {
        metaCalls++;
        return { driverVersion: "0.27.0-test", pid: 4242 };
      },
      apps: async () => []
    });
    const session = createSessionWithBackend(
      { load: async () => ({}), create: async () => backend },
      { onRuntime: (info) => seen.push(`${info.driverVersion}:${info.pid}`) }
    );
    expect(await session.metadata()).toEqual({ driverVersion: "0.27.0-test", pid: 4242 });
    expect(await session.metadata()).toEqual({ driverVersion: "0.27.0-test", pid: 4242 });
    expect(metaCalls).toBe(1);
    expect(seen).toEqual(["0.27.0-test:4242"]);
    await session.close();
  });

  test("a session with no operations never creates a backend", async () => {
    let loads = 0;
    let creates = 0;
    const session = createSessionWithBackend(
      {
        load: async () => {
          loads++;
          return {};
        },
        create: async () => {
          creates++;
          return okBackend();
        }
      },
      {}
    );
    await session.close();
    expect(loads).toBe(0);
    expect(creates).toBe(0);
  });

  test("permissions need the sdk but a metadata failure does not break the op", async () => {
    const backend = okBackend({
      apps: async () => [{ pid: 1, name: "A" }],
      metadata: async () => {
        throw new Error("metadata unavailable");
      }
    });
    const session = createSessionWithBackend({ load: async () => ({}), create: async () => backend }, {});
    const apps = await session.computer.apps();
    expect(apps[0]!.name).toBe("A");
    expect(await session.permissions()).toEqual({ accessibility: true, screenRecording: true });
    await session.close();
  });
});
