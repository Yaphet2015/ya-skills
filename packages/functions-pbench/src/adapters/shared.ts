import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "./types.js";

export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function parseJsonlLines(text: string): JsonObject[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as JsonObject;
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${(error as Error).message}`);
      }
    });
}

export function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join("\n");
  const object = asObject(value);
  if (!object) return "";
  if (typeof object.text === "string") return object.text;
  if (typeof object.content === "string") return object.content;
  return Array.isArray(object.content) ? valueToText(object.content) : "";
}

export function isErrorRecord(record: JsonObject): boolean {
  const status = String(record.status ?? record.outcome ?? "").toLowerCase();
  const exitCode = record.exit_code ?? record.exitCode;
  return (
    status === "failed" ||
    status === "error" ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    (typeof record.stderr === "string" && record.stderr.length > 0 && status !== "success")
  );
}

export function commandVersion(command: string, env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env
    }).trim() || null;
  } catch {
    return null;
  }
}

export async function findSessionFileByName(root: string, sessionId: string): Promise<string | null> {
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) return null;

  const matches: { path: string; mtimeMs: number }[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
        matches.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      }
    }
  }
  await visit(root);
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.path ?? null;
}
