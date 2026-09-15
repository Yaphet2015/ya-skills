import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireTargetLease,
  inspectTargetLease,
  LeaseError,
  processStartTime
} from "../packages/computer-runtime/src/target-lease.js";

const target = { pid: 999_999, windowId: 5n };

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cu-lease-"));
}

function owner(overrides: Partial<Parameters<typeof acquireTargetLease>[2]> = {}) {
  return {
    generation: randomUUID(),
    pid: process.pid,
    processStart: processStartTime(process.pid),
    kind: "session" as const,
    ...overrides
  };
}

describe("target lease (B3)", () => {
  test("a live owner blocks a second acquirer (same-process simulates app-level lock)", async () => {
    const root = await makeRoot();
    try {
      const first = await acquireTargetLease(root, target, owner({ sessionId: "s1" }));
      await expect(acquireTargetLease(root, target, owner({ sessionId: "s2" }))).rejects.toThrow(
        /target_busy/
      );
      expect(inspectTargetLease(root, target)?.sessionId).toBe("s1");
      await first.release();
      // after release the lease is free again
      const second = await acquireTargetLease(root, target, owner({ sessionId: "s2" }));
      await second.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("session and one-shot lease users share the same app-level ownership", async () => {
    const root = await makeRoot();
    try {
      const sessionOwner = await acquireTargetLease(root, target, owner({ sessionId: "persistent" }));
      const { createAutoLeases } = await import("../packages/computer-runtime/src/session.js");
      const oneShot = createAutoLeases(root, "single-step");
      await expect(oneShot.acquire(target)).rejects.toThrow(/target_busy/);
      await sessionOwner.release();
      const handle = await oneShot.acquire(target);
      await handle.release();
      // A later one-shot session in this process must reacquire, not reuse a
      // cached handle whose lease file was deleted by the prior close.
      const second = await oneShot.acquire(target);
      await second.release();
      await oneShot.releaseAll();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a semantically corrupt lease is blocked instead of overwritten", async () => {
    const root = await makeRoot();
    const { mkdir, writeFile } = await import("node:fs/promises");
    try {
      await mkdir(join(root, "leases"), { recursive: true });
      await writeFile(join(root, "leases", `app-${target.pid}.lease`), JSON.stringify({ pid: 4_000_000 }));
      const error = await acquireTargetLease(root, target, owner()).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(LeaseError);
      expect((error as LeaseError).code).toBe("owner_identity_unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a dead owner's lease is reclaimed", async () => {
    const root = await makeRoot();
    try {
      // pid 4000000 is beyond macOS pid limits and provably dead
      const dead = await acquireTargetLease(root, { pid: 4_000_000, windowId: 1n }, owner({ pid: 4_000_000 }));
      void dead;
      const reclaimed = await acquireTargetLease(
        root,
        { pid: 4_000_000, windowId: 1n },
        owner({ sessionId: "new" })
      );
      expect(reclaimed.owner().sessionId).toBe("new");
      await reclaimed.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an alive-but-identity-changed holder reports owner_identity_unknown instead of stealing", async () => {
    const root = await makeRoot();
    try {
      // Own pid but a mismatched recorded start time: alive + identity drift.
      await acquireTargetLease(root, { pid: 500_000, windowId: 1n }, owner({ pid: process.pid, processStart: "Mon Jan  1 00:00:00 2001", pid2: undefined } as never));
      const error = await acquireTargetLease(root, { pid: 500_000, windowId: 1n }, owner()).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(LeaseError);
      expect((error as LeaseError).code).toBe("owner_identity_unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("releasing someone else's lease is a no-op", async () => {
    const root = await makeRoot();
    try {
      const first = await acquireTargetLease(root, target, owner({ sessionId: "s1" }));
      const second = await acquireTargetLease(root, { pid: 4_000_000, windowId: 1n }, owner({ sessionId: "dead" }));
      // second holds a different lease; releasing it must not touch first's
      await second.release();
      expect(inspectTargetLease(root, target)?.sessionId).toBe("s1");
      await first.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("two real processes cannot both hold the app lease", async () => {
    const root = await makeRoot();
    const script = join(root, "holder.ts");
    const { writeFile } = await import("node:fs/promises");
    const leaseModule = join(
      import.meta.dir,
      "..",
      "packages",
      "computer-runtime",
      "src",
      "target-lease.ts"
    );
    await writeFile(
      script,
      [
        "import { acquireTargetLease } from " + JSON.stringify(leaseModule) + ";",
        "const handle = await acquireTargetLease(" + JSON.stringify(root) + ", { pid: 777_777, windowId: 1n }, { generation: 'g1', pid: process.pid, kind: 'session' });",
        "console.log('HELD');",
        "await new Promise(() => undefined);"
      ].join("\n")
    );
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    try {
      for (let i = 0; i < 50 && !out.includes("HELD"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(out).toContain("HELD");
      const error = await acquireTargetLease(root, { pid: 777_777, windowId: 1n }, owner()).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(LeaseError);
      expect((error as LeaseError).code).toBe("target_busy");
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("exit", resolve));
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
