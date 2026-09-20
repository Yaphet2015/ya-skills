import { randomUUID } from "node:crypto";
import type { Target } from "./types.js";
import { acquireTargetLease, type LeaseHandle, type LeaseOwner } from "./target-lease.js";

/** Mutation leases (B3): every mutation entry path (single-step CLI, batch
 * CLI, E2E) acquires the shared app-level target lease at the FIRST mutation
 * and releases it when the enclosing computer session closes. Session hosts
 * instead hold one lease for their configured target from open to close and
 * pass external ownership — the hosted driver session sets NO leases so it
 * never double-acquires its own host's lease. */
export interface MutationLeases {
  acquire(target: Target): Promise<LeaseHandle>;
}

/** Default auto-leases for non-session entry paths: one generation per
 * computer session, leases keyed by app pid, released together on close. */
export function createAutoLeases(
  root: string,
  kind: LeaseOwner["kind"]
): MutationLeases & { releaseAll(): Promise<void> } {
  const generation = randomUUID();
  const handles = new Map<number, LeaseHandle>();
  return {
    async acquire(target) {
      const existing = handles.get(target.pid);
      if (existing) return existing;
      const acquired = await acquireTargetLease(root, target, {
        generation,
        pid: process.pid,
        // The process-start probe is synchronous and can delay a desktop
        // worker cold start under Bun 1.3. PID reuse remains conservative
        // (a live PID blocks reclamation); persistent hosts include the
        // stronger start identity because they already have boot time.
        kind
      });
      // SessionImpl releases its handle during close. Remove the cached
      // handle then, otherwise a later one-shot session in this same process
      // would reuse a lease file that has already been deleted.
      const handle: LeaseHandle = {
        owner: acquired.owner,
        refreshOwner: acquired.refreshOwner,
        async release() {
          try {
            await acquired.release();
          } finally {
            if (handles.get(target.pid) === handle) handles.delete(target.pid);
          }
        }
      };
      handles.set(target.pid, handle);
      return handle;
    },
    async releaseAll() {
      const pending = [...handles.values()];
      handles.clear();
      const errors: unknown[] = [];
      for (const handle of pending) {
        try {
          await handle.release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    }
  };
}

