// Strict input validation for `yk computer-use`. Every request is validated
// BEFORE any native driver exists: bad input must fail with a code-1 exit and
// a readable message, never by spawning a driver that then half-initializes.
// windowId is a decimal bigint (macOS window ids exceed Number.MAX_SAFE_INTEGER);
// pid must stay a positive safe integer.

export const USAGE = "usage: yk computer-use <doctor|apps|windows|perceive|act>";

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
  | { action: "type"; type: string }
  | { action: "key"; key: string }
  | { action: "scroll"; scroll: ScrollSpec };

export type ParsedRequest =
  | { kind: "doctor" }
  | { kind: "apps"; name?: string }
  | { kind: "windows"; pid: number }
  | ({ kind: "perceive"; pid: number } & CommonOpts)
  | ({ kind: "act"; pid: number } & CommonOpts & ActSpec);

interface CommonOpts {
  windowId?: bigint;
  shot: boolean;
  activate: boolean;
  outDir?: string;
}

// Flags that take a value. Boolean flags are validated so that a value-looking
// token after them (e.g. `--shot 5`) is an unknown flag, not a silent ignore.
const VALUE_FLAGS = new Set([
  "pid",
  "window",
  "name",
  "out-dir",
  "type",
  "key",
  "scroll",
  "click-text",
  "click-contains",
  "click-role",
  "amount",
  "x",
  "y"
]);
const BOOL_FLAGS = new Set(["shot", "activate"]);

const ALLOWED: Record<string, Set<string>> = {
  doctor: new Set(),
  apps: new Set(["name"]),
  windows: new Set(["pid"]),
  perceive: new Set(["pid", "window", "shot", "activate", "out-dir"]),
  act: new Set([
    "pid",
    "window",
    "shot",
    "activate",
    "out-dir",
    "type",
    "key",
    "scroll",
    "click-text",
    "click-contains",
    "click-role",
    "amount",
    "x",
    "y"
  ])
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
        : requireNonEmpty("--out-dir", tokens.values["out-dir"])
  };
}

function requireNonEmpty(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") fail(`--${flag} requires a non-empty value`);
  return value;
}

function parseActSpec(tokens: Tokens): ActSpec {
  const hasType = tokens.values["type"] !== undefined;
  const hasKey = tokens.values["key"] !== undefined;
  const hasScroll = tokens.values["scroll"] !== undefined;
  const clickText = tokens.values["click-text"];
  const clickContains = tokens.values["click-contains"];
  const hasClick = clickText !== undefined || clickContains !== undefined;
  const count = [hasType, hasKey, hasScroll, hasClick].filter(Boolean).length;
  if (count === 0) {
    fail("act needs exactly one action: --click-text/--click-contains [--click-role], --type, --key, --scroll");
  }
  if (count > 1) {
    fail("act takes exactly one action per invocation");
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

export function parseRequest(action: string, argv: string[]): ParsedRequest {
  const allowed = ALLOWED[action];
  if (allowed === undefined) {
    fail(`unknown action: ${action}`);
  }
  const tokens = tokenize(argv, allowed);
  if (tokens.positional.length > 0) {
    fail(`action '${action}' takes no positional arguments (got: ${tokens.positional.join(", ")})`);
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
    case "act":
      return {
        kind: "act",
        pid: parsePid(tokens.values["pid"]),
        ...common(tokens),
        ...parseActSpec(tokens)
      };
    default:
      fail(`unknown action: ${action}`);
  }
}
