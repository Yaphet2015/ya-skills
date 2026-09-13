// Action execution: unique element match, exactly-one stale retry, delivery
// honesty. Reuses the semantics verified in cowork-e2e but is Cowork-free.

import type { AxElement } from "./observe.js";

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface ClickDeps {
  snapshot(): Promise<AxElement[]>;
  click(elementToken: string): Promise<void>;
}

// Real DriverError.Tool carries the code in errorCode/inner.errorCode; its
// String() is just 'Error: DriverError.Tool', so match the FIELD.
function refusalCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const rec = e as { errorCode?: unknown; inner?: { errorCode?: unknown } | null };
  if (typeof rec.errorCode === "string") return rec.errorCode;
  if (rec.inner && typeof rec.inner.errorCode === "string") return rec.inner.errorCode;
  return undefined;
}

export async function clickWith(
  deps: ClickDeps,
  matches: (e: AxElement) => boolean,
  what: string
): Promise<void> {
  // One bounded retry for stale-token refusals only: the action was never
  // delivered, so retry is recovery, NOT replay. Anything else fails now.
  for (let attempt = 0; ; attempt++) {
    const elements = await deps.snapshot();
    const hits = elements.filter(matches);
    if (hits.length !== 1) {
      throw new Error(`expected exactly one ${what}, found ${hits.length}`);
    }
    const target = hits[0]!;
    if (!target.elementToken) {
      throw new Error(`${what} matched but carries no elementToken — AX projection incomplete`);
    }
    try {
      await deps.click(target.elementToken);
      return;
    } catch (e) {
      if (attempt === 0 && refusalCode(e) === "stale_element_token") continue;
      throw e;
    }
  }
}

export function clickPredicate(click: { kind: "text" | "contains"; text: string; role?: string }) {
  const base =
    click.kind === "text"
      ? (e: AxElement) => {
          const t = normalizeText(click.text);
          return (
            (e.label != null && normalizeText(e.label) === t) ||
            (e.value != null && e.value !== "" && normalizeText(e.value) === t)
          );
        }
      : (e: AxElement) => {
          const f = click.text.toLowerCase();
          return e.label != null && e.label.toLowerCase().includes(f);
        };
  if (click.role === undefined) return base;
  return (e: AxElement) => e.role === click.role && base(e);
}
