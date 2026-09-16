// Commands own validation, orchestration, and result envelopes. All desktop
// work goes through the shared session from @ya-skills/computer-runtime —
// there is no second driver implementation in this package.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { FunctionCommand } from "@ya-skills/core";
import {
  bigintSafeReplacer,
  ComputerError,
  createComputerSession,
  createObservationStore,
  defaultArtifactsDir,
  ensureOutDir,
  saveScreenshot,
  selectWindow,
  type AxElement,
  type ComputerSession,
  type Snapshot,
  type Target
} from "@ya-skills/computer-runtime";
import { parseRequest, type ClickSpec, type ParsedRequest } from "./args.js";
import { COMMAND_DEADLINE_MS } from "./consts.js";
import { runDoctor } from "./runtime.js";
import { observeCommand, type ObserveCommandRequest } from "./observe-command.js";
import { batchCommand, type BatchCommandRequest } from "./batch-command.js";
import { parseSessionArgs, runOnSession, sessionCommand, type SessionTransportDeps } from "./session-command.js";
import { execCommand } from "./exec-command.js";
import { sessionRoot } from "@ya-skills/computer-session";
import { createAutoLeases } from "@ya-skills/computer-runtime";

export type { ComputerSession } from "@ya-skills/computer-runtime";

type CreateSession = (options: { deadlineAt?: number; artifactsDir?: string }) => ComputerSession;

// The default session factory wires the cross-command observation store:
// observe writes there; act --click-x/--click-y reads + verifies from there.


function jsonError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return new Error(JSON.stringify({ error: { code, message, ...extra } }, bigintSafeReplacer));
}

// --activate is the ONLY foreground path, and only on the explicit CLI flag.
function activate(pid: number): void {
  spawnSync("osascript", [
    "-e",
    `tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`
  ]);
  spawnSync("sleep", ["0.6"]);
}

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
  return JSON.stringify(
    {
      ...target,
      title: snapshot.title,
      elements: snapshot.elements,
      ...(snapshot.imageBase64
        ? { screenshot: saveScreenshot(ensureOutDir(outDir), snapshot.imageBase64) }
        : {})
    },
    bigintSafeReplacer
  );
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
      return { kind: "key", key: request.key };
    case "scroll":
      return { kind: "scroll", spec: request.scroll };
  }
}

function postActionObserveError(error: unknown): Error {
  return new Error(
    JSON.stringify(
      {
        error: {
          code: "post_action_observe_failed",
          message: error instanceof Error ? error.message : String(error),
          actionDelivered: true,
          nextStep: "run perceive; do NOT repeat the act"
        }
      },
      bigintSafeReplacer
    )
  );
}

