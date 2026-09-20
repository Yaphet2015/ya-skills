// Commands own validation, orchestration, and result envelopes. All desktop
// work goes through the shared session from @ya-skills/computer-runtime —
// there is no second driver implementation in this package.

import type { FunctionCommand } from "@ya-skills/core";
import {
  ComputerError,
  ensureOutDir,
  saveScreenshot,
  selectWindow,
  type AxElement,
  type Computer,
  type ForegroundController,
  type Observation,
  type Snapshot,
  type Target
} from "@ya-skills/computer-runtime";
import { parseRequest, type ClickSpec, type ParsedRequest } from "./args.js";
import { COMMAND_DEADLINE_MS } from "./consts.js";
import { runDoctor } from "./runtime.js";
import { observeCommand } from "./observe-command.js";
import { applyBatchOverrides, batchCommand, readBatchFile } from "./batch-command.js";
import { parseSessionArgs, runOnSession, sessionCommand, SESSION_USAGE_LINES, type SessionTransportDeps } from "./session-command.js";
import { execCommand } from "./exec-command.js";
import { foregroundCommand } from "./foreground-command.js";
import { createDefaultSessionFactory, type CreateSession } from "./session-factory.js";
import { jsonError, readErrorEnvelope, stringifyJson } from "./output.js";

export type { ComputerSession } from "@ya-skills/computer-runtime";

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function clickPredicate(click: ClickSpec): (e: AxElement) => boolean {
  const wanted = normalizeText(click.text);
  return (e) => {
    if (click.role !== undefined && e.role !== click.role) return false;
    const label = e.label == null ? null : normalizeText(e.label);
    const value = e.value == null || e.value === "" ? null : normalizeText(e.value);
    if (click.kind === "text") return label === wanted || value === wanted;
    return (
      (label !== null && label.includes(wanted)) || (value !== null && value.includes(wanted))
    );
  };
}

function encodePerception(target: Target, snapshot: Snapshot, outDir?: string): string {
  return stringifyJson(
    {
      ...target,
      title: snapshot.title,
      elements: snapshot.elements,
      ...(snapshot.imageBase64
        ? { screenshot: saveScreenshot(ensureOutDir(outDir), snapshot.imageBase64) }
        : {})
    }
  );
}

function encodeObservation(target: Target, observation: Observation): string {
  return stringifyJson({ schemaVersion: 1, target, observation });
}

function actSpecToSingleAction(request: ParsedRequest & { kind: "act" }): {
  kind: "click" | "click_point" | "set_value" | "type" | "key" | "scroll";
  [key: string]: unknown;
} {
  switch (request.action) {
    case "click":
      return {
        kind: "click",
        selector: {
          text: request.click.text,
          match: request.click.kind === "text" ? "exact" : "contains",
          ...(request.click.role !== undefined ? { role: request.click.role } : {})
        }
      };
    case "click_point":
      return { kind: "click_point", point: request.clickPoint };
    case "set_value":
      return { kind: "set_value", elementToken: request.elementToken, value: request.value };
    case "type":
      return { kind: "type", text: request.type };
    case "key":
      return {
        kind: "key",
        key: request.key,
        ...(request.modifiers !== undefined ? { modifiers: request.modifiers } : {})
      };
    case "scroll":
      return { kind: "scroll", spec: request.scroll };
  }
}

type ActRequest = Extract<ParsedRequest, { kind: "act" }>;

async function dispatchAct(computer: Computer, target: Target, request: ActRequest): Promise<void> {
  switch (request.action) {
    case "click":
      return computer.click(
        target,
        clickPredicate(request.click),
        `click ${request.click.role ?? ""} "${request.click.text}"`
      );
    case "click_point":
      return computer.clickPoint(target, request.clickPoint);
    case "set_value":
      await computer.setValue(target, request.elementToken, request.value);
      return;
    case "type":
      return computer.type(target, request.type);
    case "key":
      return computer.key(target, request.key, request.modifiers);
    case "scroll":
      return computer.scroll(target, request.scroll);
  }
}

function postActionObserveError(error: unknown): Error {
  return jsonError("post_action_observe_failed", error instanceof Error ? error.message : String(error), {
    actionDelivered: true,
    actionOutcome: "delivered",
    nextStep: "run perceive; do NOT repeat the act"
  });
}

