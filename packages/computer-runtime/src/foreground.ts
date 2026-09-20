import { spawnSync } from "node:child_process";
import { ComputerError } from "./driver-result.js";

export interface ForegroundController {
  readPid(): Promise<number | null>;
  activate(pid: number): Promise<void>;
}

export interface ForegroundReceipt {
  requested: boolean;
  beforePid: number | null;
  afterPid: number | null;
  finalPid: number | null;
  activation: "not_requested" | "already_frontmost" | "activated" | "failed";
  restoration: "not_needed" | "restored" | "skipped_user_switch" | "failed";
  issues: string[];
}

export type ForegroundResult<T> =
  | { ok: true; value: T; foreground: ForegroundReceipt }
  | { ok: false; error: unknown; foreground: ForegroundReceipt };

function appleScript(script: string): string {
  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 2_000,
    killSignal: "SIGKILL",
    maxBuffer: 4_096
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "foreground operation failed");
  return result.stdout.trim();
}

/** No script is run until the controller is used. Importing CLI help stays desktop-free. */
export function createForegroundController(): ForegroundController {
  return {
    async readPid() {
      const value = appleScript('tell application "System Events" to get unix id of first application process whose frontmost is true');
      const pid = Number(value);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    },
    async activate(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("foreground pid must be a positive integer");
      appleScript([
        'tell application "System Events"',
        `set frontmost of first application process whose unix id is ${pid} to true`,
        "repeat 10 times",
        `if (unix id of first application process whose frontmost is true) is ${pid} then return`,
        "delay 0.05",
        "end repeat",
        'error "foreground activation was not confirmed"',
        "end tell"
      ].join("\n"));
    }
  };
}

/** Only restore foreground ownership that this operation explicitly acquired. */
export async function runWithForeground<T>(
  targetPid: number,
  activate: boolean,
  controller: ForegroundController,
  operation: () => Promise<T>,
  settleBeforeRestore?: () => Promise<void>
): Promise<ForegroundResult<T>> {
  const foreground: ForegroundReceipt = {
    requested: activate,
    beforePid: null,
    afterPid: null,
    finalPid: null,
    activation: "not_requested",
    restoration: "not_needed",
    issues: []
  };
  const read = async (phase: string): Promise<number | null> => {
    try {
      const pid = await controller.readPid();
      return pid !== null && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch (error) {
      foreground.issues.push(`${phase}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  foreground.beforePid = await read("before");
  let attemptedActivation = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    if (activate) {
      foreground.activation = "failed";
      if (foreground.beforePid === null) {
        throw new ComputerError("foreground_unavailable", "cannot identify the previous foreground app; no input was sent", "not_delivered");
      }
      if (foreground.beforePid === targetPid) {
        foreground.activation = "already_frontmost";
      } else {
        attemptedActivation = true;
        try {
          await controller.activate(targetPid);
          if (await read("activation") !== targetPid) throw new Error("target did not become frontmost");
        } catch (error) {
          throw new ComputerError("foreground_activation_failed", error instanceof Error ? error.message : String(error), "not_delivered");
        }
        foreground.activation = "activated";
      }
    }
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    let settled = true;
    if (attemptedActivation && settleBeforeRestore) {
      try {
        await settleBeforeRestore();
      } catch (error) {
        settled = false;
        foreground.issues.push(`cleanup before restore: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    foreground.afterPid = await read("after");
    foreground.finalPid = foreground.afterPid;
    if (attemptedActivation && foreground.beforePid !== null) {
      if (!settled) {
        foreground.restoration = "failed";
      } else if (foreground.afterPid === null) {
        foreground.restoration = "failed";
        foreground.issues.push("restore: current foreground app is unknown; no activation attempted");
      } else if (foreground.afterPid !== targetPid) {
        // The user may have moved to another app while the operation ran.
        foreground.restoration = "skipped_user_switch";
      } else {
        try {
          await controller.activate(foreground.beforePid);
          foreground.finalPid = await read("restore");
          if (foreground.finalPid !== foreground.beforePid) throw new Error("previous app did not become frontmost");
          foreground.restoration = "restored";
        } catch (error) {
          foreground.restoration = "failed";
          foreground.issues.push(`restore: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return { ...outcome, foreground };
}
