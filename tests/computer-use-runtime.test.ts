import { describe, expect, test } from "bun:test";
import {
  compiledSdkUrl,
  isSupportedPlatform,
  runDoctor
} from "@ya-skills/functions-computer-use";
import { ComputerError, type Computer, type ComputerSession } from "@ya-skills/computer-runtime";

test("real sessions and worker steps stay lazy and bypass an incompatible installed daemon", () => {
  // Isolate module mocks so other tests keep the real SDK loader.
  const probe = Bun.spawnSync([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    let loads = 0;
    let creates = 0;
    let ended = 0;
    let stopped = 0;
    let destroyed = 0;
    const inputs = [];
    delete process.env.YK_CU_SESSION_ROOT;
    const sdk = {
      CuaDriver: { create(options) {
        creates++;
        if (!options?.embedded) throw new Error("incompatible installed daemon");
        return {
          metadata: async () => ({ driverVersion: "fixture", pid: process.pid }),
          callTool: async (name, body) => { inputs.push({ name, body: JSON.parse(body) }); return { isError: false }; },
          endSession: async () => { ended++; },
          shutdown: async () => { stopped++; },
          uniffiDestroy: () => { destroyed++; }
        };
      } },
      EndSessionInput: { new: () => ({}) }
    };
    const sdkUrl = ${JSON.stringify(new URL("../packages/computer-runtime/src/sdk.ts", import.meta.url).href)};
    const originalLoader = await import(sdkUrl);
    mock.module(sdkUrl, () => ({
      ...originalLoader,
      isSupportedPlatform: () => true,
      loadSdk: async () => { loads++; return sdk; }
    }));
    const { createComputerSession } = await import(${JSON.stringify(new URL("../packages/computer-runtime/src/cua-backend.ts", import.meta.url).href)});
    const session = createComputerSession();
    assert.equal(loads, 0);
    assert.equal(creates, 0);
    try {
      assert.equal((await session.metadata()).pid, process.pid);
      await session.metadata();
      assert.equal(loads, 1);
      assert.equal(creates, 1);
    } finally { await session.close(); }
    assert.equal(ended, 1);
    assert.equal(stopped, 1);
    assert.equal(destroyed, 1);
    const { createRealDriverSession } = await import(${JSON.stringify(new URL("../packages/computer-session/src/driver-worker.ts", import.meta.url).href)});
    const worker = createRealDriverSession({ sessionId: "fixture", target: { pid: 42, windowId: "7" } });
    assert.equal(creates, 1);
    try {
      const result = await worker.call("step", {
        action: { kind: "type", text: "fixture" }, index: 3, deadlineAt: Date.now() + 1000
      });
      assert.equal(result.status, "completed");
      assert.equal(result.receipt.index, 3);
      assert.equal(result.receipt.status, "delivered");
      assert.deepEqual(inputs, [{ name: "type_text", body: {
        target: { kind: "window", pid: 42, window_id: 7 }, text: "fixture", delivery_mode: "background"
      } }]);
      assert.equal(creates, 2);
    } finally { await worker.close(); }
    assert.equal(ended, 2);
    assert.equal(stopped, 2);
    assert.equal(destroyed, 2);
  `], { stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(probe.stderr)).toBe("");
  expect(probe.exitCode).toBe(0);
});

describe("compiled SDK location", () => {
  test("locates the SDK beside the real executable, not the cwd", async () => {
    const dir = (await Bun.$`mktemp -d /tmp/cu-loc-XXXXXX`.text()).trimEnd();
    const exe = `${dir}/yk`;
    await Bun.write(exe, "#!/bin/sh\nexit 0\n");
    const url = compiledSdkUrl(exe);
    expect(url.startsWith("file://")).toBe(true);
    expect(url).toContain(`${dir}/runtime/computer-use/node_modules/@trycua/cua-driver/dist/index.js`);
    await Bun.$`rm -rf ${dir}`;
  });

  test("uses the symlink-resolved executable location", async () => {
    const dir = (await Bun.$`mktemp -d /tmp/cu-sym-XXXXXX`.text()).trimEnd();
    await Bun.$`mkdir -p ${dir}/bin ${dir}/libexec`;
    const target = `${dir}/libexec/real-yk`;
    await Bun.write(target, "#!/bin/sh\nexit 0\n");
    await Bun.$`chmod +x ${target}`;
    await Bun.$`ln -s ${target} ${dir}/bin/linked-yk`;
    const url = compiledSdkUrl(`${dir}/bin/linked-yk`);
    expect(url).toContain("/libexec/runtime/computer-use/");
    expect(url).not.toContain("/bin/");
    await Bun.$`rm -rf ${dir}`;
  });

  test("rejects an executable path that resolves through a directory", () => {
    expect(() => compiledSdkUrl("/tmp")).toThrow(/executable/i);
  });
});

describe("platform gate", () => {
  test("darwin arm64 is supported", () => {
    expect(isSupportedPlatform({ platform: "darwin", arch: "arm64" })).toBe(true);
  });

  test("linux and x64 macs are rejected with a readable message", () => {
    expect(isSupportedPlatform({ platform: "linux", arch: "arm64" })).toMatch(/macOS arm64/);
    expect(isSupportedPlatform({ platform: "darwin", arch: "x64" })).toMatch(/macOS arm64/);
  });
});

function makeSession(partial: Partial<ComputerSession>, computer: Computer): ComputerSession {
  return {
    computer,
    metadata: async () => ({ driverVersion: "0.27.0", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    close: async () => {},
    ...partial
  };
}

const unexpected = async (): Promise<never> => {
  throw new Error("unexpected computer call");
};
const idleComputer: Computer = {
  apps: unexpected,
  windows: unexpected,
  snapshot: unexpected,
  observe: unexpected,
  clickPoint: unexpected,
  batch: unexpected,
  click: unexpected,
  setValue: unexpected,
  type: unexpected,
  key: unexpected,
  scroll: unexpected,
  waitFor: unexpected
};

describe("doctor report (session-backed)", () => {
  test("ok when platform, sdk, same-process driver, and permissions all pass", async () => {
    const report = await runDoctor({
      platformInfo: { platform: "darwin", arch: "arm64" },
      createSession: () => makeSession({}, idleComputer)
    });
    expect(report.ok).toBe(true);
    expect(report.sdk.version).toBe("0.27.0");
    expect(report.driver.sameProcess).toBe(true);
    expect(report.permissions).toEqual({ accessibility: true, screenRecording: true });
  });

  test("missing permissions keep doctor failing with a grant hint, never a dialog", async () => {
    const report = await runDoctor({
      platformInfo: { platform: "darwin", arch: "arm64" },
      createSession: () =>
        makeSession({ permissions: async () => ({ accessibility: false, screenRecording: true }) }, idleComputer)
    });
    expect(report.ok).toBe(false);
    expect(report.permissions.accessibility).toBe(false);
    expect(report.hints.join(" ")).toMatch(/grant Accessibility AND Screen Recording/i);
  });

  test("a foreign-pid driver is not same-process", async () => {
    const report = await runDoctor({
      platformInfo: { platform: "darwin", arch: "arm64" },
      createSession: () =>
        makeSession({ metadata: async () => ({ driverVersion: "0.27.0", pid: 999999 }) }, idleComputer)
    });
    expect(report.driver.sameProcess).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.hints.join(" ")).toMatch(/same-process assumption broken/);
  });

  test("unsupported platform fails before any session is created", async () => {
    let sessions = 0;
    const report = await runDoctor({
      platformInfo: { platform: "linux", arch: "arm64" },
      createSession: () => {
        sessions++;
        return makeSession({}, idleComputer);
      }
    });
    expect(report.ok).toBe(false);
    expect(sessions).toBe(0);
    expect(report.hints.join(" ")).toMatch(/macOS arm64/);
  });

  test("missing runtime files point to reinstall, not to a dev checkout", async () => {
    const report = await runDoctor({
      platformInfo: { platform: "darwin", arch: "arm64" },
      createSession: () =>
        makeSession(
          {
            metadata: async () => {
              throw new Error("Cannot find module 'file:///nowhere/runtime/computer-use/...'");
            }
          },
          idleComputer
        )
    });
    expect(report.ok).toBe(false);
    expect(report.hints.join(" ")).toMatch(/reinstall ya-skills/);
    expect(report.hints.join(" ")).not.toMatch(/cowork/i);
  });

  test("cleanup failures surface as hints without failing the report", async () => {
    const report = await runDoctor({
      platformInfo: { platform: "darwin", arch: "arm64" },
      createSession: () =>
        makeSession(
          {
            close: async () => {
              throw new ComputerError("cleanup_failed", "endSession timed out after 5000ms");
            }
          },
          idleComputer
        )
    });
    expect(report.ok).toBe(true);
    expect(report.hints.join(" ")).toMatch(/cleanup issues/);
  });
});
