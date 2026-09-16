import { describe, expect, test } from "bun:test";
import {
  compiledSdkUrl,
  isSupportedPlatform,
  runDoctor
} from "@ya-skills/functions-computer-use";
import { ComputerError, type Computer, type ComputerSession } from "@ya-skills/computer-runtime";

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
