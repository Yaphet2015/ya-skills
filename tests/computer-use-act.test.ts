import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createComputerUseCommands,
  normalizeText,
  sanitizeElements,
  selectWindow
} from "@ya-skills/functions-computer-use";

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
  // Writes only inside a mkdtemp dir — never the user's real cache dir or the
  // repo cwd; the default cache location is a string assertion only.
  test("default cache dir is user-scoped, files private, relative --out-dir becomes absolute", async () => {
    const { ensureOutDir, saveScreenshot, defaultArtifactsDir } = await import("@ya-skills/functions-computer-use");
    expect(defaultArtifactsDir()).toContain("Library/Caches/ya-skills/computer-use");
    const temp = await mkdtemp(join(tmpdir(), "yk-artifacts-"));
    try {
      const dir = ensureOutDir(join(temp, "nested"));
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      const file = saveScreenshot(dir, Buffer.from("screenshot-bytes").toString("base64"));
      expect(await Bun.file(file).text()).toBe("screenshot-bytes");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(file.startsWith(temp)).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
