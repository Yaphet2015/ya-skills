import { describe, expect, test } from "bun:test";
import {
  selectWindow,
  sanitizeElements
} from "@ya-skills/functions-computer-use";
import { clickWith, normalizeText } from "@ya-skills/functions-computer-use";

const win = (windowId: bigint, title: string) => ({ pid: 10, windowId, title });

describe("window selection", () => {
  test("ambiguity cannot send an action to a different document", () => {
    const windows = [win(1n, "A"), win(2n, "B")];
    expect(() => selectWindow(windows)).toThrow(/window/i);
    expect(selectWindow(windows, 2n).title).toBe("B");
  });

  test("no windows is an explicit error, not a silent success", () => {
    expect(() => selectWindow([])).toThrow(/no .*window/i);
  });

  test("requested window id must exist", () => {
    expect(() => selectWindow([win(1n, "A")], 9n)).toThrow(/9/i);
  });

  test("a single window resolves without --window", () => {
    expect(selectWindow([win(7n, "only")]).windowId).toBe(7n);
  });
});

describe("element privacy", () => {
  test("password values are stripped from every output path", () => {
    const out = sanitizeElements([
      { role: "AXTextField", label: "Password", value: "hunter2" },
      { role: "AXStaticText", label: "hello", value: "hello" }
    ]);
    expect(out[0]!.value).toBeUndefined();
    expect(out[0]!.label).toBe("Password");
    expect(out[1]!.value).toBe("hello");
  });
});

describe("normalizeText", () => {
  test("collapses whitespace for stable matching", () => {
    expect(normalizeText("  New\n  session ")).toBe("New session");
  });
});

describe("clickWith", () => {
  const element = (over: Partial<Parameters<typeof Object>[0]> = {}) => ({
    role: "AXButton",
    label: "OK",
    elementToken: "tok-1",
    ...over
  });

  test("unique match clicks exactly once", async () => {
    const clicks: string[] = [];
    let snapshots = 0;
    await clickWith(
      {
        snapshot: () => {
          snapshots++;
          return Promise.resolve([element(), element({ label: "Cancel" })]);
        },
        click: async (token) => {
          clicks.push(token);
        }
      },
      (e) => e.label === "OK",
      "click OK"
    );
    expect(clicks).toEqual(["tok-1"]);
    expect(snapshots).toBe(1);
  });

  test("zero matches fail loudly with a count", async () => {
    await expect(
      clickWith(
        { snapshot: () => Promise.resolve([element({ label: "Cancel" })]), click: async () => {} },
        (e) => e.label === "OK",
        "click OK"
      )
    ).rejects.toThrow(/found 0/);
  });

  test("multiple matches fail loudly — never click the first", async () => {
    const clicks: string[] = [];
    await expect(
      clickWith(
        {
          snapshot: () => Promise.resolve([element(), element({ elementToken: "tok-2" })]),
          click: async (token) => {
            clicks.push(token);
          }
        },
        () => true,
        "click OK"
      )
    ).rejects.toThrow(/found 2/);
    expect(clicks).toEqual([]);
  });

  test("one stale-token refusal retries exactly once and succeeds", async () => {
    const clicks: string[] = [];
    let snapshots = 0;
    let refused = false;
    await clickWith(
      {
        snapshot: () => {
          snapshots++;
          return Promise.resolve([element({ elementToken: `tok-${snapshots}` })]);
        },
        click: async (token) => {
          if (!refused) {
            refused = true;
            const err = new Error("stale") as Error & { errorCode?: string };
            err.errorCode = "stale_element_token";
            throw err;
          }
          clicks.push(token);
        }
      },
      () => true,
      "click OK"
    );
    expect(clicks).toEqual(["tok-2"]);
    expect(snapshots).toBe(2);
  });

  test("two stale-token refusals fail — the window is re-rendering", async () => {
    await expect(
      clickWith(
        {
          snapshot: () => Promise.resolve([element()]),
          click: async () => {
            const err = new Error("stale") as Error & { errorCode?: string };
            err.errorCode = "stale_element_token";
            throw err;
          }
        },
        () => true,
        "click OK"
      )
    ).rejects.toThrow(/stale/i);
  });

  test("non-stale driver errors never retry", async () => {
    let attempts = 0;
    await expect(
      clickWith(
        {
          snapshot: () => Promise.resolve([element()]),
          click: async () => {
            attempts++;
            throw new Error("permission denied");
          }
        },
        () => true,
        "click OK"
      )
    ).rejects.toThrow(/permission denied/);
    expect(attempts).toBe(1);
  });

  test("a match without an elementToken fails instead of clicking undefined", async () => {
    let clicks = 0;
    await expect(
      clickWith(
        {
          snapshot: () => Promise.resolve([element({ elementToken: undefined })]),
          click: async () => {
            clicks++;
          }
        },
        () => true,
        "click OK"
      )
    ).rejects.toThrow(/elementToken/i);
    expect(clicks).toBe(0);
  });
});
