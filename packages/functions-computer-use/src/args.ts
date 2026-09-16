// Strict input validation for `yk computer-use`. Every request is validated
// BEFORE any native driver exists: bad input must fail with a code-1 exit and
// a readable message, never by spawning a driver that then half-initializes.
// windowId is a decimal bigint (macOS window ids exceed Number.MAX_SAFE_INTEGER);
// pid must stay a positive safe integer.

import { parseSessionArgs } from "./session-command.js";

export const USAGE = "usage: yk computer-use <doctor|apps|windows|perceive|observe|act|batch|session>";

export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ClickSpec {
  kind: "text" | "contains";
  text: string;
  role?: string;
}

export interface ScrollSpec {
  direction: ScrollDirection;
  amount: number;
  x: number;
  y: number;
}

export type ActSpec =
  | { action: "click"; click: ClickSpec }
  | { action: "click_point"; clickPoint: { observationId: string; x: number; y: number } }
  | { action: "set_value"; elementToken: string; value: string }
  | { action: "type"; type: string }
  | { action: "key"; key: string }
  | { action: "scroll"; scroll: ScrollSpec };

export type ObservationMode = "auto" | "ax" | "image" | "both";

export interface ObserveSpec {
  mode: ObservationMode;
  maxDimension?: number;
  selector?: { text: string; match: "exact" | "contains"; role?: string };
}

export type ParsedRequest =
  | { kind: "doctor" }
  | { kind: "apps"; name?: string }
  | { kind: "windows"; pid: number }
  | ({ kind: "perceive"; pid: number } & CommonOpts)
  | ({ kind: "observe"; pid: number } & CommonOpts & ObserveSpec)
  | ({ kind: "act"; pid: number } & CommonOpts & ActSpec)
  | ({ kind: "batch"; pid: number } & CommonOpts & {
      file: string;
      requestId: string;
      timeoutMs?: number;
      maxActions?: number;
    })
  | { kind: "exec"; sessionId: string; file: string; requestId: string; timeoutMs?: number; maxActions?: number }
  | { kind: "session"; argv: string[] };

interface CommonOpts {
  windowId?: bigint;
  shot: boolean;
  activate: boolean;
  outDir?: string;
  session?: string;
}

// Flags that take a value. Boolean flags are validated so that a value-looking
// token after them (e.g. `--shot 5`) is an unknown flag, not a silent ignore.
const VALUE_FLAGS = new Set([
  "pid",
  "window",
  "name",
  "out-dir",
  "type",
  "set-value",
  "element-token",
  "key",
  "scroll",
  "click-text",
  "click-contains",
  "click-role",
  "click-x",
  "click-y",
  "observation",
  "amount",
  "x",
  "y",
  "mode",
  "max-dimension",
  "select-text",
  "select-match",
  "select-role",
  "file",
  "request-id",
  "max-actions",
  "timeout-ms",
  "session",
  "idle-timeout-ms"
]);
const BOOL_FLAGS = new Set(["shot", "activate"]);

const ALLOWED: Record<string, Set<string>> = {
  doctor: new Set(),
  apps: new Set(["name"]),
  windows: new Set(["pid"]),
  perceive: new Set(["pid", "window", "shot", "activate", "out-dir"]),
  observe: new Set([
    "pid",
    "window",
    "mode",
    "max-dimension",
    "select-text",
    "select-match",
    "select-role",
    "out-dir",
    "session"
  ]),
  act: new Set([
    "pid",
    "window",
    "shot",
    "activate",
    "out-dir",
    "type",
    "set-value",
    "element-token",
    "key",
    "scroll",
    "click-text",
    "click-contains",
    "click-role",
    "click-x",
    "click-y",
    "observation",
    "amount",
    "x",
    "y",
    "session"
  ]),
  batch: new Set(["pid", "window", "file", "request-id", "max-actions", "timeout-ms", "out-dir", "session"]),
  exec: new Set(["session", "file", "request-id", "timeout-ms", "max-actions"]),
  session: new Set(["pid", "window", "session", "request-id", "idle-timeout-ms"])
};

