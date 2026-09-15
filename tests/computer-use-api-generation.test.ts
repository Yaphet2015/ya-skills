import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The generated computer-use api.d.ts must regenerate byte-identically,
// carry the exec surface, and COMPILE against a fixture script that uses it.

const apiPath = resolve("skills/computer-use/references/api.d.ts");

describe("computer-use api.d.ts generation (C4)", () => {
  test("regenerating produces exactly the committed reference", () => {
    const before = readFileSync(apiPath, "utf8");
    const tmp = mkdtempSync(join(tmpdir(), "cu-use-api-"));
    try {
      const out = join(tmp, "api.d.ts");
      execFileSync(process.execPath, ["scripts/generate-computer-use-api.ts", "--out", out], {
        stdio: "pipe"
      });
      expect(readFileSync(out, "utf8")).toBe(before);
    } finally {
      spawnSync("rm", ["-rf", tmp]);
    }
    expect(before).toBe(readFileSync(apiPath, "utf8"));
  });

  test("the exec surface is present; wire internals are absent", () => {
    const api = readFileSync(apiPath, "utf8");
    for (const fragment of [
      "export interface ScriptComputer ",
      "export interface ExecResult ",
      "export type JsonValue",
      "clickPoint(point: PointClick): Promise<void>;",
      "wait(condition: Condition, timeoutMs: number): Promise<void>;",
      "stateCommitted: boolean;"
    ]) {
      expect(api.includes(fragment)).toBe(true);
    }
    for (const forbidden of ["ScriptRpcRequest", "ScriptRpcReply", "Backend", "NativeObservation", "@ya-skills/"]) {
      expect(api.includes(forbidden)).toBe(false);
    }
  });

  test("a typed exec-script fixture compiles against the api", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cu-use-api-compile-"));
    try {
      writeFileSync(join(tmp, "api.d.ts"), readFileSync(apiPath));
      writeFileSync(
        join(tmp, "fixture.ts"),
        [
          'import type { ScriptComputer, ExecResult, Selector, Condition, BatchRequest, Observation } from "./api.d.ts";',
          "// simulate the injected parameters of an exec script body",
          "declare const computer: ScriptComputer;",
          "declare const state: Record<string, number>;",
          "declare function log(value: unknown): void;",
          "declare function observe(options?: { mode?: 'auto' | 'ax' | 'image' | 'both' }): Promise<Observation>;",
          "export async function main(): Promise<ExecResult['status']> {",
          "  const selector: Selector = { text: 'Search', match: 'exact', role: 'AXTextField' };",
          "  const ready: Condition = { kind: 'element_exists', selector };",
          "  await computer.click(selector);",
          "  await computer.type('penguin');",
          "  await computer.key('Return');",
          "  await computer.wait(ready, 3000);",
          "  const batch: BatchRequest = { actions: [{ kind: 'key', key: 'Tab' }] };",
          "  await computer.batch(batch);",
          "  const view = await observe({ mode: 'auto' });",
          "  state.counts = (state.counts ?? 0) + 1;",
          "  log({ title: view.title });",
          "  return 'completed';",
          "}"
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
    } finally {
      spawnSync("rm", ["-rf", tmp]);
    }
  });

  test("the example script exists next to the reference", () => {
    const example = readFileSync(resolve("skills/computer-use/examples/search.js"), "utf8");
    expect(example).toContain("await computer.click");
    expect(example).toContain("state.searches");
  });
});