const PRE_DISPATCH_ERROR_CODES = new Set([
  "action_refused",
  "ax_only_unsupported",
  "degraded_snapshot",
  "invalid_point",
  "invalid_request",
  "observation_required",
  "observation_store_failed",
  "px_capture_unavailable",
  "session_busy",
  "session_closed",
  "stale_element_token",
  "stale_observation",
  "unknown_observation",
  "window_target_not_found"
]);

function safeActionOutcome(request: ParsedRequest, error: ComputerError): "delivered" | "not_delivered" | "unknown" | undefined {
  if (error.actionOutcome !== undefined) return error.actionOutcome;
  if (request.kind !== "act") return undefined;
  // Runtime read/validation/refusal errors happen before the native input
  // seam. They are safe to retry only after correcting the request or target;
  // never mislabel them as an unknown delivery.
  if (PRE_DISPATCH_ERROR_CODES.has(error.code)) return "not_delivered";
  return "unknown";
}

function nextStepForActionOutcome(outcome: "delivered" | "not_delivered" | "unknown" | undefined): string | undefined {
  if (outcome === "unknown") return "run perceive to observe the current state; do NOT repeat the act";
  if (outcome === "not_delivered") return "observe the target, correct the request or refusal, then decide whether to retry";
  if (outcome === "delivered") return "run perceive to verify the result; do NOT repeat the act blindly";
  return undefined;
}

function formatSessionActObservation(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw jsonError("post_action_observe_failed", "the session returned a malformed act result", {
      actionDelivered: false,
      actionOutcome: "unknown",
      nextStep: "run perceive to observe the current state; do NOT repeat the act"
    });
  }
  const root = typeof parsed === "object" && parsed !== null ? parsed as { result?: unknown } : undefined;
  const result = root?.result !== undefined && typeof root.result === "object" && root.result !== null
    ? root.result as {
        observation?: Observation;
        observationError?: { code?: unknown; message?: unknown };
        steps?: Array<{
          status?: unknown;
          error?: { code?: unknown; message?: unknown };
        }>;
      }
    : undefined;
  const step = result?.steps?.[0];
  const stepStatus = step?.status;
  let actionOutcome: "delivered" | "not_delivered" | "unknown";
  if (stepStatus === "delivered" || stepStatus === "satisfied") {
    actionOutcome = "delivered";
  } else if (stepStatus === "not_delivered" || stepStatus === "not_run") {
    actionOutcome = "not_delivered";
  } else {
    actionOutcome = "unknown";
  }
  const stepError = step?.error;
  if (
    actionOutcome !== "delivered" &&
    typeof stepError?.code === "string" &&
    typeof stepError.message === "string"
  ) {
    throw jsonError(stepError.code, stepError.message, {
      actionOutcome,
      nextStep: nextStepForActionOutcome(actionOutcome) ?? "run perceive; do NOT repeat the act"
    });
  }
  if (result?.observation !== undefined && actionOutcome === "delivered") {
    return encodeObservation(result.observation.target, result.observation);
  }
  const observationError = result?.observationError;
  const message = typeof observationError?.message === "string"
    ? observationError.message
    : "the action completed but the post-action observation was unavailable";
  throw jsonError("post_action_observe_failed", message, {
    actionDelivered: actionOutcome === "delivered",
    actionOutcome,
    ...(typeof observationError?.code === "string" ? { causeCode: observationError.code } : {}),
    nextStep: nextStepForActionOutcome(actionOutcome) ?? "run perceive; do NOT repeat the act"
  });
}

type SessionRequest = Extract<ParsedRequest, { kind: "observe" | "batch" | "act" }>;

