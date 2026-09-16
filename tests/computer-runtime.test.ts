import { describe, expect, test } from "bun:test";
import { clickUnique, waitForElements, DEFAULT_INTERVAL_MS } from "../packages/computer-runtime/src/actions.js";
import { normalizeElements, sanitizeElements, selectWindow } from "../packages/computer-runtime/src/observe.js";
import { ComputerError, createSessionWithBackend } from "../packages/computer-runtime/src/session.js";
import type { AxElement, Backend } from "../packages/computer-runtime/src/session.js";

// ---------------------------------------------------------------------------
// clickUnique — token discipline (ported intent from cowork-e2e act.test.ts)

class ToolRefusal extends Error {
  constructor(
    public errorCode: string,
    message: string
  ) {
    super(message);
  }
}

function el(partial: Partial<AxElement>): AxElement {
  return partial;
}

describe("clickUnique (exactly-one delivery)", () => {
  test("ambiguity never delivers", async () => {
    let deliveries = 0;
    await expect(
      clickUnique(
        {
          snapshot: async () => [
            el({ role: "AXButton", label: "Save", elementToken: "a" }),
            el({ role: "AXButton", label: "Save", elementToken: "b" })
          ],
          click: async () => {
            deliveries++;
          }
        },
        (e) => e.label === "Save",
        "save"
      )
    ).rejects.toThrow(/found 2/);
    expect(deliveries).toBe(0);
  });

  test("zero matches refuses with the description", async () => {
    let deliveries = 0;
    await expect(
      clickUnique(
        {
          snapshot: async () => [el({ role: "AXButton", label: "Other", elementToken: "x" })],
          click: async () => {
            deliveries++;
          }
        },
        (e) => e.label === "Save",
        "save button"
      )
    ).rejects.toThrow(/save button.*found 0/);
    expect(deliveries).toBe(0);
  });

  test("a match without an elementToken fails instead of clicking undefined", async () => {
    let deliveries = 0;
    await expect(
      clickUnique(
        {
          snapshot: async () => [el({ role: "AXButton", label: "Save" })],
          click: async () => {
            deliveries++;
          }
        },
        (e) => e.label === "Save",
        "save"
      )
    ).rejects.toThrow(/elementToken/);
    expect(deliveries).toBe(0);
  });

  test("two stale-token refusals stop after exactly two deliveries", async () => {
    let clicks = 0;
    let snaps = 0;
    await expect(
      clickUnique(
        {
          snapshot: async () => {
            snaps++;
            return [el({ label: "Send", elementToken: "t" })];
          },
          click: async () => {
            clicks++;
            throw new ToolRefusal("stale_element_token", "DriverError.Tool");
          }
        },
        (e) => e.label === "Send",
        "send"
      )
    ).rejects.toThrow(/DriverError.Tool/);
    expect(clicks).toBe(2);
    expect(snaps).toBe(2);
  });

  test("non-stale errors stop immediately without retry", async () => {
    let clicks = 0;
    let snaps = 0;
    await expect(
      clickUnique(
        {
          snapshot: async () => {
            snaps++;
            return [el({ label: "Send", elementToken: "t" })];
          },
          click: async () => {
            clicks++;
            throw new ToolRefusal("window_target_not_found", "DriverError.Tool");
          }
        },
        (e) => e.label === "Send",
        "send"
      )
    ).rejects.toThrow(/DriverError.Tool/);
    expect(clicks).toBe(1);
    expect(snaps).toBe(1);
  });

  test("a stale refusal in prose (string message, errorCode field absent) is NOT stale", async () => {
    let clicks = 0;
    await expect(
      clickUnique(
        {
          snapshot: async () => [el({ label: "Send", elementToken: "t" })],
          click: async () => {
            clicks++;
            throw new Error("some other error mentioning stale_element_token in prose");
          }
        },
        (e) => e.label === "Send",
        "send"
      )
    ).rejects.toThrow(/prose/);
    expect(clicks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// element projection + privacy

describe("element normalization and privacy", () => {
  test("numeric values become strings, nullish stays absent", () => {
    const out = normalizeElements([
      { role: "AXSlider", value: 42 },
      { role: "AXStaticText", label: "hi" }
    ]);
    expect(out[0]!.value).toBe("42");
    expect(out[1]!.value).toBeUndefined();
  });

  test("password field values are dropped from every output path", () => {
    const out = sanitizeElements([
      { role: "AXSecureTextField", label: "Password", value: "secret", elementToken: "p" },
      { role: "AXTextField", label: "密码", value: "秘密", elementToken: "q" },
      { role: "AXTextField", label: "Account", value: "name", elementToken: "r" }
    ]);
    expect(out[0]!.value).toBeUndefined();
    expect(out[1]!.value).toBeUndefined();
    expect(out[2]!.value).toBe("name");
  });
});

// ---------------------------------------------------------------------------
// waitForElements — postcondition polling

describe("waitForElements", () => {
  test("resolves once a fresh snapshot satisfies the predicate", async () => {
    const seq = [
      [el({ label: "A" })],
      [el({ label: "A" })],
      [el({ label: "A" }), el({ label: "Reply" })]
    ];
    let i = 0;
    const snapshot = async () => seq[Math.min(i++, seq.length - 1)]!;
    const result = await waitForElements({ snapshot }, (els) => els.some((e) => e.label === "Reply"), "reply visible", {
      timeoutMs: 5_000,
      intervalMs: 1,
      sleepFn: () => Promise.resolve()
    });
    expect(result.some((e) => e.label === "Reply")).toBe(true);
    expect(i).toBe(3);
  });

  test("only degraded_snapshot is a transient miss; other errors throw immediately", async () => {
    let calls = 0;
    const snapshot = async () => {
      calls++;
      throw new ComputerError("permission_denied", "not allowed");
    };
    await expect(
      waitForElements({ snapshot }, () => true, "stable snapshot", {
        timeoutMs: 5_000,
        intervalMs: 1,
        sleepFn: () => Promise.resolve()
      })
    ).rejects.toThrow(/not allowed/);
    expect(calls).toBe(1);
  });

  test("degraded snapshots are retried until the deadline, then rethrown", async () => {
    const snapshot = async () => {
      throw new ComputerError("degraded_snapshot", "window snapshot degraded=true");
    };
    await expect(
      waitForElements({ snapshot }, () => true, "stable snapshot", {
        timeoutMs: 30,
        intervalMs: 1,
        sleepFn: () => Promise.resolve()
      })
    ).rejects.toThrow(/degraded/);
  });

  test("default poll interval is 500ms", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(500);
  });

  test("a 60s wait may succeed at t=40s (waitFor is not capped at one 30s op)", async () => {
    let fakeNow = 1_000_000;
    let polls = 0;
    const snapshot = async () => {
      polls++;
      return fakeNow >= 1_000_000 + 40_000 ? [el({ label: "Reply" })] : [el({ label: "A" })];
    };
    const result = await waitForElements(
      { snapshot },
      (els) => els.some((e) => e.label === "Reply"),
      "reply",
      {
        timeoutMs: 60_000,
        intervalMs: 500,
        sleepFn: async (ms) => {
          fakeNow += ms;
        },
        now: () => fakeNow
      }
    );
    expect(result.some((e) => e.label === "Reply")).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  test("timeout uses the injected clock and reports the description", async () => {
    let fakeNow = 0;
    const snapshot = async () => [el({ label: "A" })];
    await expect(
      waitForElements({ snapshot }, () => false, "never happens", {
        timeoutMs: 25_000,
        intervalMs: 500,
        sleepFn: async (ms) => {
          fakeNow += ms;
        },
        now: () => fakeNow
      })
    ).rejects.toThrow(/timed out after 25000ms waiting for: never happens/);
  });
});

// ---------------------------------------------------------------------------
// session facade over a fake backend

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`unexpected backend call: ${name}`);
  };
}

function makeBackend(overrides: Partial<Backend> = {}): Backend {
  const base: Backend = {
    apps: unexpected("apps"),
    windows: unexpected("windows"),
    snapshot: unexpected("snapshot"),
    observe: unexpected("observe"),
    clickToken: unexpected("clickToken"),
    clickPoint: unexpected("clickPoint"),
    setValue: unexpected("setValue"),
    type: unexpected("type"),
    key: unexpected("key"),
    scroll: unexpected("scroll"),
    metadata: unexpected("metadata"),
    permissions: unexpected("permissions"),
    // cleanup steps are covered explicitly in the budget tests; here they
    // default to no-ops so close() stays quiet.
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined
  };
  return { ...base, ...overrides };
}

const target = { pid: 1, windowId: 2n };

describe("session facade (fake backend)", () => {
  test("type/key/scroll ToolResult.isError becomes action_refused and reports not_delivered", async () => {
    for (const method of ["type", "key", "scroll"] as const) {
      const events: string[] = [];
      const backend = makeBackend({
        [method]: async () => ({ isError: true, text: "driver refused" })
      } as Partial<Backend>);
      const session = createSessionWithBackend(
        { load: async () => ({}), create: async () => backend },
        {
          onAction: (e) => events.push(`${e.phase}:${e.kind}:${e.outcome ?? ""}`)
        }
      );
      const computer = session.computer;
      const attempt =
        method === "type"
          ? computer.type(target, "hello")
          : method === "key"
            ? computer.key(target, "Return")
            : computer.scroll(target, { direction: "down", amount: 1, x: 1, y: 1 });
      const error = await attempt.then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(ComputerError);
      expect((error as ComputerError).code).toBe("action_refused");
      expect((error as ComputerError).actionOutcome).toBe("not_delivered");
      expect(events).toEqual([`started:${method}:`, `finished:${method}:not_delivered`]);
      await session.close();
    }
  });

  test("successful actions report delivered and clean results pass through", async () => {
    const events: string[] = [];
    const backend = makeBackend({
      type: async () => ({ isError: false })
    });
    const session = createSessionWithBackend(
      { load: async () => ({}), create: async () => backend },
      { onAction: (e) => events.push(`${e.phase}:${e.kind}:${e.outcome ?? ""}`) }
    );
    await session.computer.type(target, "hi");
    expect(events).toEqual(["started:type:", "finished:type:delivered"]);
    await session.close();
  });

  test("click resolves exactly one match through the backend token", async () => {
    const tokens: string[] = [];
    const backend = makeBackend({
      snapshot: async () => ({ elements: [el({ role: "AXButton", label: "OK", elementToken: "tok-1" })], title: "" }),
      clickToken: async (_t, token) => {
        tokens.push(token);
        return { isError: false };
      }
    });
    const session = createSessionWithBackend({ load: async () => ({}), create: async () => backend }, {});
    await session.computer.click(target, (e) => e.label === "OK", "ok button");
    expect(tokens).toEqual(["tok-1"]);
    await session.close();
  });

  test("ambiguous click matches never reach the backend click", async () => {
    let clicks = 0;
    const backend = makeBackend({
      snapshot: async () => ({
        elements: [
          el({ role: "AXButton", label: "OK", elementToken: "a" }),
          el({ role: "AXButton", label: "OK", elementToken: "b" })
        ],
        title: ""
      }),
      clickToken: async () => {
        clicks++;
        return { isError: false };
      }
    });
    const session = createSessionWithBackend({ load: async () => ({}), create: async () => backend }, {});
    await expect(session.computer.click(target, (e) => e.label === "OK", "ok button")).rejects.toThrow(/found 2/);
    expect(clicks).toBe(0);
    await session.close();
  });

  test("windows and snapshot delegate to the backend unchanged", async () => {
    const backend = makeBackend({
      windows: async () => [{ pid: 1, windowId: 2n, title: "Doc" }],
      snapshot: async () => ({ elements: [el({ label: "X" })], title: "Doc" })
    });
    const session = createSessionWithBackend({ load: async () => ({}), create: async () => backend }, {});
    expect((await session.computer.windows(1))[0]!.title).toBe("Doc");
    expect((await session.computer.snapshot(target)).elements[0]!.label).toBe("X");
    await session.close();
  });

  test("selectWindow ambiguity stays an error through the shared layer", () => {
    const wins = [
      { pid: 1, windowId: 1n, title: "A" },
      { pid: 1, windowId: 2n, title: "B" }
    ];
    expect(() => selectWindow(wins)).toThrow(/ambiguous/);
    expect(selectWindow(wins, 2n).title).toBe("B");
  });
});

