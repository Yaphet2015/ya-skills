import { describe, expect, test } from "bun:test";
import { closeSync, fstatSync, openSync, renameSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSpoolReader, createWorkerWatchdog } from "../packages/computer-session/src/worker-lifecycle.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("shared worker lifecycle", () => {
  test("drains split UTF-8 and appended frames through the shared spool", () => {
    const root = tempRoot("yk-worker-spool-");
    const path = join(root, "events.spool");
    writeFileSync(path, "é\n", { mode: 0o600 });
    const reader = new FileSpoolReader(path, 1);
    try {
      expect(reader.poll().lines).toEqual([]);
      expect(reader.poll().lines).toEqual([]);
      expect(reader.poll().lines).toEqual(["é"]);
      writeFileSync(path, "ok\n", { encoding: "utf8", flag: "a" });
      const lines: string[] = [];
      reader.drainToEofSync((drained) => lines.push(...drained));
      expect(lines).toEqual(["ok"]);
      expect(reader.finalize()).toEqual({ complete: true, pendingBytes: 0 });
    } finally {
      reader.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the spool is truncated or rotated", () => {
    const root = tempRoot("yk-worker-spool-boundary-");
    const path = join(root, "events.spool");
    writeFileSync(path, "partial", { mode: 0o600 });
    const reader = new FileSpoolReader(path);
    try {
      reader.poll();
      expect(reader.finalize()).toEqual({ complete: false, pendingBytes: 7 });
      writeFileSync(path, "", { encoding: "utf8" });
      expect(() => reader.poll()).toThrow(/truncated/);
    } finally {
      reader.close();
    }

    writeFileSync(path, "old\n", { mode: 0o600 });
    const rotated = new FileSpoolReader(path);
    try {
      expect(rotated.poll().lines).toEqual(["old"]);
      const replacement = join(root, "events.spool.next");
      writeFileSync(replacement, "new\n", { mode: 0o600 });
      renameSync(replacement, path);
      expect(() => rotated.poll()).toThrow(/rotated/);
    } finally {
      rotated.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not close a borrowed fd when truncation or rotation is detected", () => {
    for (const discontinuity of ["truncation", "rotation"] as const) {
      const root = tempRoot(`yk-worker-spool-borrowed-${discontinuity}-`);
      const path = join(root, "events.spool");
      writeFileSync(path, "partial", { mode: 0o600 });
      const borrowedFd = openSync(path, "r");
      const reader = new FileSpoolReader(path, 64 * 1024, borrowedFd);
      try {
        reader.poll();
        if (discontinuity === "truncation") {
          writeFileSync(path, "", { encoding: "utf8" });
        } else {
          const replacement = join(root, "events.spool.next");
          writeFileSync(replacement, "new\n", { mode: 0o600 });
          renameSync(replacement, path);
        }
        expect(() => reader.poll()).toThrow(discontinuity === "truncation" ? /truncated/ : /rotated/);
        expect(() => fstatSync(borrowedFd)).not.toThrow();
        reader.close();
        expect(() => fstatSync(borrowedFd)).not.toThrow();
      } finally {
        reader.close();
        try { closeSync(borrowedFd); } catch { /* the assertion reports an unexpected close */ }
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("watchdog re-arms and clear prevents stale cleanup", async () => {
    let fired = 0;
    const watchdog = createWorkerWatchdog(() => { fired += 1; });
    watchdog.arm(25);
    watchdog.arm(60);
    await new Promise((resolve) => setTimeout(resolve, 10));
    watchdog.clear();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(fired).toBe(0);
    watchdog.arm(10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    watchdog.clear();
    expect(fired).toBe(1);
  });
});
