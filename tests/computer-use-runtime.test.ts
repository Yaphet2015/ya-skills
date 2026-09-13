import { describe, expect, test } from "bun:test";
import {
  compiledSdkUrl,
  isSupportedPlatform,
  runDoctor,
  withDriver
} from "@ya-skills/functions-computer-use";

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

describe("driver lifecycle", () => {
  test("always endSession + shutdown + destroys, keeping the primary error", async () => {
    const calls: string[] = [];
    const fakeSdk = {
      CuaDriver: {
        create() {
          return {} as never;
        }
      }
    };
    const fakeDriver = {
      async endSession() {
        calls.push("endSession");
      },
      async shutdown() {
        calls.push("shutdown");
      },
      uniffiDestroy() {
        calls.push("destroy");
      }
    };
    const error = await withDriver(
      {
        // The work callback throws; cleanup must still run in order.
        work: async () => {
          calls.push("work");
          throw new Error("boom");
        },
        load: async () => fakeSdk,
        create: async () => fakeDriver
      }
    ).then(
      () => null,
      (e: Error) => e
    );
    expect(error?.message).toBe("boom");
    expect(calls).toEqual(["work", "endSession", "shutdown", "destroy"]);
  });

  test("cleanup failures do not mask the primary error", async () => {
    const error = await withDriver({
      work: async () => {
        throw new Error("primary");
      },
      load: async () => ({ CuaDriver: { create: () => ({}) as never } }),
      create: async () => ({
        async endSession() {
          throw new Error("cleanup-1");
        },
        async shutdown() {
          throw new Error("cleanup-2");
        },
        uniffiDestroy() {}
      })
    }).then(
      () => null,
      (e: Error) => e
    );
    expect(error?.message).toBe("primary");
  });

  test("a hanging call is abandoned after the deadline and reported as timeout, never retried", async () => {
    let workStarted = 0;
    const error = await withDriver({
      work: () =>
        new Promise((_resolve, reject) => {
          workStarted++;
          // Never resolves; only the deadline ends it.
          void reject;
        }),
      load: async () => ({ CuaDriver: { create: () => ({}) as never } }),
      create: async () => ({
        async endSession() {},
        async shutdown() {},
        uniffiDestroy() {}
      }),
      deadlineMs: 20
    }).then(
      () => null,
      (e: Error) => e
    );
    expect(workStarted).toBe(1);
    expect(error?.message).toMatch(/timed out|deadline/i);
  });

  test("a hanging cleanup is abandoned after its own shorter deadline", async () => {
    const started = Date.now();
    const error = await withDriver({
      work: async () => "ok",
      load: async () => ({ CuaDriver: { create: () => ({}) as never } }),
      create: async () => ({
        async endSession() {
          return new Promise(() => {});
        },
        async shutdown() {},
        uniffiDestroy() {}
      }),
      deadlineMs: 1000,
      cleanupDeadlineMs: 15
    }).then(
      () => null,
      (e: Error) => e
    );
    expect(error).toBeNull();
    expect(Date.now() - started).toBeLessThan(900);
  });
});

describe("doctor report", () => {
  const fakeLoad = async () => ({
    CuaDriver: { create: () => ({}) as never },
    currentMacOsPermissionStatus: () => ({ accessibility: true, screenRecording: true })
  });

  test("ok when platform, sdk, same-process driver, and permissions all pass", async () => {
    const report = await runDoctor({
      platformInfo: { platform: "darwin", arch: "arm64" },
      load: fakeLoad,
      create: async () => ({
        async metadata() {
          return { driverVersion: "0.27.0", pid: process.pid };
        },
        async endSession() {},
        async shutdown() {},
        uniffiDestroy() {}
      })
    });
    expect(report.ok).toBe(true);
    expect(report.sdk.version).toBe("0.27.0");
    expect(report.driver.sameProcess).toBe(true);
    expect(report.permissions).toEqual({ accessibility: true, screenRecording: true });
  });

  test("missing permissions keep doctor failing with a grant hint, never a dialog", async () => {
    const report = await runDoctor({
      platformInfo: { platform: "darwin", arch: "arm64" },
      load: async () => ({
        CuaDriver: { create: () => ({}) as never },
        currentMacOsPermissionStatus: () => ({ accessibility: false, screenRecording: true })
      }),
      create: async () => ({
        async metadata() {
          return { driverVersion: "0.27.0", pid: process.pid };
        },
        async endSession() {},
        async shutdown() {},
        uniffiDestroy() {}
      })
    });
    expect(report.ok).toBe(false);
    expect(report.permissions.accessibility).toBe(false);
    expect(report.hints.join(" ")).toMatch(/grant Accessibility AND Screen Recording/i);
  });

  test("unsupported platform fails before any sdk load", async () => {
    let loads = 0;
    const report = await runDoctor({
      platformInfo: { platform: "linux", arch: "arm64" },
      load: async () => {
        loads++;
        return fakeLoad();
      }
    });
    expect(report.ok).toBe(false);
    expect(loads).toBe(0);
    expect(report.hints.join(" ")).toMatch(/macOS arm64/);
  });

  test("missing runtime files point to reinstall, not to a dev checkout", async () => {
    const report = await runDoctor({
      platformInfo: { platform: "darwin", arch: "arm64" },
      load: async () => {
        throw new Error("Cannot find module 'file:///nowhere/runtime/computer-use/...'");
      },
      execPath: "/opt/homebrew/Cellar/ya-skills/0.18.0/bin/yk"
    });
    expect(report.ok).toBe(false);
    expect(report.hints.join(" ")).toMatch(/reinstall ya-skills/);
    expect(report.hints.join(" ")).not.toMatch(/cowork/);
  });
});
