import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAuthoring, initWorkspace } from "../packages/functions-pbench/src/authoring.js";
import type { SessionSource } from "../packages/functions-pbench/src/adapters/types.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pbench-authoring-${prefix}-`));
  cleanup.push(path);
  return path;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("authoring captures through an injected registered session source", async () => {
  const repo = await temp("repo");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "pbench@example.local"]);
  git(repo, ["config", "user.name", "PBench Test"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "baseline"]);
  const workspaceRoot = join(await temp("workspace"), "workspace");
  await initWorkspace(workspaceRoot);
  const input = join(await temp("input"), "session.jsonl");
  await writeFile(input, "fake transcript\n");

  const source: SessionSource = {
    id: "fake",
    sourceKind: "fake-session",
    locate: async () => input,
    extract: () => ({
      meta: { cwd: repo, id: "fake-1", model: "fake-model" },
      userMessages: ["Fix the fixture"],
      assistantMessages: ["Done"],
      toolCalls: [],
      errorRecords: [],
      approvalSandboxRecords: [],
      touchedFiles: [],
      timeline: ["- 1. user: Fix the fixture"]
    })
  };
  const authoring = createAuthoring({ sessionSources: new Map([[source.id, source]]) });

  const result = await authoring.captureSession({ cwd: repo, workspaceRoot, input, source: "fake", yes: true });
  const manifest = JSON.parse(await readFile(join(result.caseDir, "case.json"), "utf8"));

  expect(manifest.metadata.source).toMatchObject({ kind: "fake-session", sessionId: "fake-1" });
  expect(manifest.metadata.tags).toContain("fake");
  expect(await readFile(join(result.caseDir, "private", "artifacts", "raw", "fake-session.jsonl"), "utf8")).toContain(
    "fake transcript"
  );
});
