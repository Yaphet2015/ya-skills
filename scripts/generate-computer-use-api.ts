#!/usr/bin/env bun
// Generates skills/computer-use/references/api.d.ts — the typed surface a
// computer-use exec script sees. Types come from the workspace sources so
// the installed skill carries exactly the product surface (no hand-kept
// copy). Dev tooling only.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RUNTIME_TYPES = join(root, "packages/computer-runtime/src/types.ts");
const EXEC_TYPES = join(root, "packages/computer-session/src/exec-types.ts");
const outArg = process.argv.indexOf("--out");
const OUT =
  outArg !== -1 ? resolve(process.argv[outArg + 1]!) : join(root, "skills/computer-use/references/api.d.ts");

// The script-facing surface. Selector/Condition/etc. are the same types the
// batch CLI and the E2E suites use — one SSOT in computer-runtime.
const RUNTIME_SURFACE = [
  "Rect",
  "Point",
  "ScrollDirection",
  "Selector",
  "Condition",
  "PointClick",
  "ScrollSpec",
  "ObserveOptions",
  "Observation",
  "ImageGeometry",
  "AxChannel",
  "ImageChannel",
  "AxElement",
  "ChannelStatus",
  "ObservationMode",
  "BatchAction",
  "BatchRequest",
  "BatchResult",
  "ActionReceipt",
  "Target"
];
const EXEC_SURFACE = ["JsonValue", "ScriptComputer", "ExecResult", "ExecOptions"];

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
    if (depth <= 0 && (/;\s*$/.test(line) || line.trim() === "}")) flush();
  }
  flush();
  return decls;
}

const runtime = extractDeclarations(readFileSync(RUNTIME_TYPES, "utf8"));
const exec = extractDeclarations(readFileSync(EXEC_TYPES, "utf8"));

const missing = [
  ...RUNTIME_SURFACE.filter((name) => !runtime.has(name)).map((n) => `computer-runtime:${n}`),
  ...EXEC_SURFACE.filter((name) => !exec.has(name)).map((n) => `computer-session/exec-types:${n}`)
];
if (missing.length > 0) {
  console.error(`surface declarations missing from sources: ${missing.join(", ")}`);
  process.exit(1);
}

// exec-types imports runtime types via `import ... from "@ya-skills/computer-runtime"`;
// in the generated single file those become local — rewrite the references.
const stripRuntimeImport = (decl: string): string =>
  decl.replace(/import\([^)]*\)\./g, "").replace(/@ya-skills\/computer-runtime/g, "");

const header = [
  "// GENERATED from packages/computer-runtime/src/types.ts and",
  "// packages/computer-session/src/exec-types.ts — do not edit.",
  "// Regenerate with: bun scripts/generate-computer-use-api.ts",
  "// The type reference for computer-use exec scripts (async-function body).",
  ""
].join("\n");

const body = [
  "// shared desktop surface ------------------------------------------------",
  ...RUNTIME_SURFACE.map((name) => runtime.get(name)!),
  "",
  "// exec script surface ---------------------------------------------------",
  ...EXEC_SURFACE.map((name) => stripRuntimeImport(exec.get(name)!))
].join("\n");

const output = `${header}${body}\n`;

for (const forbidden of ["@ya-skills/", "@trycua/", "Backend", "NativeObservation", "ScriptRpcRequest", "ScriptRpcReply"]) {
  if (output.includes(forbidden)) {
    console.error(`generated api.d.ts still references internal '${forbidden}' — extend the strip/allowlist`);
    process.exit(1);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, output);
console.log(`generated ${OUT} (${RUNTIME_SURFACE.length + EXEC_SURFACE.length} declarations)`);
