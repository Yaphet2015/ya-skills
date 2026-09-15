import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sendControl, sendRequest } from "../packages/computer-session/src/client.js";
import { stopProcessGroup } from "../packages/computer-session/src/process.js";
import type { SessionRequest } from "../packages/computer-session/src/types.js";

// These tests exercise the packaged binary's real host/driver subprocess
// boundary with an explicitly injected test module. The module is a fixture,
// not a production fake-driver flag; it never loads the native SDK or touches
// a desktop. They are release-only because package:release must provide yk.
const RELEASE_ENABLED = process.env.YK_RELEASE_TESTS === "1";
const maybe = RELEASE_ENABLED ? test : test.skip;
const outDir = resolve("dist/release/ya-skills");
const packagedYk = join(outDir, "yk");

interface LiveSession {
  dir: string;
  root: string;
  sessionId: string;
  generation: string;
  socketPath: string;
  target: ChildProcess;
  host: ChildProcess;
}

function requirePackagedYk(executable = packagedYk): string {
  if (!existsSync(executable)) {
    throw new Error(`release binary is missing; run package:release before YK_RELEASE_TESTS=1 (${executable})`);
  }
  return executable;
}

function fakeDriverSource(): string {
  // Keep this fixture dependency-free so the compiled binary's separate
  // driver process can import it from a private absolute path.
  return `
    import { appendFileSync } from "node:fs";
    import { join } from "node:path";

    const root = process.env.YK_CU_SESSION_ROOT;
    if (!root) throw new Error("YK_CU_SESSION_ROOT was not provided to fake driver");
    const newline = String.fromCharCode(10);
    const initPath = join(root, "release-lane-driver-init.log");
    const callsPath = join(root, "release-lane-driver-calls.log");
    appendFileSync(initPath, String(process.pid) + newline, { mode: 0o600 });

    export default function () {
      return {
        initCount: 1,
        async call(method, args) {
          if (method === "batch") {
            appendFileSync(callsPath, String(process.pid) + newline, { mode: 0o600 });
            const request = args.request ?? {};
            const actions = Array.isArray(request.actions) ? request.actions : [];
            return {
              status: "completed",
              steps: actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
            };
          }
          if (method === "observe") {
            return {
              pid: 0,
              windowId: 0n,
              observationId: "release-lane-observation",
              capturedAt: Date.now(),
              epoch: "release-lane",
              revision: 0,
              windowTitle: "release lane",
              elements: [],
              totalElementCount: 0n,
              returnedElementCount: 0n,
              filteredElementCount: 0n,
              elementsComplete: true,
              screenshotFrameValid: false
            };
          }
          return null;
        },
        async close() {}
      };
    }
  `;
}

