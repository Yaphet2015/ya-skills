import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// Desktop-free guard tests for the agentic native probe
// (desktop plan Task A1). The probe's native acquisition path is NOT
// exercised here: these tests only pin the guard contract — no target means
// no driver, no --allow-input means no input, and the report projection
// cannot leak element contents. Real-window behavior stays opt-in elsewhere.

import {
  driverMustStart,
  inputAuthorized,
  parseProbeArgs,
  projectWindowState,
  projectDriverError
} from "../scripts/probes/computer-use-agentic.js";

describe("probe arg guard (parseProbeArgs)", () => {
  test("no arguments is a valid no-target run that must not start the driver", () => {
    const request = parseProbeArgs([]);
    expect(request.kind).toBe("no-target");
    expect(driverMustStart(request)).toBe(false);
    expect(inputAuthorized(request)).toBe(false);
  });

  test("--help is usage, never a driver start", () => {
    const request = parseProbeArgs(["--help"]);
    expect(request.kind).toBe("usage");
    expect(driverMustStart(request)).toBe(false);
  });

  test("a target requests the driver; without --allow-input it stays read-only", () => {
    const request = parseProbeArgs(["--pid", "50447", "--window", "12850"]);
    expect(request).toEqual({
      kind: "target",
      pid: 50447,
      windowId: 12850n,
      inputAuthorized: false,
      maxDimension: undefined
    });
    expect(driverMustStart(request)).toBe(true);
    expect(inputAuthorized(request)).toBe(false);
    if (request.kind === "target") expect(request.click).toBeUndefined();
  });

  test("--allow-input authorizes input and accepts window-target click coordinates", () => {
    const request = parseProbeArgs([
      "--pid", "50447", "--window", "12850", "--allow-input",
      "--click-x", "10", "--click-y", "20"
    ]);
    expect(request.kind).toBe("target");
    expect(driverMustStart(request)).toBe(true);
    expect(inputAuthorized(request)).toBe(true);
    if (request.kind === "target") expect(request.click).toEqual({ x: 10, y: 20 });
  });

  test("click coordinates without --allow-input are rejected before any driver work", () => {
    const request = parseProbeArgs(["--pid", "1", "--window", "2", "--click-x", "1", "--click-y", "1"]);
    expect(request.kind).toBe("invalid");
    expect(driverMustStart(request)).toBe(false);
    if (request.kind === "invalid") expect(request.reason).toMatch(/allow-input/);
  });

  test("--allow-input without a target is rejected", () => {
    const request = parseProbeArgs(["--allow-input"]);
    expect(request.kind).toBe("invalid");
    if (request.kind === "invalid") expect(request.reason).toMatch(/--pid.*--window|--window.*--pid|target/);
  });

  test.each([
    ["--pid", "1"],
    ["--window", "5"],
    ["--pid", "x", "--window", "5"],
    ["--pid", "1", "--window", "abc"],
    ["--pid", "0", "--window", "5"],
    ["--pid", "1", "--window", "-3"],
    ["--pid", "1", "--window", "5", "--max-dimension", "0"],
    ["--pid", "1", "--window", "5", "--totally-unknown"]
  ])("%j is invalid and never starts the driver", (...argv) => {
    const request = parseProbeArgs(argv as string[]);
    expect(request.kind).toBe("invalid");
    expect(driverMustStart(request)).toBe(false);
  });
});

describe("probe report projection (privacy allowlist)", () => {
  test("driver errors retain their structured code without copying inner content", () => {
    const error = Object.assign(new Error("DriverError.Tool"), {
      tag: "Tool",
      inner: { errorCode: "px_capture_unavailable", message: "private application content", arbitrary: "private extra field" }
    });
    const report = projectDriverError(error);
    expect(report).toEqual({ raw: "Error: DriverError.Tool", errorCode: "px_capture_unavailable" });
    expect(JSON.stringify(report)).not.toContain("private");
    expect(projectDriverError(new Error("unclassified"))).toEqual({ raw: "Error: unclassified" });
  });

  test("projects geometry, scale, pixel size, and frame validity only", () => {
    const report = projectWindowState({
      pid: 1,
      windowId: 2n,
      snapshotId: "snap-1",
      windowTitle: "Probe",
      screenshotWidth: 2880,
      screenshotHeight: 1800,
      screenshotScale: 2,
      screenshotMimeType: "image/png",
      screenshotFrameValid: true,
      windowBounds: { x: 80, y: 40, width: 1440, height: 900 },
      elementsComplete: false,
      degraded: false,
      truncated: true,
      truncationReason: "max_elements",
      totalElementCount: 900n,
      returnedElementCount: 100n,
      filteredElementCount: 100n,
      images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
      elements: [{ elementIndex: 0n, role: "AXTextField", label: "Password", value: "hunter2", depth: 3 }]
    });
    expect(report).toEqual({
      snapshotId: "snap-1",
      windowTitle: "Probe",
      screenshot: { width: 2880, height: 1800, scale: 2, mimeType: "image/png", frameValid: true },
      windowBounds: { x: 80, y: 40, width: 1440, height: 900 },
      ax: { complete: false, total: 900, returned: 100, degraded: false, degradedReason: undefined, truncated: true, truncationReason: "max_elements" }
    });
  });

  test("never emits elements, labels, values, markdown, or image bytes", () => {
    const report = projectWindowState({
      pid: 1,
      windowId: 2n,
      treeMarkdown: "# secret tree",
      elements: [
        { elementIndex: 0n, role: "AXSecureTextField", label: "Password", value: "hunter2", depth: 1 },
        { elementIndex: 1n, role: "AXStaticText", label: "bank balance 9,999", depth: 2 }
      ],
      images: [{ mimeType: "image/png", dataBase64: "iVBORsupersecretbytes" }],
      windowBounds: { x: 0, y: 0, width: 100, height: 100 }
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("bank balance");
    expect(serialized).not.toContain("secret tree");
    expect(serialized).not.toContain("iVBORsupersecretbytes");
    expect(serialized).not.toContain("Password");
  });
});

describe("probe CLI desktop-free behavior", () => {
  test("running without a target exits 0 and reports driverStarted:false", async () => {
    const proc = spawn(process.execPath, [resolve("scripts/probes/computer-use-agentic.ts")], {
      env: process.env
    });
    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    const exitCode = await new Promise<number>((resolveExit) => proc.on("exit", resolveExit));
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(report.mode).toBe("no-target");
    expect(report.driverStarted).toBe(false);
  });

  test("click coordinates without --allow-input exit non-zero with the guard reason", async () => {
    const proc = spawn(
      process.execPath,
      [resolve("scripts/probes/computer-use-agentic.ts"), "--pid", "1", "--window", "2", "--click-x", "1", "--click-y", "1"],
      { env: process.env }
    );
    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    const exitCode = await new Promise<number>((resolveExit) => proc.on("exit", resolveExit));
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/allow-input/);
  });
});
