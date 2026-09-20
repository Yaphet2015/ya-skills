import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAuthoring, initWorkspace } from "../packages/functions-pbench/src/authoring.js";
import type { SessionSource } from "../packages/functions-pbench/src/adapters/types.js";
import { createPbenchFixtures } from "./helpers/pbench-fixtures.js";

const fixtures = createPbenchFixtures();
afterEach(fixtures.cleanup);
const { git, temp } = fixtures;

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
  const home = await temp("home");
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

  const result = await authoring.captureSession({ cwd: repo, workspaceRoot, input, home, source: "fake", yes: true });
  const manifest = JSON.parse(await readFile(join(result.caseDir, "case.json"), "utf8"));

  expect(manifest.metadata.source).toMatchObject({ kind: "fake-session", sessionId: "fake-1" });
  expect(manifest.metadata.tags).toContain("fake");
  expect(await readFile(join(result.caseDir, "private", "artifacts", "raw", "fake-session.jsonl"), "utf8")).toContain(
    "fake transcript"
  );
});
