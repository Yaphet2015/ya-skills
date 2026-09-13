#!/usr/bin/env bun
// Generates skills/computer-e2e/references/api.d.ts from the workspace type
// sources so the installed Skill carries exactly the consumer surface — no
// hand-maintained copy that can drift. Dev tooling only: consumers never run
// this and never need typescript installed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RUNTIME_TYPES = join(root, "packages/computer-runtime/src/types.ts");
const E2E_TYPES = join(root, "packages/functions-computer-e2e/src/types.ts");
const CONTEXT_TYPES = join(root, "packages/functions-computer-e2e/src/context.ts");
const outArg = process.argv.indexOf("--out");
const OUT = outArg !== -1 ? resolve(process.argv[outArg + 1]!) : join(root, "skills/computer-e2e/references/api.d.ts");

// The consumer surface: everything a .e2e.ts file can reference.
const RUNTIME_SURFACE = ["Target", "WindowRef", "AppRef", "AxElement", "Snapshot", "Predicate", "ScrollDirection", "ScrollSpec", "Computer"];
const E2E_SURFACE = ["CaseStatus", "CaseContext", "TestCase", "Suite", "ApplicationInfo"];

function extractDeclarations(source: string): Map<string, string> {
  const decls = new Map<string, string>();
  const lines = source.split("\n");
  let current: string | null = null;
  let depth = 0;
  let buffer: string[] = [];
  const flush = () => {
    if (current === null) return;
    const match = /export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/.exec(current);
    if (match) decls.set(match[1]!, buffer.join("\n"));
    current = null;
    buffer = [];
    depth = 0;
  };
  for (const line of lines) {
    if (current === null) {
      if (!line.startsWith("export ")) continue;
      current = line;
      buffer = [line];
      depth = (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (depth <= 0 && /;\s*$/.test(line)) flush();
      continue;
    }
    buffer.push(line);
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (depth <= 0) flush();
  }
  flush();
  return decls;
}

const runtime = extractDeclarations(readFileSync(RUNTIME_TYPES, "utf8"));
const e2e = extractDeclarations(readFileSync(E2E_TYPES, "utf8"));
const context = extractDeclarations(readFileSync(CONTEXT_TYPES, "utf8"));

const missing = [
  ...RUNTIME_SURFACE.filter((name) => !runtime.has(name)).map((n) => `computer-runtime:${n}`),
  ...E2E_SURFACE.filter((name) => !e2e.has(name) && !context.has(name)).map((n) => `functions-computer-e2e:${n}`)
];
if (missing.length > 0) {
  console.error(`surface declarations missing from sources: ${missing.join(", ")}`);
  process.exit(1);
}

const header = [
  "// GENERATED from packages/computer-runtime/src/types.ts and",
  "// packages/functions-computer-e2e/src/{types,context}.ts — do not edit.",
  "// Regenerate with: bun scripts/generate-computer-e2e-api.ts",
  "// The type reference for .e2e.ts suites (apiVersion 1). TypeScript is",
  "// transpile-only at runtime; these declarations are editor support.",
  ""
].join("\n");

const sections = [
  "// shared desktop surface ------------------------------------------------",
  ...RUNTIME_SURFACE.map((name) => runtime.get(name)!),
  "",
  "// suite contract ---------------------------------------------------------",
  ...E2E_SURFACE.map((name) => e2e.get(name) ?? context.get(name)!)
].join("\n");

const output = `${header}${sections}\n`;

for (const forbidden of ["@ya-skills/", "@trycua/", "Backend", "BackendFactory", "WorkerEvent"]) {
  if (output.includes(forbidden)) {
    console.error(`generated api.d.ts still references internal '${forbidden}' — extend the strip/allowlist`);
    process.exit(1);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, output);
console.log(`generated ${OUT} (${RUNTIME_SURFACE.length + E2E_SURFACE.length} declarations)`);
