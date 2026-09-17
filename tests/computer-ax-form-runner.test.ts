import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeNativeObservation } from "./helpers/computer-fixtures.js";
import { projectObservation } from "../packages/computer-runtime/src/observe.js";
import {
  assertFixtureAxObservation,
  parseAxFormArgs,
  readAxFormValues,
  readAxFormResult,
  runAxForm
} from "../scripts/probes/computer-use-ax-form.js";

describe("AX form acceptance runner guard", () => {
  test("default invocation never enables native work", () => {
    expect(parseAxFormArgs([])).toEqual({
      kind: "guarded",
      reason: "native AX form flow is opt-in; pass --allow-native --test-desktop LABEL"
    });
  });

  test("native work requires an explicit isolated desktop label", () => {
    expect(parseAxFormArgs(["--allow-native"])).toEqual({
      kind: "invalid",
      reason: "--allow-native requires --test-desktop LABEL"
    });
    expect(parseAxFormArgs(["--out-dir", "/private/tmp/ax-form"])).toEqual({
      kind: "invalid",
      reason: "native options require --allow-native; no fixture or SDK was started"
    });
  });

  test("parses the explicit native flow without importing or starting a driver", () => {
    const parsed = parseAxFormArgs([
      "--allow-native",
      "--test-desktop",
      "isolated-login-session",
      "--out-dir",
      "/private/tmp/ax-form",
      "--fixture-binary",
      "/private/tmp/ax-form-fixture",
      "--timeout-ms",
      "120000"
    ]);
    expect(parsed).toMatchObject({
      kind: "native",
      allowNative: true,
      desktopLabel: "isolated-login-session",
      outDir: "/private/tmp/ax-form",
      fixtureBinary: "/private/tmp/ax-form-fixture",
      timeoutMs: 120_000
    });
  });

  test("rejects unknown flags and unsafe timeout values before native work", () => {
    expect(parseAxFormArgs(["--allow-native", "--test-desktop", "isolated", "--unknown"])).toEqual({
      kind: "invalid",
      reason: "unknown flag: --unknown"
    });
    expect(parseAxFormArgs(["--allow-native", "--test-desktop", "isolated", "--timeout-ms", "180001"])).toEqual({
      kind: "invalid",
      reason: "--timeout-ms must be <= 180000"
    });
  });

  test("refuses an existing artifact directory without changing it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "yk-ax-form-existing-"));
    const outDir = join(parent, "run");
    const sentinel = join(outDir, "previous-report.json");
    try {
      await mkdir(outDir, { mode: 0o750 });
      await chmod(outDir, 0o750);
      await writeFile(sentinel, "previous\n", { mode: 0o640 });
      const before = await stat(outDir);
      const report = await runAxForm({
        kind: "native",
        allowNative: true,
        desktopLabel: "isolated-login-session",
        outDir,
        fixtureSource: "/private/tmp/does-not-run.swift",
        timeoutMs: 1_000
      });

      expect(report.status).toBe("failed");
      expect(report.reason).toMatch(/exclusive|already exists|artifact directory/i);
      expect(await readFile(sentinel, "utf8")).toBe("previous\n");
      expect((await stat(outDir)).mode & 0o777).toBe(before.mode & 0o777);
      expect(await Bun.file(join(outDir, "report.json")).exists()).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("AX form observation acceptance", () => {
  function realPartialObservation() {
    const raw = makeNativeObservation({
      elementsComplete: false,
      totalElementCount: 6n,
      returnedElementCount: 6n,
      elements: [
        { elementIndex: 0n, role: "AXWindow", label: "YK AX form fixture", elementToken: "s00000001:0" },
        { elementIndex: 1n, role: "AXTextField", label: "Name", value: "Ada Lovelace", elementToken: "s00000001:1" },
        { elementIndex: 2n, role: "AXTextField", label: "Email", value: "ada@example.test", elementToken: "s00000001:2" },
        { elementIndex: 3n, role: "AXTextField", label: "Message", value: "AX form submission", elementToken: "s00000001:3" },
        { elementIndex: 4n, role: "AXButton", label: "Submit AX form", elementToken: "s00000001:4" },
        { elementIndex: 5n, role: "AXStaticText", label: "AX form result", value: "submitted", elementToken: "s00000001:5" }
      ]
    });
    // The native tree markdown includes the non-indexed static labels. The
    // structured rows above intentionally contain only the indexed elements,
    // matching the real SDK projection.
    return projectObservation({
      ...raw,
      treeMarkdown: '- AXStaticText = "Name" (Name label)\n- [1] AXTextField (Name)'
    } as typeof raw & { treeMarkdown: string }, { mode: "ax" });
  }

  test("accepts the real equal-count incomplete AX projection", () => {
    const observation = realPartialObservation();

    expect(observation.ax).toMatchObject({
      status: "truncated",
      reason: "elements_incomplete",
      total: 6,
      returned: 6,
      complete: false
    });
    expect(observation.ax.elements.some((element) => element.label === "Name label")).toBe(false);
    expect(() => assertFixtureAxObservation(observation)).not.toThrow();
    expect(readAxFormValues(observation)).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.test",
      message: "AX form submission"
    });
    expect(readAxFormResult(observation)).toBe("submitted");
  });

  test("rejects degraded, explicitly truncated, and unequal-count views", () => {
    const cases = [
      projectObservation(makeNativeObservation({ degraded: true, degradedReason: "ax_partial" }), { mode: "ax" }),
      projectObservation(makeNativeObservation({
        elementsComplete: false,
        truncated: true,
        truncationReason: "max_elements",
        totalElementCount: 6n,
        returnedElementCount: 6n
      }), { mode: "ax" }),
      projectObservation(makeNativeObservation({
        elementsComplete: false,
        totalElementCount: 6n,
        returnedElementCount: 5n
      }), { mode: "ax" })
    ];

    for (const observation of cases) {
      expect(() => assertFixtureAxObservation(observation)).toThrow(/not acceptable/);
    }
  });
});