// Map shared-layer errors onto the CLI's JSON error contract.
function mapError(request: ParsedRequest, error: unknown): unknown {
  if (error instanceof ComputerError) {
    if (request.kind === "act" && error.code === "command_timeout") {
      return jsonError("command_timeout", error.message, {
        actionOutcome: error.actionOutcome ?? "unknown",
        nextStep: "run perceive to observe the current state; do NOT repeat the act"
      });
    }
    if (error.code === "action_refused") {
      return jsonError("action_refused", error.message);
    }
    if (error.code === "ax_only_unverified") {
      return jsonError("ax_only_unverified", error.message, {
        actionOutcome: "unknown",
        nextStep: "observe the target before any further action; do NOT repeat the set-value request"
      });
    }
    if (error.code === "ax_only_unsupported") {
      return jsonError("ax_only_unsupported", error.message, { actionOutcome: "not_delivered" });
    }
    if (error.code === "invalid_request") {
      return jsonError("invalid_request", error.message, { actionOutcome: "not_delivered" });
    }
    if (error.code === "degraded_snapshot") {
      return jsonError("degraded_snapshot", error.message);
    }
    if (error.code === "aborted" || error.code === "session_closed" || error.code === "session_unusable") {
      return jsonError(error.code, error.message);
    }
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
  sessionTransport: SessionTransportDeps = {}
): Promise<string> {
  if (request.kind === "session") {
    const run = sessionCommand(sessionTransport);
    return run(parseSessionArgs(request.argv));
  }
  if (request.kind === "exec") {
    return execCommand()({
      sessionId: request.sessionId,
      file: request.file,
      requestId: request.requestId,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.maxActions !== undefined ? { maxActions: request.maxActions } : {})
    });
  }
  if ("session" in request && request.session !== undefined) {
    if (request.kind === "observe") {
      return runOnSession(request.session, {
        kind: "observe",
        options: {
          mode: request.mode,
          ...(request.maxDimension !== undefined ? { maxDimension: request.maxDimension } : {}),
          ...(request.selector !== undefined ? { selector: request.selector } : {})
        }
      }, 30_000, sessionTransport);
    }
    if (request.kind === "batch") {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(request.file, "utf8");
      let parsed: unknown = JSON.parse(raw);
      // Session and one-shot batch commands share the same budget contract:
      // apply CLI overrides before the request is validated/hashed so a
      // retry with different limits is a distinct request.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw jsonError("batch_request_invalid", "batch file must contain a JSON object to apply session budget overrides");
      }
      parsed = {
        ...(parsed as Record<string, unknown>),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.maxActions !== undefined ? { maxActions: request.maxActions } : {})
      };
      return runOnSession(
        request.session,
        { kind: "batch", request: parsed, file: request.file, requestId: request.requestId },
        Math.min(150_000, (request.timeoutMs ?? 120_000) + 30_000),
        sessionTransport
      );
    }
    // act on a session: single action through the host's batch operation
    const single = actSpecToSingleAction(request as ParsedRequest & { kind: "act" });
    return runOnSession(
      request.session,
      { kind: "batch", request: { actions: [single] }, requestId: `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
      30_000,
      sessionTransport
    );
  }
  const platform = process.platform === "darwin" && process.arch === "arm64";
  if (!platform) {
    throw jsonError(
      "unsupported_platform",
      `computer-use requires macOS arm64 (this machine: ${process.platform} ${process.arch})`
    );
  }
  const session = createSession({
    deadlineAt: Date.now() + COMMAND_DEADLINE_MS,
    ...("outDir" in request && request.outDir !== undefined ? { artifactsDir: request.outDir } : {})
  });
  try {
    switch (request.kind) {
      case "apps": {
        let apps = await session.computer.apps();
        if (request.name) {
          const n = request.name.toLowerCase();
          apps = apps.filter((a) => String(a.name ?? "").toLowerCase().includes(n));
        }
        return JSON.stringify({ apps }, bigintSafeReplacer);
      }
      case "windows": {
        const wins = await session.computer.windows(request.pid);
        return JSON.stringify(
          { windows: wins.map((w) => ({ windowId: w.windowId, title: w.title })) },
          bigintSafeReplacer
        );
      }
      case "perceive": {
        if (request.activate) activate(request.pid);
        const win = selectWindow(await session.computer.windows(request.pid), request.windowId);
        const target: Target = { pid: request.pid, windowId: win.windowId };
        const snap = await session.computer.snapshot(target, { screenshot: request.shot });
        return encodePerception(target, snap, request.outDir);
      }
      case "act": {
        if (request.activate) activate(request.pid);
        const win = selectWindow(await session.computer.windows(request.pid), request.windowId);
        const target: Target = { pid: request.pid, windowId: win.windowId };

        // --- the ONE action ---
        if (request.action === "click") {
          await session.computer.click(
            target,
            clickPredicate(request.click),
            `click ${request.click.role ?? ""} "${request.click.text}"`
          );
        } else if (request.action === "click_point") {
          await session.computer.clickPoint(target, request.clickPoint);
        } else if (request.action === "set_value") {
          await session.computer.setValue(target, request.elementToken, request.value);
        } else if (request.action === "type") {
          await session.computer.type(target, request.type);
        } else if (request.action === "key") {
          await session.computer.key(target, request.key);
        } else {
          await session.computer.scroll(target, {
            direction: request.scroll.direction,
            amount: request.scroll.amount,
            x: request.scroll.x,
            y: request.scroll.y
          });
        }

        // --- post-action perception for the agent's NEXT decision ---
        try {
          const snap = await session.computer.snapshot(target, { screenshot: request.shot });
          return encodePerception(target, snap, request.outDir);
        } catch (error) {
          throw postActionObserveError(error);
        }
      }
      case "observe": {
        const run = observeCommand({ createSession });
        return run({
          pid: request.pid,
          windowId: request.windowId,
          mode: request.mode,
          ...(request.maxDimension !== undefined ? { maxDimension: request.maxDimension } : {}),
          ...(request.selector !== undefined ? { selector: request.selector } : {}),
          outDir: request.outDir
        } satisfies ObserveCommandRequest);
      }
      case "batch": {
        const run = batchCommand({ createSession });
        return run({
          pid: request.pid,
          windowId: request.windowId,
          file: request.file,
          requestId: request.requestId,
          outDir: request.outDir,
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.maxActions !== undefined ? { maxActions: request.maxActions } : {})
        } satisfies BatchCommandRequest);
      }
      default:
        throw jsonError("internal", "unhandled request kind");
    }
  } finally {
    // Single-step CLI contract: cleanup warnings never mask the primary
    // error nor rewrite a successful result.
    try {
      await session.close();
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
  } = {}
): FunctionCommand[] {
  const createSession: CreateSession =
    deps.createSession ??
    ((options) => {
      const artifactsDir = options.artifactsDir ?? defaultArtifactsDir();
      return createComputerSession({
        ...options,
        artifactsDir,
        observationStore: createObservationStore(join(artifactsDir, "observations")),
        // Shared target ownership (B3): the single-step/batch CLI acquires the
        // SAME app-level lease tree session hosts use, so an active session
        // refuses independent CLI mutations and vice versa. The lease root is
        // the sessions root — identical to openSession's default.
        leases: createAutoLeases(sessionRoot(), "single-step")
      });
    });
  const doRun =
    deps.runReal ?? ((request: ParsedRequest, cs: CreateSession) => runReal(request, cs, deps.sessionTransport));
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
      run: async (args: string[]) => {
        parseRequest("doctor", args); // strict: unknown flags are input errors
        const report = await runDoctor();
        const json = JSON.stringify(report, null, 2);
        if (!report.ok) {
          throw new Error(`doctor found problems:\n${json}`);
        }
        return json;
      }
    },
    { domain, action: "apps", description: "List running apps (pid, name) with optional --name substring filter.", run: run("apps") },
    { domain, action: "windows", description: "List windows for a --pid (windowId as decimal string, title).", run: run("windows") },
    { domain, action: "perceive", description: "Read AX elements (and optional screenshot) of a window for the next decision.", run: run("perceive") },
    {
      domain,
      action: "observe",
      description:
        "Independent AX/image observation: returns observationId, per-channel validity, and image geometry for visual clicks.",
      run: run("observe")
    },
    {
      domain,
      action: "session",
      description:
        "Persistent sessions: open/status/cancel/close. Reuses one driver across commands; request ids are deduped, never replayed.",
      run: run("session")
    },
    {
      domain,
      action: "exec",
      description:
        "Run a JavaScript flow (--file, --request-id) inside a persistent session (--session): awaits, loops, local waits, explicit state.",
      run: run("exec")
    },
    {
      domain,
      action: "batch",
      description:
        "Run a bounded ordered action batch from a JSON file (--file, --request-id); deduped by request id, never replayed.",
      run: run("batch")
    },
    { domain, action: "act", description: "Perform one background action (click/set-value/type/key/scroll), then re-perceive.", run: run("act") }
  ];
}