function launchTarget(): ChildProcess {
  // The target is an owned, non-desktop fixture process. Its exact pid is
  // placed in the session request and terminated by the test cleanup only.
  return spawn("/bin/sleep", ["60"], { stdio: "ignore" });
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`owned process ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function stopOwnedTarget(target: ChildProcess): Promise<void> {
  if (target.pid === undefined || target.exitCode !== null || target.signalCode !== null) return;
  try {
    target.kill("SIGTERM");
  } catch {
    return;
  }
  try {
    await waitForExit(target, 2_000);
  } catch {
    try {
      target.kill("SIGKILL");
    } catch {
      // The exact owned pid may have exited between the two signals.
    }
    await waitForExit(target, 2_000).catch(() => undefined);
  }
}

async function launchLiveSession(executable: string, label: string): Promise<LiveSession> {
  requirePackagedYk(executable);
  const dir = mkdtempSync(join(tmpdir(), `yk-lane-release-${label}-`));
  const root = join(dir, "session-root");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = launchTarget();
  if (target.pid === undefined) throw new Error("owned target fixture did not expose a pid");
  const sessionId = randomUUID();
  const generation = randomUUID();
  const socketPath = join(tmpdir(), `yk-lane-${sessionId.replace(/-/g, "").slice(0, 18)}.sock`);
  const driverPath = join(dir, "release-lane-driver.mjs");
  const configPath = join(dir, "host.json");
  writeFileSync(driverPath, fakeDriverSource(), { mode: 0o600 });
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      sessionId,
      generation,
      target: { pid: target.pid, windowId: "12345" },
      root,
      socketPath,
      idleTimeoutMs: 120_000,
      requestsDir: join(root, "unused-requests"),
      driver: { kind: "module", path: driverPath }
    }),
    { mode: 0o600 }
  );
  const host = spawn(executable, ["__computer-session-host", configPath], {
    cwd: dir,
    detached: true,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      NODE_PATH: "",
      BUN_OPTIONS: "",
      HOME: process.env.HOME ?? "/tmp"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  // A host/driver diagnostic must not be allowed to block on full pipes.
  host.stdout?.resume();
  host.stderr?.resume();
  const deadline = Date.now() + 20_000;
  let lastError = "not connected";
  try {
    for (;;) {
      if (host.exitCode !== null || host.signalCode !== null) {
        throw new Error(`packaged host exited before ready (code=${host.exitCode}, signal=${host.signalCode})`);
      }
      try {
        const reply = await sendControl(socketPath, { kind: "status", schemaVersion: 1, sessionId }, 1_000);
        if (reply.info) {
          if (reply.info.hostPid !== host.pid) {
            throw new Error(`packaged host reported pid ${reply.info.hostPid}, expected ${host.pid}`);
          }
          return { dir, root, sessionId, generation, socketPath, target, host };
        }
        lastError = reply.error?.message ?? "status had no session info";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() >= deadline) throw new Error(`packaged fake session did not become ready: ${lastError}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  } catch (error) {
    await stopProcessGroup(host, 2_000).catch(() => undefined);
    await stopOwnedTarget(target);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function closeLiveSession(session: LiveSession): Promise<void> {
  try {
    await sendControl(session.socketPath, { kind: "close", schemaVersion: 1, sessionId: session.sessionId }, 15_000).catch(() => undefined);
    await waitForExit(session.host, 15_000).catch(() => undefined);
  } finally {
    await stopProcessGroup(session.host, 2_000).catch(() => undefined);
    await stopOwnedTarget(session.target);
    rmSync(session.dir, { recursive: true, force: true });
  }
}

function batchRequest(session: LiveSession, requestId: string): SessionRequest {
  return {
    schemaVersion: 1,
    sessionId: session.sessionId,
    generation: session.generation,
    requestId,
    operation: { kind: "batch", request: { actions: [{ kind: "key", key: "Return" }] } }
  };
}

function readPids(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

describe("release lane: packaged live fake session", () => {
  maybe("deduplicates a live request through a separate packaged driver process", async () => {
    const session = await launchLiveSession(packagedYk, "dedup");
    try {
      const request = batchRequest(session, `dedup-${randomUUID()}`);
      const first = await sendRequest(session.socketPath, request, 15_000);
      const second = await sendRequest(session.socketPath, { ...request }, 15_000);
      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      expect((first.result as { steps?: unknown[] })?.steps).toHaveLength(1);
      expect((second.result as { steps?: unknown[] })?.steps).toHaveLength(1);

      const initPids = readPids(join(session.root, "release-lane-driver-init.log"));
      const callPids = readPids(join(session.root, "release-lane-driver-calls.log"));
      expect(initPids).toHaveLength(1);
      expect(callPids).toHaveLength(1);
      expect(session.host.pid).toBeDefined();
      expect(initPids[0]).not.toBe(session.host.pid!);
      expect(initPids[0]).not.toBe(process.pid);
      expect(callPids).toEqual(initPids);

      const leasePath = join(session.root, "leases", `app-${session.target.pid}.lease`);
      const lease = JSON.parse(readFileSync(leasePath, "utf8")) as { pid: number; workerPids?: number[] };
      expect(session.host.pid).toBeDefined();
      expect(lease.pid).toBe(session.host.pid!);
      expect(lease.workerPids).toContain(initPids[0]);
    } finally {
      await closeLiveSession(session);
    }
  }, 60_000);

  maybe("a symlinked packaged executable self-spawns its driver worker", async () => {
    requirePackagedYk();
    const linkDir = mkdtempSync(join(tmpdir(), "yk-lane-release-link-"));
    const symlink = join(linkDir, "yk-link");
    symlinkSync(packagedYk, symlink);
    const session = await launchLiveSession(symlink, "symlink");
    try {
      const reply = await sendRequest(
        session.socketPath,
        batchRequest(session, `symlink-${randomUUID()}`),
        15_000
      );
      expect(reply.status).toBe("completed");
      const initPids = readPids(join(session.root, "release-lane-driver-init.log"));
      expect(initPids).toHaveLength(1);
      expect(session.host.pid).toBeDefined();
      expect(initPids[0]).not.toBe(session.host.pid!);
    } finally {
      await closeLiveSession(session);
      rmSync(linkDir, { recursive: true, force: true });
    }
  }, 60_000);
});
