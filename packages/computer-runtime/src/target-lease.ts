// Target lease (B3): application-level desktop ownership shared by every
// entry path (single-step CLI, batch, E2E, session hosts). A lease is an
// atomically-created file recording the owner's identity (pid + process
// start time + generation). Dead owners are provably reclaimable; live ones
// are never stolen — not on disconnect, not on timeout. Reclamation is
// mutually exclusive through a transient lock file and NEVER overwrites a
// corrupt or unverifiable lease: uncertain ownership is reported, not
// guessed.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  linkSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Target } from "./types.js";

export interface LeaseOwner {
  /** Random per-run identity. */
  generation: string;
  pid: number;
  /** Process start time (prevents PID-reuse confusion). */
  processStart?: string;
  sessionId?: string;
  /** Pids of detached worker processes this owner spawned (driver worker,
  * exec workers). A dead holder whose workers may still be mutating is NOT
  * reclaimable: the reclaimer refuses instead of starting a second driver. */
  workerPids?: number[];
  kind: "session" | "single-step" | "e2e";
}

export interface LeaseHandle {
  release(): Promise<void>;
  owner(): LeaseOwner;
  /** Atomically rewrite the OWNER'S OWN lease record (e.g. to add/remove
   * live worker pids). Only valid while this handle still owns the lease;
   * a stale rewrite is refused by generation check. */
  refreshOwner(patch: Partial<LeaseOwner>): Promise<void>;
}

function leaseDir(root: string): string {
  return join(root, "leases");
}

function leasePath(root: string, target: Target): string {
  return join(leaseDir(root), `app-${target.pid}.lease`);
}

export class LeaseError extends Error {
  constructor(
    public code: "target_busy" | "owner_identity_unknown" | "reclaim_in_progress",
    message: string,
    public readonly holder?: LeaseOwner
  ) {
    super(`${code}: ${message}`);
  }
}

/** Best-effort process start time; absence is fine (identity then relies on
 * pid + generation which still refuses conservative stealing). */
export function processStartTime(pid: number): string | undefined {
  try {
    const out = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000
    });
    const text = (out.stdout ?? "").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(path: string): LeaseOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseOwner>;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.generation !== "string" || parsed.generation.length === 0 ||
      (parsed.kind !== "session" && parsed.kind !== "single-step" && parsed.kind !== "e2e") ||
      (parsed.processStart !== undefined && typeof parsed.processStart !== "string") ||
      (parsed.sessionId !== undefined && typeof parsed.sessionId !== "string") ||
      (parsed.workerPids !== undefined && (!Array.isArray(parsed.workerPids) || parsed.workerPids.some((pid) => typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)))
    ) return null;
    return parsed as LeaseOwner;
  } catch {
    return null;
  }
}

function ownerIsDead(owner: LeaseOwner): boolean {
  if (processAlive(owner.pid)) return false;
  for (const workerPid of owner.workerPids ?? []) {
    if (processAlive(workerPid)) return false;
  }
  return true;
}

/** Atomically place `owner` at `path` iff nothing exists there yet.
 * Claims use tmp-file + hard-link so a crashed writer can never leave a
 * half-written (corrupt) lease behind. */
