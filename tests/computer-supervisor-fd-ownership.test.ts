import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { supervise } from "../packages/functions-computer-e2e/src/supervisor.js";
import { createIntegrationBurstFixture } from "./helpers/integration-e2e-burst.js";

test("supervisor leaves reused stdio descriptors owned by other files open", async () => {
  const fixture = createIntegrationBurstFixture({ cleanupSteps: 1, namePadding: 0 });
  const open = fs.openSync;
  const close = fs.closeSync;
  const workerFds = new Set<number>();
  const replacements = new Map<number, string>();
  const reused: number[] = [];
  const openSpy = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    const fd = open(path, flags, mode);
    if ((flags === "a" || flags === "a+") && /worker-0\.(stdout\.log|stderr\.log|events)$/.test(String(path))) workerFds.add(fd);
    return fd;
  });
  const closeSpy = spyOn(fs, "closeSync").mockImplementation((fd) => {
    close(fd);
    if (workerFds.delete(fd)) {
      const path = join(fixture.root, `unrelated-${fd}`);
      const replacement = open(path, "w+");
      replacements.set(replacement, path);
      if (replacement === fd) reused.push(fd);
    }
  });
  try {
    const result = await supervise({
      files: [fixture.suiteFile], params: {}, outDir: fixture.outDir,
      timeoutMs: 10_000, supervisorLockPath: join(fixture.root, "supervisor.lock")
    });
    expect(result.status).toBe("passed");
    expect(reused.length).toBe(3);
    for (const fd of reused) {
      expect(() => fs.writeSync(fd, "still owned")).not.toThrow();
      expect(fs.readFileSync(replacements.get(fd)!, "utf8")).toBe("still owned");
    }
  } finally {
    openSpy.mockRestore();
    closeSpy.mockRestore();
    for (const fd of replacements.keys()) {
      try { close(fd); } catch { /* The regression closes these descriptors. */ }
    }
    fixture.cleanup();
  }
}, 20_000);
