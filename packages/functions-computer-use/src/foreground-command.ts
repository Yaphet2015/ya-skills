import {
  createForegroundController,
  runWithForeground,
  type ForegroundController
} from "@ya-skills/computer-runtime";
import { readErrorEnvelope, stringifyJson } from "./output.js";

/** Keep restoration diagnostics separate from delivery status, including on errors. */
export async function foregroundCommand(
  request: { kind: "act" | "perceive"; pid: number; activate: boolean; auditForeground: boolean },
  operation: () => Promise<string>,
  mapFailure: (error: unknown) => unknown,
  controller?: ForegroundController,
  settleBeforeRestore?: () => Promise<void>
): Promise<string> {
  if (!request.activate && !request.auditForeground) return operation();
  const result = await runWithForeground(request.pid, request.activate, controller ?? createForegroundController(), operation, settleBeforeRestore);
  if (result.ok === true) {
    return stringifyJson({ ...JSON.parse(result.value), foreground: result.foreground });
  }
  const mapped = mapFailure(result.error);
  const message = mapped instanceof Error ? mapped.message : String(mapped);
  const body = readErrorEnvelope(mapped) ?? {
    code: "foreground_operation_failed",
    message,
    ...(request.kind === "act" ? { actionOutcome: "unknown", nextStep: "observe the target; do NOT repeat the act" } : {})
  };
  throw new Error(stringifyJson({ error: { ...body, foreground: result.foreground } }));
}
