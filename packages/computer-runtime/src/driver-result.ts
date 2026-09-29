import type { ActionResult, AxValueResult, ToolResultLike } from "./types.js";

export class ComputerError extends Error {
  constructor(
    public code: string,
    message: string,
    public actionOutcome?: "delivered" | "not_delivered" | "unknown",
    public result?: ActionResult
  ) {
    super(message);
  }
}

const PREDISPATCH_TOOL_ERROR_CODES = new Set([
  "stale_element_token",
  "window_target_not_found",
  "px_capture_unavailable"
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function driverErrorTag(error: unknown): string | undefined {
  const root = asRecord(error);
  if (root === undefined) return undefined;
  if (typeof root.tag === "string") return root.tag;
  const nested = asRecord(root.tag);
  return typeof nested?.tag === "string" ? nested.tag : undefined;
}

function driverErrorCode(error: unknown): string | undefined {
  const root = asRecord(error);
  if (root === undefined) return undefined;
  const inner = asRecord(root.inner);
  if (typeof inner?.errorCode === "string") return inner.errorCode;
  return typeof root.errorCode === "string" ? root.errorCode : undefined;
}

export function isKnownDriverRefusal(error: unknown): boolean {
  const root = asRecord(error);
  if (root === undefined) return false;
  const name = typeof root.name === "string" ? root.name : "";
  const tag = driverErrorTag(error);
  // InvalidArguments is rejected while constructing the request, before the
  // native input boundary. A Tool class name alone is not enough: the SDK can
  // use DriverError.Tool after an action has already entered the app.
  if (tag === "InvalidArguments" || name === "DriverError.InvalidArguments") return true;
  return PREDISPATCH_TOOL_ERROR_CODES.has(driverErrorCode(error) ?? "");
}

export function isAbortError(error: unknown): boolean {
  return asRecord(error)?.name === "AbortError";
}

export function isTimeoutError(error: unknown): error is Error {
  return error instanceof Error && /timed out/.test(error.message);
}

export function driverErrorDiagnostic(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const root = asRecord(error);
  const tag = driverErrorTag(error);
  const name = typeof root?.name === "string" ? root.name : "";
  if (tag !== "Tool" && name !== "DriverError.Tool") return base;
  const code = driverErrorCode(error);
  // SDK messages can contain application content. The code is enough to
  // diagnose delivery classification without copying the whole inner error.
  return code !== undefined && /^[a-z0-9_]+$/i.test(code)
    ? `${base} (errorCode=${code})`
    : base;
}

function parseStructuredObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function unverifiedAxResult(message: string): never {
  throw new ComputerError(
    "ax_only_unverified",
    `${message}; delivery is unknown and the session is now unusable`,
    "unknown"
  );
}

/**
 * `set_value` is the strict AX-only seam. The generic SDK keeps its
 * structured action result in `structuredJson`; accepting a result without a
 * confirmed Accessibility route would turn this method into an unsafe
 * fallback. A result that crossed the native seam but cannot prove the route
 * is therefore an unknown delivery and poisons the session in `action()`.
 */
export function parseAxValueResult(result: void | ToolResultLike): AxValueResult {
  const tool = asRecord(result);
  const candidate = parseStructuredObject(tool?.structuredJson as string | undefined);
  // Generic set_value is accepted only from its structured JSON envelope.
  // Typed `action` metadata or raw JSON is not a substitute: accepting either
  // would make an unrelated result look like proof that this call stayed on
  // the AX route.
  const route = candidate?.route;
  const effect = candidate?.effect;
  if (route !== "accessibility" || effect !== "confirmed") {
    unverifiedAxResult("set_value did not return a confirmed Accessibility route");
  }
  const deliveryValue = candidate?.delivery;
  if (deliveryValue !== undefined && deliveryValue !== null && asRecord(deliveryValue) === undefined) {
    unverifiedAxResult("set_value returned malformed delivery metadata");
  }
  const delivery = asRecord(deliveryValue);
  const mode = delivery?.mode;
  if (mode !== undefined && mode !== "not_applicable" && mode !== "background" && mode !== "foreground" && mode !== "unknown") {
    unverifiedAxResult("set_value returned an unknown delivery mode");
  }
  // The SDK envelope uses snake_case JSON; the public TypeScript result keeps
  // camelCase. Validate the optional count before converting its spelling.
  const deliveredCount = delivery?.delivered_count ?? delivery?.deliveredCount;
  if (deliveredCount !== undefined && deliveredCount !== null &&
      (typeof deliveredCount !== "number" || !Number.isSafeInteger(deliveredCount) || deliveredCount < 0)) {
    unverifiedAxResult("set_value returned malformed delivery count");
  }
  return {
    route: "accessibility",
    effect: "confirmed",
    ...(mode !== undefined || deliveredCount !== undefined
      ? {
          delivery: {
            ...(mode !== undefined ? { mode } : {}),
            ...(typeof deliveredCount === "number" || deliveredCount === null ? { deliveredCount } : {})
          }
        }
      : {})
  };
}

// Numeric positions match the pinned SDK 0.30.4 generated enums.
const ROUTES = ["accessibility", "synthetic_events", "global_input", "system_api", "dom", "trusted_input"] as const;
const EFFECTS = ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"] as const;
const DELIVERY_MODES = ["background", "foreground", "not_applicable", "unknown"] as const;
const ESCALATION_TARGETS = ["pixel", "foreground", "page", "session"] as const;
const ESCALATION_REASONS = ["route_unavailable", "delivery_failed", "effect_unconfirmed", "suspected_noop", "permission_required"] as const;

function driverEnum<T extends string>(value: unknown, values: readonly T[], name: string): T {
  const normalized = typeof value === "number" && Number.isInteger(value) ? values[value] : value;
  if (typeof normalized !== "string" || !values.includes(normalized as T)) {
    throw new ComputerError("invalid_driver_result", "invalid driver " + name, "unknown");
  }
  return normalized as T;
}

/** Normalize generic snake_case JSON and typed SDK numeric enums without
 * loading the SDK. Keep machine metadata; omit arbitrary application text. */
export function parseActionResult(value: unknown): ActionResult | undefined {
  const tool = asRecord(value);
  if (!tool) return undefined;
  const raw = parseStructuredObject(tool.structuredJson as string | undefined) ?? asRecord(tool.action) ?? tool;
  if (raw.route === undefined && raw.effect === undefined) return undefined;
  const result: ActionResult = {
    route: driverEnum(raw.route, ROUTES, "route"),
    effect: driverEnum(raw.effect, EFFECTS, "effect")
  };
  if (raw.delivery != null) {
    const delivery = asRecord(raw.delivery);
    if (!delivery) throw new ComputerError("invalid_driver_result", "invalid driver delivery", "unknown");
    const count = delivery.delivered_count !== undefined ? delivery.delivered_count : delivery.deliveredCount;
    if (count != null && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
      throw new ComputerError("invalid_driver_result", "invalid driver delivered count", "unknown");
    }
    result.delivery = {
      mode: driverEnum(delivery.mode, DELIVERY_MODES, "delivery mode"),
      ...(count !== undefined ? { deliveredCount: count as number | null } : {})
    };
  }
  if (raw.escalation != null) {
    const escalation = asRecord(raw.escalation);
    result.escalation = {
      target: driverEnum(escalation?.target, ESCALATION_TARGETS, "escalation target"),
      reason: driverEnum(escalation?.reason, ESCALATION_REASONS, "escalation reason")
    };
  }
  if (raw.error != null) {
    const error = asRecord(raw.error);
    if (typeof error?.code !== "string" || !/^[a-z0-9_]{1,128}$/i.test(error.code)) {
      throw new ComputerError("invalid_driver_result", "invalid driver refusal code", "unknown");
    }
    result.error = { code: error.code };
  }
  return result;
}
