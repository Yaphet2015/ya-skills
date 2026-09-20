import { afterEach, describe, expect, test } from "bun:test";
import { cp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPbenchCommands,
  initWorkspace
} from "@ya-skills/functions-pbench";
import { createPbenchFixtures } from "./helpers/pbench-fixtures.js";

const fixtures = createPbenchFixtures();
afterEach(fixtures.cleanup);
const {
  captureTestCodexSession,
  expectNoAgentVisiblePrivateReferences,
  finalizedRunnableCase,
  git,
  makeRepo,
  pbenchCommand,
  repoTemp,
  temp,
  writeFakeClaude,
  writeFakeCodex,
  writeRunArtifact
} = fixtures;
describe("pbench capture and replay flow", () => {
  test("runs a finalized case with codex while keeping private evaluator paths away from the agent", async () => {
    const workspaceRoot = join(await repoTemp("workspace-root"), "workspace");
    const { home, caseId } = await finalizedRunnableCase({ workspaceRoot });
    const fake = await writeFakeCodex({
      stdout:
        '{"type":"message","role":"assistant","content":"done"}\n{"type":"usage","usage":{"input_tokens":11,"output_tokens":7}}\n'
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const output = await createPbenchCommands({ home })
        .find((command) => command.action === "run")
        ?.run(["--case", caseId, "--workspace", workspaceRoot, "--agent", "codex"]);
      const result = JSON.parse(String(output));
      const runJson = JSON.parse(await readFile(join(result.artifactDir, "run.json"), "utf8"));
      const stdin = await readFile(join(result.artifactDir, "agent-stdin.txt"), "utf8");
      const agentEnv = await readFile(join(result.artifactDir, "agent-env.json"), "utf8");
      const agentVisible = await readFile(join(result.artifactDir, "agent-visible.txt"), "utf8");

      expect(result.status).toBe("passed");
      expect(runJson.status).toBe("passed");
      expect(runJson.agentMode).toBe("codex");
      expect(runJson.manualIntervention).toBe(false);
      expect(runJson.worktree).toBe(join(workspaceRoot, ".personal-bench", "replays", result.runId, "worktree"));
      expect(runJson.tokenUsage).toEqual({ input_tokens: 11, output_tokens: 7 });
      expect(stdin).toContain(".pbench/public/prompt.md");
      expect(stdin).toContain(".pbench/case.public.json");
      const parsedAgentEnv = JSON.parse(agentEnv);
      expect(parsedAgentEnv.cwd).toBe(runJson.worktree);
      expect(parsedAgentEnv.env.PB_PRIVATE_DIR).toBeUndefined();
      expect(parsedAgentEnv.env.PB_CASE_DIR).toBeUndefined();
      expect(agentVisible).not.toContain("sourceRootAtCapture");
      expectNoAgentVisiblePrivateReferences(`${stdin}\n${agentEnv}\n${agentVisible}`);
      await expect(readFile(join(result.artifactDir, "validator-outcomes.json"), "utf8")).resolves.toContain('"actual": "pass"');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("runs a finalized case with the claude runner and records claude provenance", async () => {
    // Proves platform-independence on the rerun side: a case (here captured from Codex) runs
    // headlessly against Claude Code via the agent registry, with no Codex-specific code.
    const workspaceRoot = join(await repoTemp("workspace-root"), "workspace");
    const { home, caseId } = await finalizedRunnableCase({ workspaceRoot });
    const fake = await writeFakeClaude();
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const output = await createPbenchCommands({ home })
        .find((command) => command.action === "run")
        ?.run(["--case", caseId, "--workspace", workspaceRoot, "--agent", "claude"]);
      const result = JSON.parse(String(output));
      const runJson = JSON.parse(await readFile(join(result.artifactDir, "run.json"), "utf8"));
      const metrics = JSON.parse(await readFile(join(result.artifactDir, "metrics.json"), "utf8"));
      const runnerEnvironment = JSON.parse(await readFile(join(result.artifactDir, "runner-environment.json"), "utf8"));

      expect(result.status).toBe("passed");
      expect(runJson.agentMode).toBe("claude");
      expect(runJson.isolation).toBe("none");
      expect(runJson.integrity).toBe("instruction-only");
      expect(runJson.validatorExecuted).toBe(true);
      expect(runJson.agentVersion).toBe("claude-test 0.0.0");
      expect(runJson.tokenUsage).toEqual({ input_tokens: 11, output_tokens: 7 });
      expect(runJson.cost).toBe(0.0012);
      expect(metrics.agentMode).toBe("claude");
      expect(runnerEnvironment.tools.claude).toBeTruthy();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("records run profile and normalized metrics/events for an automatic run", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const fake = await writeFakeCodex({
      stdout:
        '{"type":"message","role":"assistant","content":"done"}\n{"type":"usage","usage":{"input_tokens":11,"output_tokens":7}}\n'
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const output = await pbenchCommand("run", home).run([
        "--case",
        caseId,
        "--workspace",
        workspaceRoot,
        "--agent",
        "codex",
        "--profile",
        "current-skills"
      ]);
      const result = JSON.parse(String(output));
      const runJson = JSON.parse(await readFile(join(result.artifactDir, "run.json"), "utf8"));
      const metrics = JSON.parse(await readFile(join(result.artifactDir, "metrics.json"), "utf8"));
      const events = JSON.parse(await readFile(join(result.artifactDir, "events.json"), "utf8"));
      const runnerEnvironment = JSON.parse(await readFile(join(result.artifactDir, "runner-environment.json"), "utf8"));

      expect(runJson.profile).toBe("current-skills");
      expect(metrics).toMatchObject({
        schemaVersion: 1,
        runId: result.runId,
        caseId,
        profile: "current-skills",
        status: "passed",
        agentMode: "codex",
        manualIntervention: false,
        validator: { total: 1, passed: 1, failed: 0 },
        tokenUsage: { input_tokens: 11, output_tokens: 7 }
      });
      expect(events.events.map((event: { phase: string }) => event.phase)).toEqual([
        "setup",
        "agent",
        "validator",
        "finish"
      ]);
      expect(runnerEnvironment).toMatchObject({
        schemaVersion: 1,
        runId: result.runId,
        caseId,
        profile: "current-skills",
        agentMode: "codex",
        requiredEnv: []
      });
      expect(runnerEnvironment.runtime.node).toBeTruthy();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("captures candidate untracked file contents and redacts required env values", async () => {
    const secretName = "PBENCH_TEST_SECRET";
    const secretValue = "super-secret-pbench-value";
    const originalSecret = process.env[secretName];
    process.env[secretName] = secretValue;
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase({ requiredEnv: [secretName] });
    const fake = await writeFakeCodex({
      body: [
        "  writeFileSync(join(root, 'done.txt'), 'done\\n');",
        `  writeFileSync(join(root, 'notes.txt'), process.env.${secretName} + '\\n');`,
        "  writeFileSync(join(root, '.pbench', 'internal.txt'), 'internal\\n');"
      ].join("\n")
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const output = await pbenchCommand("run", home).run([
        "--case",
        caseId,
        "--workspace",
        workspaceRoot,
        "--agent",
        "codex"
      ]);
      const result = JSON.parse(String(output));
      const untracked = JSON.parse(await readFile(join(result.artifactDir, "candidate", "untracked.json"), "utf8"));
      const copiedNotes = await readFile(join(result.artifactDir, "candidate", "untracked", "notes.txt"), "utf8");
      const runnerEnvironment = await readFile(join(result.artifactDir, "runner-environment.json"), "utf8");

      expect(result.status).toBe("passed");
      expect(untracked.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "done.txt", status: "copied" }),
          expect.objectContaining({ path: "notes.txt", status: "copied" })
        ])
      );
      expect(untracked.files).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ".pbench/internal.txt", status: "skipped", reason: ".pbench" })])
      );
      expect(copiedNotes).toContain("[REDACTED:PBENCH_TEST_SECRET]");
      expect(copiedNotes).not.toContain(secretValue);
      expect(runnerEnvironment).toContain(`"name": "${secretName}"`);
      expect(runnerEnvironment).toContain('"present": true');
      expect(runnerEnvironment).not.toContain(secretValue);
    } finally {
      process.env.PATH = originalPath;
      if (originalSecret === undefined) {
        delete process.env[secretName];
      } else {
        process.env[secretName] = originalSecret;
      }
    }
  });

  test("run --manual prepares the skill-mediated worktree", async () => {
    const prepared = await finalizedRunnableCase();

    const output = JSON.parse(
      String(
        await pbenchCommand("run", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot,
          "--manual"
        ])
      )
    );

    expect(output.status).toBe("running");
    expect(output.worktree).toContain(output.runId);
    await expect(stat(join(output.worktree, ".pbench", "run.json"))).resolves.toBeTruthy();
    await expect(
      pbenchCommand("run", prepared.home).run([
        "--case",
        prepared.caseId,
        "--workspace",
        prepared.workspaceRoot,
        "--manual",
        "--agent",
        "claude"
      ])
    ).rejects.toThrow("cannot be used together");
  });

  test("installs the manual runner into the worktree's existing Claude skill target", async () => {
    const prepared = await finalizedRunnableCase({ skillTargets: "claude" });
    const started = JSON.parse(
      String(
        await pbenchCommand("start", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot
        ])
      )
    );

    await expect(
      stat(join(started.worktree, ".claude", "skills", "pbench-runner", "SKILL.md"))
    ).resolves.toBeTruthy();
    await expect(
      stat(join(started.worktree, ".agents", "skills", "pbench-runner", "SKILL.md"))
    ).rejects.toThrow();
  });

  test("installs and removes the manual runner across both existing skill targets", async () => {
    const prepared = await finalizedRunnableCase({ skillTargets: "both" });
    const started = JSON.parse(
      String(
        await pbenchCommand("start", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot
        ])
      )
    );

    for (const target of [".claude", ".agents"]) {
      await expect(
        stat(join(started.worktree, target, "skills", "pbench-runner", "SKILL.md"))
      ).resolves.toBeTruthy();
    }

    await writeFile(join(started.worktree, "done.txt"), "done\n");
    await pbenchCommand("finish", prepared.home).run(["--run", started.runId]);

    const diff = await readFile(join(started.artifactDir, "agent.diff"), "utf8");
    const untracked = await readFile(join(started.artifactDir, "candidate", "untracked.json"), "utf8");
    expect(diff).not.toContain("pbench-runner");
    expect(untracked).not.toContain("pbench-runner");
  });

  test("preserves a skill target created by setup when removing the injected runner", async () => {
    const prepared = await finalizedRunnableCase();
    const manifestPath = join(prepared.casePath, "case.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.setupCommands = [
      {
        command: "node -e \"require('node:fs').mkdirSync('.agents/skills', { recursive: true })\"",
        cwd: ".",
        timeoutSeconds: 10
      }
    ];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(prepared.casePath, "private", "validators", "check-completion.mjs"),
      [
        "import { existsSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const root = process.env.PB_REPLAY_DIR;",
        "process.exit(existsSync(join(root, 'done.txt')) && existsSync(join(root, '.agents', 'skills')) ? 0 : 1);"
      ].join("\n") + "\n"
    );

    const started = JSON.parse(
      String(
        await pbenchCommand("start", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot
        ])
      )
    );
    await writeFile(join(started.worktree, "done.txt"), "done\n");

    const finished = JSON.parse(
      String(await pbenchCommand("finish", prepared.home).run(["--run", started.runId]))
    );
    expect(finished.status).toBe("passed");
  });

  test("refuses to overwrite an existing runner skill", async () => {
    const prepared = await finalizedRunnableCase({ existingRunnerSkill: true });

    await expect(
      pbenchCommand("start", prepared.home).run([
        "--case",
        prepared.caseId,
        "--workspace",
        prepared.workspaceRoot
      ])
    ).rejects.toThrow("Refusing to overwrite existing pbench-runner skill");
  });

  test("candidate artifacts exclude the injected runner skill", async () => {
    const prepared = await finalizedRunnableCase();
    const started = JSON.parse(
      String(
        await pbenchCommand("start", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot
        ])
      )
    );
    await writeFile(join(started.worktree, "done.txt"), "done\n");

    await pbenchCommand("finish", prepared.home).run(["--run", started.runId]);

    const diff = await readFile(join(started.artifactDir, "agent.diff"), "utf8");
    const untracked = await readFile(join(started.artifactDir, "candidate", "untracked.json"), "utf8");
    expect(diff).not.toContain("pbench-runner");
    expect(untracked).not.toContain("pbench-runner");
  });

  test("starts a skill-mediated run with public capsule, runner skill, and one-shot finish", async () => {
    const { home, workspaceRoot, caseId, casePath } = await finalizedRunnableCase();
    const startOutput = await createPbenchCommands({ home })
      .find((command) => command.action === "start")
      ?.run(["--case", caseId, "--workspace", workspaceRoot]);
    const started = JSON.parse(String(startOutput));
    const publicRun = JSON.parse(await readFile(join(started.worktree, ".pbench", "run.json"), "utf8"));
    const agentVisible = [
      await readFile(join(started.worktree, ".pbench", "run.json"), "utf8"),
      await readFile(join(started.worktree, ".pbench", "case.public.json"), "utf8"),
      await readFile(join(started.worktree, ".pbench", "public", "context.md"), "utf8"),
      await readFile(join(started.worktree, ".pbench", "public", "replay.md"), "utf8"),
      await readFile(join(started.worktree, ".agents", "skills", "pbench-runner", "SKILL.md"), "utf8")
    ].join("\n");

    expect(started.worktree).toBe(join(workspaceRoot, ".personal-bench", "replays", started.runId, "worktree"));
    expect(publicRun.runId).toBe(started.runId);
    expect(publicRun.finishCommand).toContain(`yk pbench finish --run ${started.runId}`);
    await expect(readFile(join(started.worktree, ".pbench", "public", "prompt.md"), "utf8")).resolves.toContain("done.txt");
    await expect(readFile(join(started.worktree, ".pbench", "case.public.json"), "utf8")).resolves.not.toContain("private/validators");
    await expect(readFile(join(started.worktree, ".agents", "skills", "pbench-runner", "SKILL.md"), "utf8")).resolves.toContain(
      ".pbench/public/prompt.md"
    );
    expect(agentVisible).not.toContain(casePath);
    expect(agentVisible).not.toContain("sourceRootAtCapture");
    expectNoAgentVisiblePrivateReferences(agentVisible);

    await writeFile(join(started.worktree, "done.txt"), "done\n");
    const finishOutput = await createPbenchCommands({ home })
      .find((command) => command.action === "finish")
      ?.run(["--run", started.runId]);
    const finished = JSON.parse(String(finishOutput));
    const summary = await readFile(join(started.artifactDir, "summary.md"), "utf8");

    expect(finished.status).toBe("passed");
    expect(String(finishOutput)).not.toContain("private/validators");
    expect(String(finishOutput)).not.toContain("done.txt is missing");
    expect(summary).toContain("passed");
    await expect(stat(started.worktree)).rejects.toThrow();
    await expect(
      createPbenchCommands({ home })
        .find((command) => command.action === "finish")
        ?.run(["--run", started.runId])
    ).rejects.toThrow("already finished");
  });

  test("finish consumes the attempt when validation infrastructure fails", async () => {
    const prepared = await finalizedRunnableCase();
    const started = JSON.parse(
      String(
        await pbenchCommand("start", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot
        ])
      )
    );
    const privateMarker = "PRIVATE_INFRASTRUCTURE_SECRET";
    await writeFile(join(prepared.casePath, "case.json"), `${privateMarker} is not JSON\n`);

    const firstOutput = String(
      await pbenchCommand("finish", prepared.home).run(["--run", started.runId])
    );
    const first = JSON.parse(firstOutput);
    expect(first.status).toBe("blocked");
    expect(firstOutput).not.toContain(privateMarker);
    await expect(readFile(join(started.artifactDir, "summary.md"), "utf8")).resolves.not.toContain(privateMarker);
    await expect(
      pbenchCommand("finish", prepared.home).run(["--run", started.runId])
    ).rejects.toThrow("already finished");

    const statePath = join(
      prepared.home,
      ".ya-skills",
      "pbench",
      "runs",
      `${started.runId}.json`
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state.terminal).toBe(true);
  });

  test("rejects a second finish while the first attempt is marked finishing", async () => {
    const prepared = await finalizedRunnableCase();
    const started = JSON.parse(
      String(
        await pbenchCommand("start", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot
        ])
      )
    );
    const statePath = join(
      prepared.home,
      ".ya-skills",
      "pbench",
      "runs",
      `${started.runId}.json`
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.status = "finishing";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    await expect(
      pbenchCommand("finish", prepared.home).run(["--run", started.runId])
    ).rejects.toThrow("already finished");
  });

  test("treats an atomic finishing marker as a consumed attempt after a crash", async () => {
    const prepared = await finalizedRunnableCase();
    const started = JSON.parse(
      String(
        await pbenchCommand("start", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot
        ])
      )
    );
    const statePath = join(
      prepared.home,
      ".ya-skills",
      "pbench",
      "runs",
      `${started.runId}.json`
    );
    await rename(statePath, `${statePath}.finishing`);

    await expect(
      pbenchCommand("finish", prepared.home).run(["--run", started.runId])
    ).rejects.toThrow(`already finished: ${started.runId} (finishing)`);
  });

  test("allows only one concurrent finish to execute private validators", async () => {
    const prepared = await finalizedRunnableCase();
    const started = JSON.parse(
      String(
        await pbenchCommand("start", prepared.home).run([
          "--case",
          prepared.caseId,
          "--workspace",
          prepared.workspaceRoot
        ])
      )
    );
    const counterPath = join(prepared.casePath, "private", "finish-count.txt");
    await writeFile(
      join(prepared.casePath, "private", "validators", "check-completion.mjs"),
      [
        "import { appendFileSync, existsSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "appendFileSync(join(process.env.PB_PRIVATE_DIR, 'finish-count.txt'), 'run\\n');",
        "process.exit(existsSync(join(process.env.PB_REPLAY_DIR, 'done.txt')) ? 0 : 1);"
      ].join("\n") + "\n"
    );
    await writeFile(join(started.worktree, "done.txt"), "done\n");

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        pbenchCommand("finish", prepared.home).run(["--run", started.runId])
      )
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect((await readFile(counterPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("preserves profile and writes normalized metrics for a skill-mediated run", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const startOutput = await pbenchCommand("start", home).run([
      "--case",
      caseId,
      "--workspace",
      workspaceRoot,
      "--profile",
      "manual-agent"
    ]);
    const started = JSON.parse(String(startOutput));

    await writeFile(join(started.worktree, "done.txt"), "done\n");
    await pbenchCommand("finish", home).run(["--run", started.runId]);

    const runJson = JSON.parse(await readFile(join(started.artifactDir, "run.json"), "utf8"));
    const metrics = JSON.parse(await readFile(join(started.artifactDir, "metrics.json"), "utf8"));

    expect(runJson).toMatchObject({
      profile: "manual-agent",
      integrity: "instruction-only",
      validatorExecuted: true,
      agentVersion: null
    });
    expect(metrics).toMatchObject({
      runId: started.runId,
      caseId,
      profile: "manual-agent",
      status: "passed",
      agentMode: "skill",
      manualIntervention: true,
      validator: { total: 1, passed: 1, failed: 0 }
    });
  });

  test("skill finish returns minimal signal with no run-dir pointer and redacts validator step output (P1.1)", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const started = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot]))
    );
    // Leave done.txt absent so the validator fails — failing outcomes carry stdout/stderr that must be redacted.
    const finishOutput = await pbenchCommand("finish", home).run(["--run", started.runId]);
    const finished = JSON.parse(String(finishOutput));

    expect(Object.keys(finished).sort()).toEqual(["runId", "status"]);
    expect(finished.status).toBe("validator_failed");
    expect(String(finishOutput)).not.toContain("summary.md");
    expect(String(finishOutput)).not.toContain("validator-outcomes");

    const outcomes = JSON.parse(await readFile(join(started.artifactDir, "validator-outcomes.json"), "utf8"));
    for (const outcome of outcomes) {
      expect(outcome).not.toHaveProperty("stdout");
      expect(outcome).not.toHaveProperty("stderr");
    }
    const summary = await readFile(join(started.artifactDir, "summary.md"), "utf8");
    expect(summary).not.toContain("validator-outcomes.json");
  });

  test("codex run keeps full validator outcomes, returns a summary path, and records workspace-write isolation", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const fake = await writeFakeCodex({
      stdout: '{"type":"message","role":"assistant","content":"done"}\n'
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const result = JSON.parse(
        String(
          await pbenchCommand("run", home).run([
            "--case",
            caseId,
            "--workspace",
            workspaceRoot,
            "--agent",
            "codex",
            "--profile",
            "full-outcomes"
          ])
        )
      );
      expect(result).toHaveProperty("summaryPath");
      const outcomes = JSON.parse(await readFile(join(result.artifactDir, "validator-outcomes.json"), "utf8"));
      expect(outcomes.length).toBeGreaterThan(0);
      expect(outcomes[0]).toHaveProperty("stdout");
      expect(outcomes[0]).toHaveProperty("stderr");
      const runJson = JSON.parse(await readFile(join(result.artifactDir, "run.json"), "utf8"));
      expect(runJson).toMatchObject({
        isolation: "workspace-write",
        integrity: "instruction-only",
        validatorExecuted: true,
        agentVersion: "codex-test 0.0.0",
        attemptNumber: 1
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("records harness-agnostic isolation, attempt, priorRunIds, and contaminated provenance (P1.2)", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const first = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot, "--profile", "probe"]))
    );
    const firstRun = JSON.parse(await readFile(join(first.artifactDir, "run.json"), "utf8"));
    expect(firstRun).toMatchObject({
      agentMode: "skill",
      isolation: "none",
      attemptNumber: 1,
      priorRunIds: [],
      contaminated: false,
      integrity: "instruction-only",
      validatorExecuted: false,
      agentVersion: null
    });
    // Finish each run so it becomes a terminal prior attempt before the next start.
    await writeFile(join(first.worktree, "done.txt"), "done\n");
    await pbenchCommand("finish", home).run(["--run", first.runId]);

    const second = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot, "--profile", "probe"]))
    );
    const secondRun = JSON.parse(await readFile(join(second.artifactDir, "run.json"), "utf8"));
    expect(secondRun.attemptNumber).toBe(2);
    expect(secondRun.priorRunIds).toEqual([first.runId]);
    await writeFile(join(second.worktree, "done.txt"), "done\n");
    await pbenchCommand("finish", home).run(["--run", second.runId]);

    const tainted = JSON.parse(
      String(
        await pbenchCommand("start", home).run([
          "--case",
          caseId,
          "--workspace",
          workspaceRoot,
          "--profile",
          "probe",
          "--contaminated"
        ])
      )
    );
    const taintedRun = JSON.parse(await readFile(join(tainted.artifactDir, "run.json"), "utf8"));
    expect(taintedRun.contaminated).toBe(true);
    expect(taintedRun.integrity).toBe("contaminated");
    expect(taintedRun.attemptNumber).toBe(3);
  });

  test("prior attempts exclude in-flight and legacy pre-feature runs", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    // Legacy run: terminal but no attemptNumber field (pre-feature shape) — must NOT count.
    await writeRunArtifact(workspaceRoot, {
      runId: "legacy_probe_20260601T000000Z",
      caseId,
      profile: "probe",
      status: "passed",
      manualIntervention: false
    });
    // In-flight run: started but never finished (terminal:false) — must NOT count.
    await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot, "--profile", "probe"]);
    const next = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot, "--profile", "probe"]))
    );
    const nextRun = JSON.parse(await readFile(join(next.artifactDir, "run.json"), "utf8"));
    expect(nextRun.attemptNumber).toBe(1);
    expect(nextRun.priorRunIds).toEqual([]);
  });

  test("report surfaces isolation, attempt, and contaminated provenance", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    await pbenchCommand("start", home).run([
      "--case",
      caseId,
      "--workspace",
      workspaceRoot,
      "--profile",
      "probe",
      "--contaminated"
    ]);
    const report = JSON.parse(
      String(await pbenchCommand("report", home).run(["--workspace", workspaceRoot, "--format", "json"]))
    );
    expect(report.totals.contaminated).toBe(1);
    const recent = report.recentRuns.find((run: { contaminated: boolean }) => run.contaminated === true);
    expect(recent).toBeTruthy();
    expect(recent).toMatchObject({ isolation: "none", attemptNumber: 1, contaminated: true });
  });

  test("skill finish copies the access-audit log and flags sensitive reads (P1.3-lite)", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const started = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot]))
    );
    await writeFile(join(started.worktree, "done.txt"), "done\n");
    await writeFile(
      join(started.worktree, ".pbench", "access-audit.jsonl"),
      [
        JSON.stringify({ path: "src/index.ts", at: "2026-06-16T10:00:00Z" }),
        JSON.stringify({ path: "/cases/x/private/failure.md", at: "2026-06-16T10:01:00Z" })
      ].join("\n") + "\n"
    );
    await pbenchCommand("finish", home).run(["--run", started.runId]);

    const audit = JSON.parse(await readFile(join(started.artifactDir, "access-audit.json"), "utf8"));
    expect(audit.readCount).toBe(2);
    expect(audit.suspicious).toBe(true);
    expect(audit.sensitiveReads.map((entry: { kind: string }) => entry.kind)).toContain("private-evidence");
    const runJson = JSON.parse(await readFile(join(started.artifactDir, "run.json"), "utf8"));
    expect(runJson.accessAuditSuspicious).toBe(true);
  });

  test("skill finish writes no access-audit artifact when the agent kept no log", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const started = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot]))
    );
    await writeFile(join(started.worktree, "done.txt"), "done\n");
    await pbenchCommand("finish", home).run(["--run", started.runId]);
    await expect(readFile(join(started.artifactDir, "access-audit.json"), "utf8")).rejects.toThrow();
    const runJson = JSON.parse(await readFile(join(started.artifactDir, "run.json"), "utf8"));
    expect(runJson.accessAuditSuspicious).not.toBe(true);
  });

  test("access audit flags the capture-skill source but not the runner skill it must read", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const started = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot]))
    );
    await writeFile(join(started.worktree, "done.txt"), "done\n");
    await writeFile(
      join(started.worktree, ".pbench", "access-audit.jsonl"),
      [
        JSON.stringify({ path: join(started.worktree, ".agents", "skills", "pbench-runner", "SKILL.md") }),
        JSON.stringify({ path: "/repo/skills/pbench/SKILL.md" }),
        JSON.stringify({ path: "/cases/x/private/failure.md" }),
        JSON.stringify({ path: "src/index.ts" })
      ].join("\n") + "\n"
    );
    await pbenchCommand("finish", home).run(["--run", started.runId]);
    const audit = JSON.parse(await readFile(join(started.artifactDir, "access-audit.json"), "utf8"));
    expect(audit.readCount).toBe(4);
    expect(audit.suspicious).toBe(true);
    expect(audit.sensitiveReads.map((entry: { kind: string }) => entry.kind).sort()).toEqual([
      "pbench-skill-source",
      "private-evidence"
    ]);
  });

  test("installs the canonical internal runner skill", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const started = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot]))
    );
    const skill = await readFile(join(started.worktree, ".agents", "skills", "pbench-runner", "SKILL.md"), "utf8");
    expect(skill).toContain("name: pbench-runner");
    expect(skill).toContain("A failed finish is terminal");
    expect(skill).not.toContain("access-audit.jsonl");
    expectNoAgentVisiblePrivateReferences(skill);
    const canonicalAsset = await readFile(
      join(process.cwd(), "packages", "functions-pbench", "assets", "pbench-runner", "SKILL.md"),
      "utf8"
    );
    expect(skill).toBe(canonicalAsset);
  });

  test("redacts setup-outcomes stdout/stderr in skill mode (review)", async () => {
    const { home, workspaceRoot, caseId, casePath } = await finalizedRunnableCase();
    const manifestPath = join(casePath, "case.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.setupCommands = [{ command: "node -e \"process.stdout.write('setup-oracle-leak')\"", cwd: ".", timeoutSeconds: 10 }];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const started = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot]))
    );
    const setupOutcomes = JSON.parse(await readFile(join(started.artifactDir, "setup-outcomes.json"), "utf8"));
    expect(setupOutcomes.length).toBe(1);
    for (const outcome of setupOutcomes) {
      expect(outcome).not.toHaveProperty("stdout");
      expect(outcome).not.toHaveProperty("stderr");
    }
    expect(setupOutcomes[0]).toEqual({ id: expect.any(String), expected: "pass", actual: "pass", exitCode: 0 });
  });

  test("fails before agent execution when required replay env is missing", async () => {
    const missingEnv = "PBENCH_TEST_REQUIRED_BUT_MISSING";
    const original = process.env[missingEnv];
    process.env[missingEnv] = "available-during-authoring";
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase({ requiredEnv: [missingEnv] });
    delete process.env[missingEnv];
    const fake = await writeFakeCodex();
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      await expect(
        createPbenchCommands({ home })
          .find((command) => command.action === "run")
          ?.run(["--case", caseId, "--workspace", workspaceRoot, "--agent", "codex"])
      ).rejects.toThrow(missingEnv);
      await expect(stat(join(workspaceRoot, "runs"))).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
      if (original === undefined) {
        delete process.env[missingEnv];
      } else {
        process.env[missingEnv] = original;
      }
    }
  });

  test("applies the public starting patch before a skill-mediated agent works", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase({ dirtyStart: true });
    const startOutput = await createPbenchCommands({ home })
      .find((command) => command.action === "start")
      ?.run(["--case", caseId, "--workspace", workspaceRoot]);
    const started = JSON.parse(String(startOutput));

    await expect(readFile(join(started.worktree, "check-done.mjs"), "utf8")).resolves.toContain("dirty starting point");
  });

  test("records agent failure without running private validators", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const fake = await writeFakeCodex({ exitCode: 7, stderr: "agent failed before edit\n", body: "  // no edit" });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const output = await createPbenchCommands({ home })
        .find((command) => command.action === "run")
        ?.run(["--case", caseId, "--workspace", workspaceRoot, "--agent", "codex"]);
      const result = JSON.parse(String(output));
      const runJson = JSON.parse(await readFile(join(result.artifactDir, "run.json"), "utf8"));
      const summary = await readFile(join(result.artifactDir, "summary.md"), "utf8");

      expect(result.status).toBe("agent_failed");
      expect(runJson.agentExitCode).toBe(7);
      expect(summary).toContain("- Agent exit code: 7");
      expect(summary).toContain("- Agent stdout: agent.stdout.log");
      expect(summary).toContain("- Agent stderr: agent.stderr.log");
      await expect(stat(join(result.artifactDir, "validator-outcomes.json"))).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("records setup failure before invoking the agent", async () => {
    const { home, workspaceRoot, caseId, casePath } = await finalizedRunnableCase();
    const manifestPath = join(casePath, "case.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.setupCommands = [{ command: "node -e \"process.exit(9)\"", cwd: ".", timeoutSeconds: 10 }];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const fake = await writeFakeCodex();
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const output = await createPbenchCommands({ home })
        .find((command) => command.action === "run")
        ?.run(["--case", caseId, "--workspace", workspaceRoot, "--agent", "codex"]);
      const result = JSON.parse(String(output));
      const summary = await readFile(join(result.artifactDir, "summary.md"), "utf8");

      expect(result.status).toBe("setup_failed");
      expect(summary).toContain("- Failed setup command: node -e \"process.exit(9)\"");
      expect(summary).toContain("- Exit code: 9");
      expect(summary).toContain("- Setup outcomes: setup-outcomes.json");
      await expect(readFile(join(result.artifactDir, "setup-outcomes.json"), "utf8")).resolves.toContain('"actual": "fail"');
      await expect(stat(join(result.artifactDir, "agent.stdout.log"))).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("records validator failure and the agent diff", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const fake = await writeFakeCodex({ body: "  writeFileSync(join(root, 'wrong.txt'), 'wrong\\n');" });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const output = await createPbenchCommands({ home })
        .find((command) => command.action === "run")
        ?.run(["--case", caseId, "--workspace", workspaceRoot, "--agent", "codex"]);
      const result = JSON.parse(String(output));
      const diff = await readFile(join(result.artifactDir, "agent.diff"), "utf8");
      const copiedWrong = await readFile(join(result.artifactDir, "candidate", "untracked", "wrong.txt"), "utf8");
      const untracked = JSON.parse(await readFile(join(result.artifactDir, "candidate", "untracked.json"), "utf8"));
      const summary = await readFile(join(result.artifactDir, "summary.md"), "utf8");

      expect(result.status).toBe("validator_failed");
      expect(diff).toContain("wrong.txt");
      expect(copiedWrong).toBe("wrong\n");
      expect(untracked.files).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "wrong.txt", status: "copied" })])
      );
      expect(summary).toContain("- Failed validator: completion");
      expect(summary).toContain("- Validator outcomes: validator-outcomes.json");
      expect(summary).toContain("- Candidate diff: agent.diff");
      expect(summary).toContain("- Candidate files: candidate/untracked.json");
      await expect(readFile(join(result.artifactDir, "validator-outcomes.json"), "utf8")).resolves.toContain('"actual": "fail"');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("redacts required environment values from persisted runner logs", async () => {
    const secretName = "PBENCH_TEST_SECRET";
    const secretValue = "super-secret-pbench-value";
    const originalSecret = process.env[secretName];
    process.env[secretName] = secretValue;
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase({ requiredEnv: [secretName] });
    const fake = await writeFakeCodex({
      stdout: `agent saw ${secretValue}\n`,
      stderr: `stderr saw ${secretValue}\n`
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;
    try {
      const output = await createPbenchCommands({ home })
        .find((command) => command.action === "run")
        ?.run(["--case", caseId, "--workspace", workspaceRoot, "--agent", "codex"]);
      const result = JSON.parse(String(output));
      const runJson = await readFile(join(result.artifactDir, "run.json"), "utf8");
      const stdout = await readFile(join(result.artifactDir, "agent.stdout.log"), "utf8");
      const stderr = await readFile(join(result.artifactDir, "agent.stderr.log"), "utf8");

      expect(`${runJson}\n${stdout}\n${stderr}`).not.toContain(secretValue);
      expect(`${runJson}\n${stdout}\n${stderr}`).toContain("[REDACTED:PBENCH_TEST_SECRET]");
    } finally {
      process.env.PATH = originalPath;
      if (originalSecret === undefined) {
        delete process.env[secretName];
      } else {
        process.env[secretName] = originalSecret;
      }
    }
  });

  test("defaults reports to Markdown and preserves explicit JSON output", async () => {
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);

    const markdown = String(await pbenchCommand("report", home).run(["--workspace", workspaceRoot]));
    const json = String(
      await pbenchCommand("report", home).run(["--workspace", workspaceRoot, "--format", "json"])
    );
    const report = JSON.parse(json);

    expect(markdown.startsWith("# PBench Report")).toBe(true);
    expect(report).toMatchObject({
      schemaVersion: 1,
      workspaceRoot,
      filters: {},
      totals: {
        runs: 0,
        cases: 0,
        manualIntervention: 0,
        statusCounts: {}
      },
      profiles: {},
      cases: {},
      recentRuns: []
    });
  });

  test("audits case quality warnings and public private-path leaks without strict replay", async () => {
    const repo = await makeRepo();
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = join(await temp("session"), "empty-session.jsonl");
    await writeFile(
      sessionJsonl,
      [
        JSON.stringify({
          type: "session_meta",
          cwd: repo,
          git: { commit_hash: commit, branch: "main" },
          id: "empty-session",
          model: "gpt-test"
        }),
        JSON.stringify({
          type: "message",
          role: "user",
          content: "# AGENTS.md instructions for injected context\n"
        })
      ].join("\n") + "\n"
    );
    const tx = await captureTestCodexSession({
      cwd: repo,
      home,
      workspaceRoot,
      input: sessionJsonl,
      yes: true
    });
    await writeFile(join(tx.caseDir, "public", "leak.md"), "Read private/failure.md to pass.\n");

    const audit = JSON.parse(String(await pbenchCommand("audit", home).run(["--case", tx.caseDir])));

    expect(audit.ok).toBe(false);
    expect(audit.caseId).toBe(tx.caseId);
    expect(audit.warnings).toContain("public/prompt.md is empty");
    expect(audit.warnings).toContain("private/validators/check-completion.mjs needs completion logic from session correction evidence");
    expect(audit.errors.join("\n")).toContain("private evaluator path");
  });

  test("audits every finalized case in a workspace", async () => {
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    const { home, casePath, caseId } = await finalizedRunnableCase({ workspaceRoot });
    const warningCaseId = "case_warning_20260612T000000Z";
    const warningCasePath = join(workspaceRoot, "cases", warningCaseId);
    await cp(casePath, warningCasePath, { recursive: true });
    const warningManifestPath = join(warningCasePath, "case.json");
    const warningManifest = JSON.parse(await readFile(warningManifestPath, "utf8"));
    warningManifest.id = warningCaseId;
    await writeFile(warningManifestPath, `${JSON.stringify(warningManifest, null, 2)}\n`);
    await writeFile(join(warningCasePath, "public", "prompt.md"), "\n");

    const audit = JSON.parse(String(await pbenchCommand("audit", home).run(["--workspace", workspaceRoot])));

    expect(audit).toMatchObject({
      schemaVersion: 1,
      workspaceRoot,
      ok: false,
      totals: {
        cases: 2,
        passed: 1,
        failed: 1,
        warnings: 1
      }
    });
    expect(audit.cases.map((entry: { caseId: string }) => entry.caseId)).toEqual([caseId, warningCaseId].sort());
    expect(audit.cases.find((entry: { caseId: string }) => entry.caseId === caseId).ok).toBe(true);
    expect(audit.cases.find((entry: { caseId: string }) => entry.caseId === warningCaseId).warnings).toContain(
      "public/prompt.md is empty"
    );
  });

  test("audits an empty workspace without a cases directory", async () => {
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    await rm(join(workspaceRoot, "cases"), { recursive: true, force: true });

    const audit = JSON.parse(String(await pbenchCommand("audit", home).run(["--workspace", workspaceRoot])));

    expect(audit).toEqual({
      schemaVersion: 1,
      workspaceRoot,
      ok: true,
      totals: {
        cases: 0,
        passed: 0,
        failed: 0,
        warnings: 0
      },
      cases: []
    });
  });
});
