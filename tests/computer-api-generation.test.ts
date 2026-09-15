import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// The generated api.d.ts must (a) regenerate byte-identically from sources,
// (b) contain the agentic surface, and (c) actually COMPILE — generation
// success is not API validity. The compile check uses the repo's tsc with
// skipLibCheck=false on a fixture that imports and uses the new types.

const apiPath = resolve("skills/computer-e2e/references/api.d.ts");

describe("api.d.ts generation (agentic surface)", () => {
  test("regenerating produces exactly the committed reference (no drift, no workspace mutation)", () => {
    const before = readFileSync(apiPath, "utf8");
    const tmp = mkdtempSync(join(tmpdir(), "cu-api-"));
    try {
      const out = join(tmp, "api.d.ts");
      execFileSync(process.execPath, ["scripts/generate-computer-e2e-api.ts", "--out", out], {
        stdio: "pipe"
      });
      expect(readFileSync(out, "utf8")).toBe(before);
    } finally {
      spawnSync("rm", ["-rf", tmp]);
    }
    expect(before).toBe(readFileSync(apiPath, "utf8"));
  });

  test("the agentic surface is present: observe, batch, point click, conditions", () => {
    const api = readFileSync(apiPath, "utf8");
    for (const fragment of [
      "export interface Observation ",
      "export type BatchAction =",
      "export interface PointClick ",
      "export type Condition =",
      "click_point",
      "focused_element",
      "export interface ActionReceipt ",
      "export interface BatchResult ",
      "export interface ImageGeometry ",
      "export interface ObserveOptions "
    ]) {
      expect(api.includes(fragment)).toBe(true);
    }
    // Internal shapes must never leak into the consumer reference.
    expect(api.includes("NativeObservationLike")).toBe(false);
    expect(api.includes("Backend")).toBe(false);
  });

  test("the generated declarations compile with skipLibCheck=false and are usable", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cu-api-compile-"));
    try {
      writeFileSync(join(tmp, "api.d.ts"), readFileSync(apiPath));
      writeFileSync(
        join(tmp, "fixture.ts"),
        [
          'import type { BatchAction, BatchRequest, Observation, PointClick, Condition, Selector, ObserveOptions, BatchResult, ActionReceipt, ImageGeometry } from "./api.d.ts";',
          "export const selector: Selector = { text: 'Search', match: 'exact', role: 'AXTextField' };",
          "export const condition: Condition = { kind: 'element_exists', selector };",
          "export const actions: BatchAction[] = [",
          "  { kind: 'click', selector },",
          "  { kind: 'click_point', point: { observationId: '01234567-89ab-cdef-0123-456789abcdef', x: 10, y: 20 } },",
          "  { kind: 'type', text: 'penguin', before: condition },",
          "  { kind: 'wait', condition: { kind: 'window_exists' }, timeoutMs: 3000 },",
          "];",
          "export const request: BatchRequest = { actions, observe: { mode: 'both', maxDimension: 1600 }, timeoutMs: 30000 };",
          "export const receiptStatus: ActionReceipt['status'] = 'delivered';",
          "export function geometryWidth(g: ImageGeometry): number { return g.sourceWidth; }",
          "export function firstStatus(r: BatchResult): ActionReceipt['status'] | undefined { return r.steps[0]?.status; }",
          "export const click: PointClick = { observationId: '01234567-89ab-cdef-0123-456789abcdef', x: 1, y: 1 };",
          "export const opts: ObserveOptions = { mode: 'auto' };",
          "export type ObsView = Observation;"
        ].join("\n")
      );
      execFileSync(
        process.execPath,
        [
          resolve("node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--skipLibCheck",
          "false",
          "--strict",
          "--target",
          "es2022",
          "--moduleResolution",
          "bundler",
          "--module",
          "esnext",
          join(tmp, "fixture.ts")
        ],
        { stdio: "pipe", encoding: "utf8" }
      );
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      throw new Error(`tsc fixture compile failed (status ${e.status}): stdout=${e.stdout} stderr=${e.stderr}`);
    } finally {
      spawnSync("rm", ["-rf", tmp]);
    }
  });
});
