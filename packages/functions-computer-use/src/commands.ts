// Commands own validation, orchestration, and result envelopes. All desktop
// work goes through the shared session from @ya-skills/computer-runtime —
// there is no second driver implementation in this package.

import { spawnSync } from "node:child_process";
import type { FunctionCommand } from "@ya-skills/core";
import {
  bigintSafeReplacer,
  ComputerError,
  createComputerSession,
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

export type { ComputerSession } from "@ya-skills/computer-runtime";

type CreateSession = (options: { deadlineAt?: number }) => ComputerSession;

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

async function runReal(request: ParsedRequest, createSession: CreateSession): Promise<string> {
  const platform = process.platform === "darwin" && process.arch === "arm64";
  if (!platform) {
    throw jsonError(
      "unsupported_platform",
      `computer-use requires macOS arm64 (this machine: ${process.platform} ${process.arch})`
    );
  }
  const session = createSession({ deadlineAt: Date.now() + COMMAND_DEADLINE_MS });
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
  } = {}
): FunctionCommand[] {
  const createSession = deps.createSession ?? createComputerSession;
  const doRun =
    deps.runReal ?? ((request: ParsedRequest, cs: CreateSession) => runReal(request, cs));
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
    { domain, action: "act", description: "Perform one background action (click/type/key/scroll), then re-perceive.", run: run("act") }
  ];
}
