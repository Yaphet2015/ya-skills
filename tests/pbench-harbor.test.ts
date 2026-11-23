import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureSession, initWorkspace } from "@ya-skills/functions-pbench";
import { createCommands } from "../packages/functions-pbench/src/commands.js";
import { createHarborWorkflow } from "../packages/functions-pbench/src/harbor-workflow.js";
import type { HarborRuntime, HarborTrial } from "../packages/functions-pbench/src/harbor-runtime.js";
import { createPbenchFixtures } from "./helpers/pbench-fixtures.js";

const fixtures = createPbenchFixtures();
afterEach(fixtures.cleanup);

function trial(directory: string, reward: number, id = "10000000-0000-4000-8000-000000000000"): HarborTrial {
  return {
    id, directory, rewards: { reward, completion: reward }, rewardValid: true, error: null,
    agentVersion: "1.0", durationMs: 500, inputTokens: null, outputTokens: null, costUsd: null
  };
}

async function authorTemplate(root: string) {
  for (const folder of ["environment", "tests", "solution"]) await mkdir(join(root, folder), { recursive: true });
  await Promise.all([
    writeFile(join(root, "task.toml"), [
      'artifacts = ["/app/done.txt"]', "", "[task]", 'name = "pbench/harbor-smoke"', ""
    ].join("\n")),
    writeFile(join(root, "environment", "Dockerfile"), "FROM node:22.22.0-bookworm-slim\nWORKDIR /app\nCOPY source/ /app/\n"),
    writeFile(join(root, "tests", "Dockerfile"), "FROM node:22.22.0-bookworm-slim\nCOPY . /tests/\n"),
    writeFile(join(root, "tests", "test.sh"), [
      "#!/bin/sh", "set -eu", "score=0", 'if test -f /app/done.txt && grep -qx done /app/done.txt; then score=1; fi',
      'printf \'{"reward":%s,"done_file":%s}\\n\' "$score" "$score" > /logs/verifier/reward.json', ""
    ].join("\n"), { mode: 0o755 }),
    writeFile(join(root, "solution", "solve.sh"), [
      "#!/bin/sh", "set -eu", "test ! -f /tests/test.sh", "printf 'done\\n' > /app/done.txt", ""
    ].join("\n"), { mode: 0o755 })
  ]);
}

async function captureCase(runtime?: HarborRuntime, inHome = false) {
  const home = inHome ? await fixtures.repoTemp("docker") : await fixtures.temp("harbor-home");
  const workspaceRoot = join(home, "workspace");
  const repo = await fixtures.makeRepo();
  await initWorkspace(workspaceRoot);
  const commit = fixtures.git(repo, ["rev-parse", "HEAD"]);
  const input = await fixtures.writeCodexSession(repo, commit, [{
    type: "exec_command", arguments: { cmd: "node private-signal.js" }, exit_code: 1, stderr: "post-start evidence"
  }]);
  const template = join(home, "template");
  await authorTemplate(template);
  const workflow = createHarborWorkflow({ captureSession, runtime });
  const captured = await workflow.capture({ cwd: repo, home, workspaceRoot, input, yes: true, task: template });
  return { workflow, captured, workspaceRoot, home, repo };
}

test("a saved Harbor case can regrade existing records without invoking the agent again", async () => {
  const recorded: string[] = [];
  let invoked = 0;
  const failId = "20000000-0000-4000-8000-000000000000";
  const passId = "30000000-0000-4000-8000-000000000000";
  const runtime: HarborRuntime = {
    async build(_task, _dir, archive) {
      await writeFile(archive, "saved images");
      return [{ tag: "agent", id: "a" }, { tag: "verifier", id: "v" }];
    },
    async configure() {},
    async restore() {},
    async run({ directory, task, agent }) {
      invoked += 1;
      expect(agent).toBe("codex");
      await expect(readFile(join(task, "solution", "solve.sh"))).rejects.toThrow();
      return Promise.all([failId, passId].map(async (id, reward) => {
        const path = join(directory, id);
        await mkdir(path);
        await writeFile(join(path, "result.json"), "{}\n");
        return trial(path, reward, id);
      }));
    },
    async regrade(_task, source, directory) {
      recorded.push(source);
      return [trial(directory, Number(source.endsWith(passId)))];
    }
  };
  const { workflow, captured, workspaceRoot, home } = await captureCase(runtime);
  expect(captured.state).toBe("saved");
  expect(captured).toMatchObject({ verifierStatus: "pending" });
  const instruction = await readFile(join(captured.caseDir, "harbor", "instruction.md"), "utf8");
  expect(instruction).toContain("done.txt");
  expect(instruction).not.toContain("private-signal.js");

  function call(action: string, args: string[]) {
    const command = createCommands(workflow, { home }).find((item) => item.action === action)!;
    return command.run([...args, "--workspace", workspaceRoot]);
  }
  const run = JSON.parse(String(await call("run", ["--case", captured.caseId, "--model", "openai/test", "--attempts", "2"])));
  const validation = JSON.parse(String(await call("validate", [
    "--case", captured.caseId, "--fail", `run:${failId}`, "--pass", `run:${passId}`
  ])));
  expect(validation.verifierStatus).toBe("verified");
  expect(recorded).toEqual([join(run.directory, failId), join(run.directory, passId)]);
  expect(invoked).toBe(1);
  const report = JSON.parse(String(await call("report", ["--format", "json"])));
  expect(report.comparisons[0]).toMatchObject({ model: "openai/test", passes: 1, scored: 2 });
});