function claimPath(path: string, owner: LeaseOwner): boolean {
  const tmp = `${path}.new-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(tmp, JSON.stringify(owner), { mode: 0o600 });
    try {
      linkSync(tmp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone (successful link consumed the name on some platforms)
    }
  }
}

interface ReclaimLock {
  path: string;
  release(): void;
}

/** Mutually-exclusive reclamation: only ONE reclaimer at a time may replace
 * a dead holder's lease. The lock is itself a conservative identity-checked
 * file (a crashed reclaimer's lock is stealable only when its holder is
 * provably dead). */
function acquireReclaimLock(path: string, me: LeaseOwner): ReclaimLock {
  const lockPath = `${path}.reclaim-lock`;
  for (let attempt = 0; ; attempt++) {
    if (claimPath(lockPath, { ...me, generation: `lock-${me.generation}` })) {
      return {
        path: lockPath,
        release() {
          try {
            const current = readOwner(lockPath);
            if (current?.generation === `lock-${me.generation}`) unlinkSync(lockPath);
          } catch {
            // already gone
          }
        }
      };
    }
    const holder = readOwner(lockPath);
    if (holder === null) {
      if (attempt >= 2) {
        throw new LeaseError(
          "owner_identity_unknown",
          `the reclamation lock for this target is unreadable; refusing to guess — remove ${lockPath} manually if it is stale`
        );
      }
      continue;
    }
    if (!ownerIsDead(holder)) {
      throw new LeaseError(
        "reclaim_in_progress",
        `another live process (pid ${holder.pid}) is already reclaiming this lease`
      );
    }
    // A dead lock holder is not enough to justify read-then-unlink
    // reclamation: the owner may have been replaced between the read and the
    // unlink, allowing two reclaimers to enter the lease section. Fail closed
    // until an operator removes the stale lock with an external proof of
    // ownership; never steal a lock based only on a stale read.
    throw new LeaseError(
      "owner_identity_unknown",
      `the reclamation lock owner is no longer live but replacement was not proven atomic; refusing to unlink ${lockPath}`,
      holder
    );
  }
}

export function acquireTargetLease(root: string, target: Target, owner: LeaseOwner): Promise<LeaseHandle> {
  mkdirSync(leaseDir(root), { recursive: true, mode: 0o700 });
  const path = leasePath(root, target);
  // The body runs on the microtask queue so refusals surface as rejections,
  // never as synchronous throws at the call site.
  return Promise.resolve().then(() => {
    if (claimPath(path, owner)) return makeHandle(path, owner);
    for (let attempt = 0; attempt < 3; attempt++) {
      const holder = readOwner(path);
      if (holder === null) {
        // Corrupt/unreadable lease: NEVER overwrite it — ownership is
        // uncertain, so the target stays blocked until a human decides.
        throw new LeaseError(
          "owner_identity_unknown",
          `the lease file for app pid ${target.pid} is unreadable/corrupt; refusing to guess — inspect ${path}`
        );
      }
      if (claimPath(path, owner)) return makeHandle(path, owner);
      const holderAlive = processAlive(holder.pid);
      const holderStart = holder.processStart !== undefined ? processStartTime(holder.pid) : undefined;
      const startMatches =
        holder.processStart === undefined || holderStart === undefined || holderStart === holder.processStart;
      if (holderAlive && startMatches) {
        throw new LeaseError(
          "target_busy",
          `app pid ${target.pid} (window ${target.windowId}) is owned by another live lease (pid ${holder.pid}${holder.sessionId ? `, session ${holder.sessionId}` : ""})`,
          holder
        );
      }
      if (holderAlive && !startMatches) {
        // pid alive but identity changed (reused pid): cannot prove the old
        // owner died — report instead of guessing.
        throw new LeaseError(
          "owner_identity_unknown",
          `lease holder pid ${holder.pid} is alive but its process identity changed; refusing to steal the target`,
          holder
        );
      }
      if (!ownerIsDead(holder)) {
        throw new LeaseError(
          "target_busy",
          `the previous lease holder (pid ${holder.pid}) is gone but its worker process(es) ${JSON.stringify(
            holder.workerPids ?? []
          )} are still alive; refusing to start a second driver against app pid ${target.pid}`,
          holder
        );
      }
      // A live owner may be refreshing its worker identity. Reclamation must
      // not race the refresh rename; a dead/uncertain update lock remains a
      // conservative block until it can be removed safely.
      const updateLockPath = `${path}.update-lock`;
      if (existsSync(updateLockPath)) {
        const updateOwner = readOwner(updateLockPath);
        if (updateOwner === null) {
          throw new LeaseError(
            "owner_identity_unknown",
            `the lease update lock for app pid ${target.pid} is unreadable; refusing to guess — inspect ${updateLockPath}`
          );
        }
        if (!ownerIsDead(updateOwner)) {
          throw new LeaseError(
            "reclaim_in_progress",
            `another process is updating the lease for app pid ${target.pid}`
          );
        }
        try {
          unlinkSync(updateLockPath);
        } catch {
          // another recovery pass removed it; re-evaluate the lease
        }
      }
      // Holder (and its workers) are dead: reclaim under the exclusive lock.
      const lock = acquireReclaimLock(path, owner);
      try {
        const current = readOwner(path);
        if (current === null) {
          throw new LeaseError(
            "owner_identity_unknown",
            `the lease file for app pid ${target.pid} became unreadable/corrupt; refusing to guess — inspect ${path}`
          );
        }
        if (current.generation !== holder.generation || current.pid !== holder.pid) {
          // Someone else won the race while we were locking: re-evaluate.
          continue;
        }
        unlinkSync(path);
        if (claimPath(path, owner)) return makeHandle(path, owner);
        // A fresh acquirer slipped in after the unlink: loop and re-evaluate.
      } finally {
        lock.release();
      }
    }
    throw new LeaseError("target_busy", `could not acquire a lease for app pid ${target.pid} after retries`);
  });

  function makeHandle(path: string, owner: LeaseOwner): LeaseHandle {
    return {
      owner: () => owner,
      async release() {
        if (!existsSync(path)) return;
        const current = readOwner(path);
        if (current === null) {
          throw new LeaseError(
            "owner_identity_unknown",
            "refusing to release an unreadable lease record"
          );
        }
        if (current.generation !== owner.generation) return;
        unlinkSync(path);
        if (existsSync(path)) {
          throw new LeaseError("owner_identity_unknown", "lease removal could not be verified");
        }
      },
      async refreshOwner(patch) {
        const lockPath = `${path}.update-lock`;
        const lockOwner = { ...owner, generation: `update-${owner.generation}` };
        if (!claimPath(lockPath, lockOwner)) {
          throw new LeaseError("reclaim_in_progress", "another process is updating or reclaiming this lease");
        }
        const tmp = `${path}.refresh-${process.pid}-${randomUUID().slice(0, 8)}`;
        try {
          const current = readOwner(path);
          if (!current || current.generation !== owner.generation) {
            throw new LeaseError(
              "owner_identity_unknown",
              "refusing to update a lease this owner no longer holds"
            );
          }
          const next = { ...current, ...patch };
          writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
          renameSync(tmp, path);
        } finally {
          try {
            unlinkSync(tmp);
          } catch {
            // already renamed or absent
          }
          try {
            const currentLock = readOwner(lockPath);
            if (currentLock?.generation === lockOwner.generation) unlinkSync(lockPath);
          } catch {
            // a failed/crashed updater leaves the lock for conservative recovery
          }
        }
      }
    };
  }
}

export function inspectTargetLease(root: string, target: Target): LeaseOwner | null {
  const path = leasePath(root, target);
  if (!existsSync(path)) return null;
  return readOwner(path);
}