async function runSessionRequest(request: SessionRequest, transport: SessionTransportDeps): Promise<string> {
  switch (request.kind) {
    case "observe":
      return runOnSession(request.session!, {
        kind: "observe",
        options: {
          mode: request.mode,
          ...(request.maxDimension !== undefined ? { maxDimension: request.maxDimension } : {}),
          ...(request.selector !== undefined ? { selector: request.selector } : {})
        }
      }, 30_000, transport);
    case "batch": {
      const parsed = applyBatchOverrides(
        await readBatchFile(request.file, { structuredErrors: false }),
        request,
        "session budget overrides",
        true
      );
      return runOnSession(
        request.session!,
        { kind: "batch", request: parsed, file: request.file, requestId: request.requestId },
        Math.min(150_000, (request.timeoutMs ?? 120_000) + 30_000),
        transport
      );
    }
    case "act": {
      const sessionOutput = await runOnSession(
        request.session!,
        {
          kind: "batch",
          request: {
            actions: [actSpecToSingleAction(request)],
            ...(request.format === "observation" ? { observe: { mode: request.shot ? "both" : "auto" } } : {})
          },
          requestId: `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        },
        30_000,
        transport
      );
      return request.format === "observation" ? formatSessionActObservation(sessionOutput) : sessionOutput;
    }
  }
}

// Map shared-layer errors onto the CLI's JSON error contract.
function mapError(request: ParsedRequest, error: unknown): unknown {
  // Preserve errors that already carry a public structured envelope. This is
  // required for post-action observation and foreground cleanup receipts.
  if (readErrorEnvelope(error) !== undefined) return error;
  if (error instanceof ComputerError) {
    const actionOutcome = safeActionOutcome(request, error);
    const nextStep = nextStepForActionOutcome(actionOutcome);
    const extra: Record<string, unknown> = {
      ...(actionOutcome !== undefined ? { actionOutcome } : {}),
      ...(nextStep !== undefined ? { nextStep } : {})
    };
    // set_value has a stricter no-replay instruction when the AX proof is
    // missing. Keep that established contract while adding the actual code
    // and outcome fields to every runtime ComputerError.
    if (error.code === "ax_only_unverified") {
      extra.actionOutcome = actionOutcome ?? "unknown";
      extra.nextStep = "observe the target before any further action; do NOT repeat the set-value request";
    }
    return jsonError(error.code, error.message, extra);
  }
  if (request.kind === "act" && error instanceof Error && /timed out/.test(error.message)) {
    return jsonError("command_timeout", "the action command timed out; delivery could not be confirmed", {
      actionOutcome: "unknown",
      nextStep: "run perceive to observe the current state; do NOT repeat the act"
    });
  }
  return error;
}

async function runReal(
  request: ParsedRequest,
  createSession: CreateSession,
  sessionTransport: SessionTransportDeps = {},
  foregroundController?: ForegroundController
): Promise<string> {
  if (request.kind === "session") {
    const run = sessionCommand(sessionTransport);
    return run(parseSessionArgs(request.argv));
  }
  if (request.kind === "exec") {
    return execCommand()(request);
  }
  if (
    (request.kind === "observe" || request.kind === "batch" || request.kind === "act") &&
    request.session !== undefined
  ) {
    return runSessionRequest(request, sessionTransport);
  }
  const platform = process.platform === "darwin" && process.arch === "arm64";
  if (!platform) {
    throw jsonError(
      "unsupported_platform",
      `computer-use requires macOS arm64 (this machine: ${process.platform} ${process.arch})`
    );
  }
  if (request.kind === "observe") {
    return observeCommand({ createSession })(request);
  }
  if (request.kind === "batch") {
    return batchCommand({ createSession })(request);
  }

  const session = createSession({
    deadlineAt: Date.now() + COMMAND_DEADLINE_MS,
    ...("outDir" in request && request.outDir !== undefined ? { artifactsDir: request.outDir } : {})
  });
  let closePromise: Promise<void> | undefined;
  function closeSession(): Promise<void> {
    return closePromise ??= session.close();
  }
  try {
    switch (request.kind) {
      case "apps": {
        let apps = await session.computer.apps();
        if (request.name) {
          const n = request.name.toLowerCase();
          apps = apps.filter((a) => String(a.name ?? "").toLowerCase().includes(n));
        }
        return stringifyJson({ apps });
      }
      case "windows": {
        const wins = await session.computer.windows(request.pid);
        return stringifyJson({ windows: wins.map((w) => ({ windowId: w.windowId, title: w.title })) });
      }
      case "perceive":
      case "act": {
        const win = selectWindow(await session.computer.windows(request.pid), request.windowId);
        const target: Target = { pid: request.pid, windowId: win.windowId };
        return await foregroundCommand(request, async () => {
          if (request.kind === "perceive") {
            const snap = await session.computer.snapshot(target, { screenshot: request.shot });
            return encodePerception(target, snap, request.outDir);
          }
          await dispatchAct(session.computer, target, request);

          try {
            if (request.format === "observation") {
              const observation = await session.computer.observe(target, {
                mode: request.shot ? "both" : "auto"
              });
              return encodeObservation(target, observation);
            }
            const snap = await session.computer.snapshot(target, { screenshot: request.shot });
            return encodePerception(target, snap, request.outDir);
          } catch (error) {
            throw postActionObserveError(error);
          }
        }, (error) => mapError(request, error), foregroundController, closeSession);
      }
      default:
        throw jsonError("internal", "unhandled request kind");
    }
  } finally {
    // Single-step CLI contract: cleanup warnings never mask the primary
    // error nor rewrite a successful result.
    try {
      await closeSession();
    } catch (error) {
      console.error("driver cleanup issue:", error instanceof Error ? error.message : error);
    }
  }
}

export function createComputerUseCommands(
  deps: {
    runReal?: (request: ParsedRequest, createSession: CreateSession) => Promise<string>;
    createSession?: CreateSession;
    sessionTransport?: SessionTransportDeps;
    foregroundController?: ForegroundController;
  } = {}
): FunctionCommand[] {
  const createSession = deps.createSession ?? createDefaultSessionFactory();
  const doRun =
    deps.runReal ?? ((request: ParsedRequest, cs: CreateSession) => runReal(request, cs, deps.sessionTransport, deps.foregroundController));
  const domain = "computer-use";
  const run = (action: string) => async (args: string[]): Promise<string> => {
    const request = parseRequest(action, args);
    try {
      return await doRun(request, createSession);
    } catch (error) {
      throw mapError(request, error);
    }
  };
  return [
    {
      domain,
      action: "doctor",
      description: "Check platform, runtime files, driver load, and read-only permission status.",
      usage: ["yk computer-use doctor"],
      run: async (args: string[]) => {
        parseRequest("doctor", args); // strict: unknown flags are input errors
        const report = await runDoctor();
        const json = stringifyJson(report, 2);
        if (!report.ok) {
          throw new Error(`doctor found problems:\n${json}`);
        }
        return json;
      }
    },
    { domain, action: "apps", description: "List running apps (pid, name) with optional --name substring filter.", usage: ["yk computer-use apps [--name SUBSTRING]"], run: run("apps") },
    { domain, action: "windows", description: "List windows for a --pid (windowId as decimal string, title).", usage: ["yk computer-use windows --pid PID"], run: run("windows") },
    { domain, action: "perceive", description: "Read AX elements (and optional screenshot) of a window for the next decision.", usage: ["yk computer-use perceive --pid PID [--window ID] [--shot] [--activate] [--audit-foreground] [--out-dir DIR]"], run: run("perceive") },
    {
      domain,
      action: "observe",
      description:
        "Independent AX/image observation: returns observationId, per-channel validity, and image geometry for visual clicks.",
      usage: [
        "yk computer-use observe (--pid PID | --session ID) [--window ID] [--mode auto|ax|image|both]",
        "                              [--max-dimension PX] [--out-dir DIR]",
        "                              [--select-text TEXT [--select-match exact|contains] [--select-role ROLE]]"
      ],
      run: run("observe")
    },
    {
      domain,
      action: "session",
      description:
        "Persistent sessions: open/status/cancel/close. Reuses one driver across commands; request ids are deduped, never replayed.",
      usage: SESSION_USAGE_LINES,
      run: run("session")
    },
    {
      domain,
      action: "exec",
      description:
        "Run a JavaScript flow (--file, --request-id) inside a persistent session (--session): awaits, loops, local waits, explicit state.",
      usage: ["yk computer-use exec --session ID --file FILE --request-id ID [--timeout-ms N] [--max-actions N]"],
      run: run("exec")
    },
    {
      domain,
      action: "batch",
      description:
        "Run a bounded ordered action batch from a JSON file (--file, --request-id); deduped by request id, never replayed.",
      usage: [
        "yk computer-use batch (--pid PID | --session ID) --file FILE --request-id ID",
        "                       [--window ID] [--out-dir DIR] [--max-actions N<=20] [--timeout-ms N<=120000]"
      ],
      run: run("batch")
    },
    {
      domain,
      action: "act",
      description: "Perform one background action (click/set-value/type/key/scroll), then re-perceive.",
      usage: [
        "yk computer-use act (--pid PID | --session ID) [--window ID] [--shot] [--activate] [--audit-foreground] [--format observation|legacy] with exactly one action:",
        "  --click-text TEXT | --click-contains TEXT [--click-role ROLE]   AX text click",
        "  --click-x PX --click-y PY --observation UUID                      visual click (from observe)",
        "  --set-value VALUE --element-token TOKEN                          set AX value",
        "  --type TEXT | --key KEY [--modifiers MOD[,MOD]]                    keyboard input",
        "  --scroll up|down|left|right [--amount N] [--x PX] [--y PY]        scroll"
      ],
      run: run("act")
    }
  ];
}