interface Tokens {
  values: { [flag: string]: string | undefined };
  positional: string[];
}

function fail(message: string): never {
  throw new Error(`${message}\n${USAGE}`);
}

function tokenize(argv: string[], allowed: Set<string>): Tokens {
  const out: Tokens = { values: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (!raw.startsWith("--")) {
      out.positional.push(raw);
      continue;
    }
    const body = raw.slice(2);
    const eq = body.indexOf("=");
    const flag = eq === -1 ? body : body.slice(0, eq);
    if (flag === "") fail(`unknown flag syntax: ${raw}`);
    if (!allowed.has(flag)) {
      if (VALUE_FLAGS.has(flag) || BOOL_FLAGS.has(flag)) {
        fail(`--${flag} is not valid for this action`);
      }
      fail(`unknown flag: --${flag}`);
    }
    if (BOOL_FLAGS.has(flag)) {
      if (eq !== -1) fail(`--${flag} does not take a value`);
      if (out.values[flag] !== undefined) fail(`--${flag} given twice`);
      out.values[flag] = "true";
      continue;
    }
    let value: string;
    if (eq !== -1) {
      value = body.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        fail(`--${flag} requires a value`);
      }
      value = next;
      i++;
    }
    if (out.values[flag] !== undefined) fail(`--${flag} given twice`);
    out.values[flag] = value;
  }
  return out;
}

function parsePid(raw: string | undefined): number {
  if (raw === undefined) fail("missing --pid");
  if (!/^\d+$/.test(raw)) fail(`--pid must be a positive integer (got: ${raw})`);
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    fail(`--pid must be a positive safe integer (got: ${raw})`);
  }
  return pid;
}

function parseWindowId(raw: string | undefined): bigint | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) fail(`--window must be decimal digits (got: ${raw})`);
  return BigInt(raw);
}

