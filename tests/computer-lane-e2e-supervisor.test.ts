import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_SUPERVISOR_LOCK_TIMEOUT_MS,
  IncrementalE2ESpoolReader,
  SupervisorLockError,
  supervise
} from "../packages/functions-computer-e2e/src/supervisor.js";
import { MAX_MESSAGE_BYTES } from "../packages/computer-session/src/protocol.js";

const PASSING_SUITE = resolve("tests/fixtures/computer-e2e/pure.e2e.ts");

function privateRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function expectUncertainOwner(ownerContents: string | undefined): Promise<void> {
  const root = privateRoot("yk-e2e-lane-lock-");
  const lockPath = join(root, "supervisor.lock");
  const outDir = join(root, "runs");
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  if (ownerContents !== undefined) writeFileSync(join(lockPath, "owner.json"), ownerContents, { mode: 0o600 });
  try {
    const startedAt = Date.now();
    const error = await supervise({
      files: [PASSING_SUITE],
      params: {},
      outDir,
      timeoutMs: 5_000,
      supervisorLockPath: lockPath,
      supervisorLockTimeoutMs: 40
    }).then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(SupervisorLockError);
    expect((error as SupervisorLockError).code).toBe("owner_identity_unknown");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // Missing/corrupt ownership is uncertainty, not permission to delete or
    // replace another lane's lock.
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(outDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("computer-e2e lane supervisor ownership", () => {
  test("missing owner is bounded and reported as uncertain", async () => {
    await expectUncertainOwner(undefined);
  });

  test("corrupt owner is bounded and reported as uncertain", async () => {
    await expectUncertainOwner("{not-json");
  });

  test("a structurally invalid owner is also uncertain, not reclaimable", async () => {
    await expectUncertainOwner(JSON.stringify({ pid: "not-a-pid", token: "broken" }));
  });

  test("abort stops lock acquisition without deleting a live owner's lock", async () => {
    const root = privateRoot("yk-e2e-lane-lock-abort-");
    const lockPath = join(root, "supervisor.lock");
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "owned-by-another-lane" }),
      { mode: 0o600 }
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25);
    try {
      const error = await supervise({
        files: [PASSING_SUITE],
        params: {},
        outDir: join(root, "runs"),
        timeoutMs: 5_000,
        stopSignal: controller.signal,
        supervisorLockPath: lockPath,
        supervisorLockTimeoutMs: DEFAULT_SUPERVISOR_LOCK_TIMEOUT_MS
      }).then(() => null, (value: unknown) => value);
      expect(error).toBeInstanceOf(SupervisorLockError);
      expect((error as SupervisorLockError).code).toBe("supervisor_lock_aborted");
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(join(lockPath, "owner.json"))).toBe(true);
    } finally {
      clearTimeout(timer);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computer-e2e lane incremental fd3 spool", () => {
  test("reads only the appended bounded chunk and preserves split UTF-8 frames", () => {
    const root = privateRoot("yk-e2e-lane-spool-");
    const path = join(root, "events.spool");
    writeFileSync(path, "");
    const reader = new IncrementalE2ESpoolReader(path, 1);
    try {
      writeFileSync(path, "é\n", { encoding: "utf8", flag: "a" });
      const first = reader.poll();
      expect(first.bytesRead).toBe(1);
      expect(first.bytesRead).toBeLessThanOrEqual(1);
      expect(first.lines).toEqual([]);
      const second = reader.poll();
      expect(second.bytesRead).toBe(1);
      const third = reader.poll();
      expect(third.bytesRead).toBe(1);
      expect(third.lines).toEqual(["é"]);
      expect(reader.finalize()).toEqual({ complete: true, pendingBytes: 0 });

      writeFileSync(path, "ok\n", { encoding: "utf8", flag: "a" });
      const appended = reader.poll();
      expect(appended.bytesRead).toBe(1);
      expect(appended.bytesRead).toBeLessThanOrEqual(1);
    } finally {
      reader.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails explicitly for a partial tail, truncation, and rotation", () => {
    const root = privateRoot("yk-e2e-lane-spool-boundary-");
    const path = join(root, "events.spool");
    writeFileSync(path, "partial", { encoding: "utf8" });
    const reader = new IncrementalE2ESpoolReader(path, 64);
    try {
      reader.poll();
      expect(reader.finalize()).toEqual({ complete: false, pendingBytes: 7 });
      writeFileSync(path, "", { encoding: "utf8" });
      expect(() => reader.poll()).toThrow(/truncated/);
    } finally {
      reader.close();
    }

    writeFileSync(path, "old\n", { encoding: "utf8" });
    const rotatedReader = new IncrementalE2ESpoolReader(path, 64);
    try {
      rotatedReader.poll();
      const replacement = join(root, "events.spool.next");
      writeFileSync(replacement, "new\n", { encoding: "utf8" });
      renameSync(replacement, path);
      expect(() => rotatedReader.poll()).toThrow(/rotated/);
    } finally {
      rotatedReader.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("enforces the per-frame byte limit and malformed UTF-8 boundary", () => {
    const root = privateRoot("yk-e2e-lane-spool-invalid-");
    const path = join(root, "events.spool");
    writeFileSync(path, Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61));
    const reader = new IncrementalE2ESpoolReader(path, MAX_MESSAGE_BYTES);
    try {
      expect(() => reader.poll()).not.toThrow();
      expect(() => reader.poll()).toThrow(/protocol_message_too_large/);
    } finally {
      reader.close();
    }

    writeFileSync(path, Buffer.from([0xc3, 0x0a]));
    const utf8Reader = new IncrementalE2ESpoolReader(path, 2);
    try {
      expect(() => utf8Reader.poll()).toThrow(/protocol_utf8/);
    } finally {
      utf8Reader.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
