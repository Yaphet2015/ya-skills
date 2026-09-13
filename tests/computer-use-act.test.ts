import { describe, expect, test } from "bun:test";
import {
  selectWindow,
  sanitizeElements
} from "@ya-skills/functions-computer-use";
import { clickWith, createComputerUseCommands, normalizeText } from "@ya-skills/functions-computer-use";

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

describe("act error envelopes", () => {
  const commands = (runReal: (req: unknown) => Promise<string>) =>
    createComputerUseCommands({ runReal: runReal as never });

  test("a timeout on act reports actionOutcome unknown and forbids replay", async () => {
    const act = commands(async () => {
      throw new Error("command timed out after 30000ms");
    }).find((c) => c.action === "act")!;
    const error = await Promise.resolve(act.run(["--pid", "1", "--type", "hi"])).then(
      () => null,
      (e: Error) => e
    );
    const body = JSON.parse(error!.message) as {
      error: { code: string; actionOutcome: string; nextStep: string };
    };
    expect(body.error.code).toBe("command_timeout");
    expect(body.error.actionOutcome).toBe("unknown");
    expect(body.error.nextStep).toMatch(/perceive/);
    expect(body.error.nextStep).toMatch(/do NOT repeat/);
  });

  test("a timeout on perceive stays a plain timeout, not an act-outcome error", async () => {
    const perceive = commands(async () => {
      throw new Error("command timed out after 30000ms");
    }).find((c) => c.action === "perceive")!;
    const error = await Promise.resolve(perceive.run(["--pid", "1"])).then(
      () => null,
      (e: Error) => e
    );
    expect(error!.message).toBe("command timed out after 30000ms");
  });

  test("non-timeout act errors pass through untouched", async () => {
    const act = commands(async () => {
      throw new Error('{"error":{"code":"degraded_snapshot"}}');
    }).find((c) => c.action === "act")!;
    const error = await Promise.resolve(act.run(["--pid", "1", "--key", "Return"])).then(
      () => null,
      (e: Error) => e
    );
    expect(JSON.parse(error!.message).error.code).toBe("degraded_snapshot");
  });
});

describe("artifact output rules", () => {
  test("default cache dir is user-scoped, files private, relative --out-dir becomes absolute", async () => {
    const { ensureOutDir, saveScreenshot, defaultArtifactsDir } = await import("@ya-skills/functions-computer-use");
    expect(defaultArtifactsDir()).toContain("Library/Caches/ya-skills/computer-use");
    const dir = ensureOutDir();
    const file = saveScreenshot(dir, Buffer.from("screenshot-bytes").toString("base64"));
    expect(await Bun.file(file).text()).toBe("screenshot-bytes");
    const mode = (await Bun.file(file).stat()).mode! & 0o777;
    expect(mode.toString(8)).toBe("600");
    const rel = ensureOutDir("rel-dir");
    expect(rel.startsWith("/")).toBe(true);
    await Bun.$`rm -rf ${dir} ${rel}`;
  });
});