function parseNumber(flag: string, raw: string | undefined, opts: { integer?: boolean; positive?: boolean } = {}): number {
  if (raw === undefined) return opts.positive ? 1 : 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${flag} must be a finite number (got: ${raw})`);
  if (opts.integer && !Number.isSafeInteger(n)) fail(`--${flag} must be a safe integer (got: ${raw})`);
  if (opts.positive && n <= 0) fail(`--${flag} must be positive (got: ${raw})`);
  return n;
}

function common(tokens: Tokens): CommonOpts {
  return {
    windowId: parseWindowId(tokens.values["window"]),
    shot: tokens.values["shot"] !== undefined,
    activate: tokens.values["activate"] !== undefined,
    outDir:
      tokens.values["out-dir"] === undefined
        ? undefined
        : requireNonEmpty("--out-dir", tokens.values["out-dir"]),
    session:
      tokens.values["session"] === undefined
        ? undefined
        : requireNonEmpty("--session", tokens.values["session"])
  };
}

function requireNonEmpty(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") fail(`--${flag} requires a non-empty value`);
  return value;
}

function parseRequestId(value: string | undefined): string {
  const requestId = requireNonEmpty("--request-id", value);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
    fail("--request-id must contain only letters, numbers, dot, underscore, or hyphen (max 128 characters)");
  }
  return requestId;
}

function parseActSpec(tokens: Tokens): ActSpec {
  const hasType = tokens.values["type"] !== undefined;
  const setValue = tokens.values["set-value"];
  const elementToken = tokens.values["element-token"];
  const hasSetValue = setValue !== undefined || elementToken !== undefined;
  const hasKey = tokens.values["key"] !== undefined;
  const hasScroll = tokens.values["scroll"] !== undefined;
  const clickText = tokens.values["click-text"];
  const clickContains = tokens.values["click-contains"];
  const hasClick = clickText !== undefined || clickContains !== undefined;
  const clickX = tokens.values["click-x"];
  const clickY = tokens.values["click-y"];
  const observation = tokens.values["observation"];
  const hasClickPoint = clickX !== undefined || clickY !== undefined || observation !== undefined;
  const count = [hasType, hasKey, hasScroll, hasClick, hasClickPoint, hasSetValue].filter(Boolean).length;
  if (count === 0) {
    fail("act needs exactly one action: --click-text/--click-contains [--click-role], --click-x/--click-y --observation, --set-value VALUE --element-token TOKEN, --type, --key, --scroll");
  }
  if (count > 1) {
    fail("act takes exactly one action per invocation");
  }
  if (hasSetValue) {
    if (setValue === undefined) fail("--set-value requires --element-token");
    if (elementToken === undefined) fail("--element-token requires --set-value");
    if (elementToken.trim() === "") fail("--element-token requires a non-empty value");
    return { action: "set_value", elementToken, value: setValue };
  }
  if (hasType) {
    return { action: "type", type: requireNonEmpty("--type", tokens.values["type"]) };
  }
  if (hasKey) {
    return { action: "key", key: requireNonEmpty("--key", tokens.values["key"]) };
  }
  if (hasScroll) {
    const direction = tokens.values["scroll"] as string;
    if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
      fail(`--scroll must be up|down|left|right (got: ${direction})`);
    }
    return {
      action: "scroll",
      scroll: {
        direction,
        amount: parseNumber("amount", tokens.values["amount"], { integer: true, positive: true }),
        x: parseNumber("x", tokens.values["x"]),
        y: parseNumber("y", tokens.values["y"])
      }
    };
  }
  if (hasClickPoint) {
    if (observation === undefined) {
      fail("visual clicks need --observation (the observation id from a prior yk computer-use observe)");
    }
    if (clickX === undefined || clickY === undefined) {
      fail("--click-x and --click-y must be provided together");
    }
    const px = parseNumber("click-x", clickX);
    const py = parseNumber("click-y", clickY);
    if (px < 0 || py < 0) fail("--click-x/--click-y must be non-negative image pixel coordinates");
    const observationId = requireNonEmpty("--observation", observation);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(observationId)) {
      fail("--observation must be a UUID returned by a prior observe");
    }
    return { action: "click_point", clickPoint: { observationId, x: px, y: py } };
  }
  const kind = clickText !== undefined ? "text" : "contains";
  const text = requireNonEmpty(
    kind === "text" ? "--click-text" : "--click-contains",
    clickText ?? clickContains
  );
  const role =
    tokens.values["click-role"] === undefined
      ? undefined
      : requireNonEmpty("--click-role", tokens.values["click-role"]);
  return { action: "click", click: { kind, text, role } };
}

function parseObserveSpec(tokens: Tokens): ObserveSpec {
  const mode = tokens.values["mode"] ?? "auto";
  if (mode !== "auto" && mode !== "ax" && mode !== "image" && mode !== "both") {
    fail(`--mode must be auto|ax|image|both (got: ${mode})`);
  }
  const maxDimension =
    tokens.values["max-dimension"] === undefined
      ? undefined
      : parseNumber("max-dimension", tokens.values["max-dimension"], { integer: true, positive: true });
  const selectText = tokens.values["select-text"];
  const selectMatch = tokens.values["select-match"];
  const selectRole = tokens.values["select-role"];
  if (selectMatch !== undefined && selectMatch !== "exact" && selectMatch !== "contains") {
    fail(`--select-match must be exact|contains (got: ${selectMatch})`);
  }
  if ((selectMatch !== undefined || selectRole !== undefined) && selectText === undefined) {
    fail("--select-match/--select-role require --select-text");
  }
  return {
    mode,
    ...(maxDimension !== undefined ? { maxDimension } : {}),
    ...(selectText !== undefined
      ? {
          selector: {
            text: requireNonEmpty("--select-text", selectText),
            match: (selectMatch ?? "exact") as "exact" | "contains",
            ...(selectRole !== undefined ? { role: requireNonEmpty("--select-role", selectRole) } : {})
          }
        }
      : {})
  };
}

export function parseRequest(action: string, argv: string[]): ParsedRequest {
  const allowed = ALLOWED[action];
  if (allowed === undefined) {
    fail(`unknown action: ${action}`);
  }
  if (action === "session") {
    // eager structural validation: bad subcommand input fails here, before
    // any session/host work
    parseSessionArgs(argv);
    return { kind: "session", argv };
  }
  const tokens = tokenize(argv, allowed);
  if (tokens.positional.length > 0) {
    fail(`action '${action}' takes no positional arguments (got: ${tokens.positional.join(", ")})`);
  }
  if (["observe", "act", "batch"].includes(action) && tokens.values["session"] !== undefined) {
    if (tokens.values["pid"] !== undefined || tokens.values["window"] !== undefined) {
      fail("--session and --pid/--window are exclusive; the session already owns a target");
    }
    if (tokens.values["out-dir"] !== undefined) {
      fail("--out-dir is only supported for one-shot commands; session artifacts use the session-owned directory");
    }
  }
  switch (action) {
    case "doctor":
      return { kind: "doctor" };
    case "apps": {
      const name =
        tokens.values["name"] === undefined
          ? undefined
          : requireNonEmpty("--name", tokens.values["name"]);
      return { kind: "apps", name };
    }
    case "windows":
      return { kind: "windows", pid: parsePid(tokens.values["pid"]) };
    case "perceive":
      return { kind: "perceive", pid: parsePid(tokens.values["pid"]), ...common(tokens) };
    case "observe":
      return {
        kind: "observe",
        pid: tokens.values["session"] !== undefined ? 0 : parsePid(tokens.values["pid"]),
        ...common(tokens),
        ...parseObserveSpec(tokens)
      };
    case "batch": {
      if (tokens.values["file"] === undefined) fail("missing --file (the batch JSON file)");
      const file = requireNonEmpty("--file", tokens.values["file"]);
      const requestId = parseRequestId(tokens.values["request-id"]);
      let timeoutMs: number | undefined;
      if (tokens.values["timeout-ms"] !== undefined) {
        timeoutMs = parseNumber("timeout-ms", tokens.values["timeout-ms"], { integer: true, positive: true });
        if (timeoutMs > 120_000) fail("--timeout-ms must be <= 120000");
      }
      let maxActions: number | undefined;
      if (tokens.values["max-actions"] !== undefined) {
        maxActions = parseNumber("max-actions", tokens.values["max-actions"], { integer: true, positive: true });
        if (maxActions > 20) fail("--max-actions must be <= 20");
      }
      return {
        kind: "batch",
        pid: tokens.values["session"] !== undefined ? 0 : parsePid(tokens.values["pid"]),
        ...common(tokens),
        file,
        requestId,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxActions !== undefined ? { maxActions } : {})
      };
    }
    case "exec": {
      if (tokens.values["session"] === undefined) {
        fail("exec runs inside a persistent session — open one first (session open) and pass --session");
      }
      if (tokens.values["file"] === undefined) fail("missing --file (the script file)");
      const file = requireNonEmpty("--file", tokens.values["file"]);
      const requestId = parseRequestId(tokens.values["request-id"]);
      const timeoutMs = tokens.values["timeout-ms"] === undefined ? undefined : parseNumber("timeout-ms", tokens.values["timeout-ms"], { integer: true, positive: true });
      if (timeoutMs !== undefined && timeoutMs > 120_000) fail("--timeout-ms must be <= 120000");
      const maxActions = tokens.values["max-actions"] === undefined ? undefined : parseNumber("max-actions", tokens.values["max-actions"], { integer: true, positive: true });
      if (maxActions !== undefined && maxActions > 500) fail("--max-actions must be <= 500");
      return {
        kind: "exec",
        sessionId: requireNonEmpty("--session", tokens.values["session"]),
        file,
        requestId,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxActions !== undefined ? { maxActions } : {})
      };
    }
    case "act": {
      const options = common(tokens);
      const spec = parseActSpec(tokens);
      if (spec.action === "set_value" && options.activate) {
        fail("--activate cannot be used with --set-value; the AX-only action never activates a window");
      }
      return {
        kind: "act",
        pid: tokens.values["session"] !== undefined ? 0 : parsePid(tokens.values["pid"]),
        ...options,
        ...spec
      };
    }
    default:
      fail(`unknown action: ${action}`);
  }
}