test("a Git sample uses a newer commit from the original repository", async () => {
  const runtime: HarborRuntime = {
    async build(_task, _dir, archive) {
      await writeFile(archive, "saved images");
      return [{ tag: "agent", id: "a" }, { tag: "verifier", id: "v" }];
    },
    async configure() {},
    async restore() {},
    async run({ directory, task, agent }) {
      if (agent === "nop") return [trial(directory, 0)];
      expect(agent).toBe("oracle");
      expect(await readFile(join(task, "solution", "sample.patch"), "utf8")).toContain("+done");
      return [trial(directory, 1)];
    },
    async regrade() { throw new Error("unexpected regrade"); }
  };
  const { workflow, captured, workspaceRoot, repo } = await captureCase(runtime);
  await writeFile(join(repo, "done.txt"), "done\n");
  fixtures.git(repo, ["add", "done.txt"]);
  fixtures.git(repo, ["commit", "-m", "Complete task"]);
  const commit = fixtures.git(repo, ["rev-parse", "HEAD"]);
  const location = { caseDir: captured.caseDir, workspaceRoot };
  expect(await workflow.validate(location, { pass: `git:${commit}` })).toMatchObject({ verifierStatus: "verified" });
  expect(await workflow.validate(location, {})).toMatchObject({ verifierStatus: "verified" });
});

test("missing sample, verifier crash and edited checks do not certify a case", async () => {
  const runtime: HarborRuntime = {
    async build(_task, _dir, archive) {
      await writeFile(archive, "saved images");
      return [{ tag: "agent", id: "a" }, { tag: "verifier", id: "v" }];
    },
    async configure() {},
    async restore() {},
    async run({ directory, agent }) {
      return agent === "nop" ? [trial(directory, 0)] : [{
        ...trial(directory, 1), error: "VerifierTimeoutError", rewardValid: false
      }];
    },
    async regrade() { throw new Error("unexpected regrade"); }
  };
  const { workflow, captured, workspaceRoot } = await captureCase(runtime);
  const result = await workflow.validate({ caseDir: captured.caseDir, workspaceRoot }, {});
  expect(result).toMatchObject({ ok: false, verifierStatus: "pending", errors: ["oracle expected 1, got VerifierTimeoutError"] });
  await writeFile(join(captured.caseDir, "harbor", "tests", "test.sh"), "#!/bin/sh\nexit 2\n");
  expect(await workflow.inspect(captured.caseDir)).toMatchObject({ state: "needs-snapshot", verifierStatus: "pending" });
});

test.skipIf(process.env.YK_PBENCH_DOCKER_TEST !== "1")("Harbor Docker freezes two images and regrades a recorded trial", async () => {
  const { workflow, captured, workspaceRoot } = await captureCase(undefined, true);
  expect(captured).toMatchObject({ state: "saved", verifierStatus: "pending" });
  if (!("revision" in captured)) throw new Error("Missing snapshot revision");
  const snapshot = JSON.parse(await readFile(join(captured.caseDir, ".snapshots", captured.revision!, "snapshot.json"), "utf8"));
  execFileSync("docker", ["image", "rm", ...snapshot.images.map((image: { tag: string }) => image.tag)]);
  const location = { caseDir: captured.caseDir, workspaceRoot };
  const first = await workflow.validate(location, {});
  expect(first).toMatchObject({ ok: true, verifierStatus: "verified" });
  if (!("directory" in first)) throw new Error("Missing validation output");
  const pass = await readdir(join(first.directory, "pass", "trials"));
  const trialPath = pass.find((name) => name.includes("__"));
  expect(trialPath).toBeDefined();
  const second = await workflow.validate(location, { pass: `trial:${join(first.directory, "pass", "trials", trialPath!)}` });
  expect(second).toMatchObject({ ok: true, verifierStatus: "verified" });
  execFileSync("docker", ["image", "rm", ...snapshot.images.map((image: { tag: string }) => image.tag)]);
}, 600_000);
