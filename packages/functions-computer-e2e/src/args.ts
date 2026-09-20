import { tokenizeFlags } from "@ya-skills/core";
// Strict input validation for `yk computer-e2e`. Everything is rejected
// before any worker, SDK, or run directory exists.

export const E2E_RUN_USAGE =
  "yk computer-e2e run <file.e2e.ts...> [--param k=v]... [--out-dir DIR] [--timeout-ms N] [--require-version V]";
export const E2E_HISTORY_USAGE = "yk computer-e2e history [--out-dir DIR] [--limit N]";
export const E2E_REPORT_USAGE = "yk computer-e2e report <run-dir>";
export const E2E_USAGE = `usage: ${E2E_RUN_USAGE}\n       ${E2E_HISTORY_USAGE}\n       ${E2E_REPORT_USAGE}`;

export type E2ERequest =
  | {
      action: "run";
      files: string[];
      params: Record<string, string>;
      outDir: string;
      timeoutMs: number;
      requireVersion?: string;
    }
  | { action: "history"; outDir: string; limit: number }
  | { action: "report"; runDir: string };

export const DEFAULT_OUT_DIR = ".computer-e2e/runs";
export const DEFAULT_RUN_TIMEOUT_MS = 900_000;
export const DEFAULT_HISTORY_LIMIT = 20;

const RUN_FLAGS = new Set(["param", "out-dir", "timeout-ms", "require-version"]);
const HISTORY_FLAGS = new Set(["out-dir", "limit"]);
const ALL_FLAGS = new Set([...RUN_FLAGS, ...HISTORY_FLAGS]);

function fail(message: string): never {
  throw new Error(`${message}\n${E2E_USAGE}`);
}

function requireNonEmpty(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") fail(`--${flag} requires a non-empty value`);
  return value;
}

function parsePositiveInt(flag: string, raw: string | undefined): number {
  if (!/^\d+$/.test(raw ?? "")) fail(`--${flag} must be a positive integer (got: ${raw})`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`--${flag} must be a positive integer (got: ${raw})`);
  return n;
}

export function parseE2EArgs(action: "run", argv: string[]): Extract<E2ERequest, { action: "run" }>;
export function parseE2EArgs(action: "history", argv: string[]): Extract<E2ERequest, { action: "history" }>;
export function parseE2EArgs(action: "report", argv: string[]): Extract<E2ERequest, { action: "report" }>;
export function parseE2EArgs(action: string, argv: string[]): E2ERequest;
export function parseE2EArgs(action: string, argv: string[]): E2ERequest {
  switch (action) {
    case "run": {
      const tokens = tokenizeFlags(argv, {
        allowed: RUN_FLAGS,
        known: ALL_FLAGS,
        repeatable: new Set(["param"]),
        fail
      });
      if (tokens.positional.length === 0) fail("run needs at least one suite file");
      const params: Record<string, string> = {};
      for (const entry of tokens.repeatable.param ?? []) {
        const eq = entry.indexOf("=");
        if (eq <= 0) fail(`--param needs key=value (got: ${entry})`);
        const key = entry.slice(0, eq);
        if (key.trim() === "") fail("--param needs a non-empty key");
        if (params[key] !== undefined) fail(`duplicate --param key: ${key}`);
        params[key] = entry.slice(eq + 1);
      }
      const requireVersion = tokens.values["require-version"];
      return {
        action: "run",
        files: tokens.positional,
        params,
        outDir: requireNonEmpty("out-dir", tokens.values["out-dir"] ?? DEFAULT_OUT_DIR),
        timeoutMs: parsePositiveInt("timeout-ms", tokens.values["timeout-ms"] ?? String(DEFAULT_RUN_TIMEOUT_MS)),
        ...(requireVersion !== undefined ? { requireVersion: requireNonEmpty("require-version", requireVersion) } : {})
      };
    }
    case "history": {
      const tokens = tokenizeFlags(argv, { allowed: HISTORY_FLAGS, known: ALL_FLAGS, fail });
      if (tokens.positional.length > 0) fail("history takes no positional arguments");
      return {
        action: "history",
        outDir: requireNonEmpty("out-dir", tokens.values["out-dir"] ?? DEFAULT_OUT_DIR),
        limit: parsePositiveInt("limit", tokens.values["limit"] ?? String(DEFAULT_HISTORY_LIMIT))
      };
    }
    case "report": {
      const tokens = tokenizeFlags(argv, { allowed: new Set(), known: ALL_FLAGS, fail });
      if (tokens.positional.length !== 1) fail("report takes exactly one run directory");
      return { action: "report", runDir: tokens.positional[0]! };
    }
    default:
      fail(`unknown action: ${action}`);
  }
}
