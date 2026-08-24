import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import type { JsonObject } from "./adapters/types.js";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

export function nowIso(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function slugify(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return (ascii || "case").slice(0, 60).replace(/-+$/g, "") || "case";
}

export function normalizeRunProfile(value: string | undefined): string {
  return value?.trim() || "default";
}

export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return null;
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").includes("..") ? null : normalized;
}

export function relativePathFrom(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, "/");
}

export function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function decodeUtf8Text(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    TEXT_DECODER.decode(bytes);
    return true;
  } catch {
    return false;
  }
}
