import { bigintSafeReplacer } from "@ya-skills/computer-runtime";

export function stringifyJson(value: unknown, space?: number): string {
  return JSON.stringify(value, bigintSafeReplacer, space);
}

export function jsonError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return new Error(stringifyJson({ error: { code, message, ...extra } }));
}

export function readErrorEnvelope(error: unknown): Record<string, unknown> | undefined {
  const message = error instanceof Error ? error.message : error;
  if (typeof message !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(message);
    if (typeof value !== "object" || value === null) return undefined;
    const body = (value as { error?: unknown }).error;
    return typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
