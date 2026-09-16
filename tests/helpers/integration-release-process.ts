import { spawnSync } from "node:child_process";

export interface ExecBodyReadyFrame {
  type: "exec_body_ready";
  childPid: number;
  reportedPid: number;
  ready: true;
}

/** Parse only the body-level readiness frame. The worker's pre-body
 * `exec_started` frame deliberately does not satisfy this proof. */
export function parseExecBodyReadyFrame(line: string): ExecBodyReadyFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  const childPid = frame.childPid;
  const reportedPid = frame.reportedPid;
  if (
    frame.type !== "exec_body_ready" ||
    frame.ready !== true ||
    typeof childPid !== "number" ||
    typeof reportedPid !== "number" ||
    !Number.isSafeInteger(childPid) ||
    !Number.isSafeInteger(reportedPid) ||
    childPid <= 0 ||
    reportedPid <= 0 ||
    childPid !== reportedPid
  ) {
    return null;
  }
  return { type: "exec_body_ready", childPid, reportedPid, ready: true };
}

/** Return the process group id for an owned pid without searching by name. */
export function readProcessGroupId(pid: number): number | null {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const groupId = Number(result.stdout.trim());
  return Number.isSafeInteger(groupId) && groupId > 0 ? groupId : null;
}

/** Check that an owned process is present and not merely a zombie entry. */
export function isRunnableProcess(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const state = result.stdout.trim();
  return state.length > 0 && !state.startsWith("Z");
}
