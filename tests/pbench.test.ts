import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureCodexSession,
  createPbenchCommands,
  finalizeTransaction,
  initWorkspace,
  linkProject,
  resolveWorkspaceRoot,
  strictValidateTransaction,
  validateCaseBundle
} from "@ya-skills/functions-pbench";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `yk-pbench-${prefix}-`));
  cleanupPaths.push(path);
  return path;
}

async function repoTemp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(process.cwd(), `.yk-pbench-${prefix}-`));
  cleanupPaths.push(path);
  return path;
}

async function captureTestCodexSession(
  options: Parameters<typeof captureCodexSession>[0]
): Promise<Awaited<ReturnType<typeof captureCodexSession>>> {
  const home = options?.home ?? (await temp("capture-home"));
  return captureCodexSession({ ...options, home });
}

async function captureRepoTransaction(repo: string) {
  const home = await temp("home");
  const workspaceRoot = join(await temp("workspace-root"), "workspace");
  await initWorkspace(workspaceRoot);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  const input = await writeCodexSession(repo, commit);
  const tx = await captureTestCodexSession({
    cwd: repo,
    home,
    workspaceRoot,
    input,
    yes: true,
    title: "Done file missing"
  });
  return { home, workspaceRoot, tx };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function makeRepo(): Promise<string> {
  const repo = await temp("repo");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "pbench@example.local"]);
  git(repo, ["config", "user.name", "PBench Test"]);
  await writeFile(join(repo, "package.json"), "{\"scripts\":{\"test\":\"node ok.mjs\"}}\n");
  await writeFile(join(repo, "ok.mjs"), "process.exit(0);\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "baseline"]);
  return repo;
}

type RunnableCaseOptions = {
  requiredEnv?: string[];
  dirtyStart?: boolean;
  workspaceRoot?: string;
  skillTargets?: "claude" | "agents" | "both";
  existingRunnerSkill?: boolean;
};

async function makeRepoWithFailingTest(options: RunnableCaseOptions = {}): Promise<string> {
  const repo = await temp("repo");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "pbench@example.local"]);
  git(repo, ["config", "user.name", "PBench Test"]);
  await writeFile(join(repo, "package.json"), "{\"scripts\":{\"test\":\"node check-done.mjs\"}}\n");
  await writeFile(
    join(repo, "check-done.mjs"),
    "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('done.txt') ? 0 : 1);\n"
  );
  if (options.skillTargets === "claude" || options.skillTargets === "both") {
    await mkdir(join(repo, ".claude", "skills"), { recursive: true });
    await writeFile(join(repo, ".claude", "skills", ".keep"), "");
  }
  if (options.skillTargets === "agents" || options.skillTargets === "both") {
    await mkdir(join(repo, ".agents", "skills"), { recursive: true });
    await writeFile(join(repo, ".agents", "skills", ".keep"), "");
  }
  if (options.existingRunnerSkill) {
    await mkdir(join(repo, ".agents", "skills", "pbench-runner"), { recursive: true });
    await writeFile(join(repo, ".agents", "skills", "pbench-runner", "SKILL.md"), "project-owned\n");
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "baseline"]);
  return repo;
}

async function runnableTransaction(options: RunnableCaseOptions = {}) {
  const repo = await makeRepoWithFailingTest(options);
  if (options.dirtyStart) {
    await writeFile(
      join(repo, "check-done.mjs"),
      "import { existsSync } from 'node:fs';\n// dirty starting point\nprocess.exit(existsSync('done.txt') ? 0 : 1);\n"
    );
  }
  const home = await temp("home");
  const workspaceRoot = options.workspaceRoot ?? join(await temp("workspace-root"), "workspace");
  await initWorkspace(workspaceRoot);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  const sessionJsonl = await writeCodexSession(repo, commit, [
    {
      type: "exec_command",
      arguments: { cmd: "bun run test", workdir: repo },
      exit_code: 1,
      stderr: "done.txt is missing"
    },
    {
      type: "message",
      role: "user",
      content: "The benchmark should be complete only when done.txt exists and the test passes."
    }
  ]);
  const tx = await captureTestCodexSession({
    cwd: repo,
    home,
    workspaceRoot,
    input: sessionJsonl,
    yes: true,
    title: "Done file missing"
  });
  if (options.requiredEnv?.length) {
    const manifestPath = join(tx.caseDir, "case.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.replayRequirements = {
      profile: "live-integration",
      network: "required",
      requiredEnv: options.requiredEnv,
      notes: ["test required env"]
    };
    manifest.validators[0].requiredEnv = options.requiredEnv;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (options.dirtyStart) {
    const manifestPath = join(tx.caseDir, "case.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.replayStart = { status: "curated" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await cp(
      join(tx.caseDir, "private", "artifacts", "extracted", "starting.patch"),
      join(tx.caseDir, "public", "starting.patch")
    );
    for (const name of ["context.manifest.json", "replay.manifest.json"]) {
      const replayManifestPath = join(tx.caseDir, "public", name);
      const replayManifest = JSON.parse(await readFile(replayManifestPath, "utf8"));
      replayManifest.replayFiles.startingPatch = "public/starting.patch";
      await writeFile(replayManifestPath, `${JSON.stringify(replayManifest, null, 2)}\n`);
    }
  }
  return { repo, home, workspaceRoot, tx };
}

async function finalizedRunnableCase(
  options: RunnableCaseOptions = {}
): Promise<{ repo: string; home: string; workspaceRoot: string; casePath: string; caseId: string }> {
  const prepared = await runnableTransaction(options);
  const validation = await strictValidateTransaction(prepared.tx.transactionPath);
  expect(validation.ok).toBe(true);
  const finalized = await finalizeTransaction(prepared.tx.transactionPath);
  return {
    repo: prepared.repo,
    home: prepared.home,
    workspaceRoot: prepared.workspaceRoot,
    casePath: finalized.casePath,
    caseId: finalized.caseId
  };
}

async function writeRunArtifact(
  workspaceRoot: string,
  run: {
    runId: string;
    caseId: string;
    profile?: string;
    status: string;
    agentMode?: string;
    manualIntervention?: boolean;
    durationMs?: number;
    tokenUsage?: Record<string, number>;
    createdAt?: string;
    updatedAt?: string;
  }
): Promise<string> {
  const artifactDir = join(workspaceRoot, "runs", run.runId);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, "run.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactDir,
        workspaceRoot,
        terminal: true,
        agentMode: "codex",
        manualIntervention: false,
        createdAt: "2026-06-12T00:00:00Z",
        updatedAt: "2026-06-12T00:00:00Z",
        ...run
      },
      null,
      2
    )}\n`
  );
  return artifactDir;
}

function pbenchCommand(action: string, home?: string) {
  const command = createPbenchCommands({ home }).find((item) => item.action === action);
  expect(command).toBeDefined();
  return command!;
}

async function writeFakeCodex(options: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  body?: string;
} = {}): Promise<{ binDir: string; commandPath: string }> {
  // Test doubles must satisfy runner environment version probes on CI, where real agents are absent.
  const binDir = await temp("fake-codex-bin");
  const commandPath = join(binDir, "codex");
  await writeFile(
    commandPath,
    [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "",
      "if (process.argv.includes('--version')) {",
      "  process.stdout.write('codex-test 0.0.0\\n');",
      "  process.exit(0);",
      "}",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  const cdIndex = process.argv.indexOf('--cd');",
      "  const root = cdIndex >= 0 ? process.argv[cdIndex + 1] : process.cwd();",
      "  writeFileSync(join(root, '.pbench', 'fake-codex-argv.json'), JSON.stringify(process.argv.slice(2), null, 2));",
      "  const execIndex = process.argv.indexOf('exec');",
      "  const approvalIndex = process.argv.indexOf('--ask-for-approval');",
      "  if (execIndex >= 0 && approvalIndex > execIndex) {",
      "    process.stderr.write(\"unexpected argument '--ask-for-approval' found\\n\");",
      "    process.exit(2);",
      "  }",
      "  writeFileSync(join(root, '.pbench', 'fake-codex-stdin.txt'), stdin);",
      "  const visibleEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PB_') || key === 'PBENCH_TEST_SECRET'));",
      "  writeFileSync(join(root, '.pbench', 'fake-codex-env.json'), JSON.stringify({",
      "    cwd: process.cwd(),",
      "    env: visibleEnv",
      "  }, null, 2));",
      "  writeFileSync(join(root, '.pbench', 'fake-codex-visible.txt'), [",
      "    stdin,",
      "    readFileSync(join(root, '.pbench', 'case.public.json'), 'utf8'),",
      "    readFileSync(join(root, '.pbench', 'run.json'), 'utf8'),",
      "    readFileSync(join(root, '.pbench', 'public', 'context.md'), 'utf8'),",
      "    readFileSync(join(root, '.pbench', 'public', 'replay.md'), 'utf8')",
      "  ].join('\\n---\\n'));",
      options.body ?? "  writeFileSync(join(root, 'done.txt'), 'done\\n');",
      `  if (${JSON.stringify(options.stdout ?? '{"type":"message","role":"assistant","content":"done"}\\n')}) process.stdout.write(${JSON.stringify(options.stdout ?? '{"type":"message","role":"assistant","content":"done"}\\n')});`,
      `  if (${JSON.stringify(options.stderr ?? "")}) process.stderr.write(${JSON.stringify(options.stderr ?? "")});`,
      `  process.exit(${options.exitCode ?? 0});`,
      "});",
      ""
    ].join("\n")
  );
  await chmod(commandPath, 0o755);
  return { binDir, commandPath };
}

async function writeFakeClaude(options: { exitCode?: number; cost?: number; body?: string } = {}): Promise<{ binDir: string; commandPath: string }> {
  // Test doubles must satisfy runner environment version probes on CI, where real agents are absent.
  const binDir = await temp("fake-claude-bin");
  const commandPath = join(binDir, "claude");
  const assistantLine = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] }
  });
  const resultLine = JSON.stringify({
    type: "result",
    result: "done",
    usage: { input_tokens: 11, output_tokens: 7 },
    total_cost_usd: options.cost ?? 0.0012
  });
  await writeFile(
    commandPath,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (process.argv.includes('--version')) {",
      "  process.stdout.write('claude-test 0.0.0\\n');",
      "  process.exit(0);",
      "}",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  const root = process.cwd();",
      "  writeFileSync(join(root, '.pbench', 'fake-claude-stdin.txt'), stdin);",
      options.body ?? "  writeFileSync(join(root, 'done.txt'), 'done\\n');",
      `  process.stdout.write(${JSON.stringify(assistantLine)} + "\\n");`,
      `  process.stdout.write(${JSON.stringify(resultLine)} + "\\n");`,
      `  process.exit(${options.exitCode ?? 0});`,
      "});",
      ""
    ].join("\n")
  );
  await chmod(commandPath, 0o755);
  return { binDir, commandPath };
}

function expectNoAgentVisiblePrivateReferences(text: string): void {
  expect(text).not.toContain("/private/");
  expect(text).not.toContain("private/validators");
  expect(text).not.toContain("private/artifacts/raw");
  expect(text).not.toContain("PB_PRIVATE_DIR");
  expect(text).not.toContain("PB_CASE_DIR");
}

async function writeCodexSession(repo: string, commit: string, records: Record<string, unknown>[] = []): Promise<string> {
  const sessionJsonl = join(await temp("session"), "session.jsonl");
  await writeFile(
    sessionJsonl,
    [
      JSON.stringify({
        type: "session_meta",
        cwd: repo,
        git: { commit_hash: commit, branch: "main" },
        id: "session-1",
        model: "gpt-test",
        cli_version: "0.1.0",
        timestamp: "2026-05-07T09:15:00Z",
        sandbox_mode: "workspace-write"
      }),
      JSON.stringify({
        type: "message",
        role: "user",
        content: "Make tests pass by creating done.txt"
      }),
      JSON.stringify({
        type: "tool_call",
        name: "terminal",
        arguments: { command: "touch done.txt" },
        status: "failed"
      }),
      ...records.map((record) => JSON.stringify(record))
    ].join("\n") + "\n"
  );
  return sessionJsonl;
}

async function writeModernCodexSession(options: {
  repo: string;
  commit: string;
  records?: Record<string, unknown>[];
  sessionId?: string;
  home?: string;
}): Promise<string> {
  const sessionId = options.sessionId ?? "modern-session-1";
  const root = options.home
    ? join(options.home, ".codex", "sessions", "2026", "06", "04")
    : await temp("modern-session");
  await mkdir(root, { recursive: true });
  const sessionJsonl = join(root, `rollout-2026-06-04T14-28-32-${sessionId}.jsonl`);
  await writeFile(
    sessionJsonl,
    [
      JSON.stringify({
        timestamp: "2026-06-04T06:29:19.498Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: "2026-06-04T06:28:32.068Z",
          cwd: options.repo,
          cli_version: "0.136.0-alpha.2",
          model: "gpt-test-modern",
          git: { commit_hash: options.commit, branch: "feature/pbench" }
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-04T06:29:20.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for injected context\nDo not use this as the task.\n" }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-04T06:29:21.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the CR suggestionDiff parse failure before upload.\n" }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-04T06:29:22.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call_1",
          arguments: JSON.stringify({
            cmd: "sed -n '1,120p' packages/papi-hub/src/features/code-review/index.ts",
            workdir: options.repo
          })
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-04T06:29:23.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "Chunk ID: abc\nProcess exited with code 1\nOutput:\nTSX parse failure: Unexpected token\n"
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-04T06:29:24.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call_2",
          input: "*** Begin Patch\n*** Update File: packages/papi-hub/src/features/code-review/index.ts\n@@\n+// repair loop\n*** End Patch\n"
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-04T06:29:25.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Implemented and ready.\n" }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-06-04T06:29:26.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "还是不太对，suggestionDiff 应用后 TSX parse failure，应该反馈给 agent 修复最终产出可用的 meta.json。\n"
            }
          ]
        }
      }),
      ...(options.records ?? []).map((record) => JSON.stringify(record))
    ].join("\n") + "\n"
  );
  return sessionJsonl;
}

function modernSessionPayloadJsonl(options: {
  metaId: string;
  cwd: string;
  commit: string;
  prompt: string;
  timestamp: string;
}): string {
  return [
    JSON.stringify({
      timestamp: options.timestamp,
      type: "session_meta",
      payload: {
        id: options.metaId,
        timestamp: options.timestamp,
        cwd: options.cwd,
        cli_version: "0.136.0",
        model: "gpt-test",
        git: { commit_hash: options.commit, branch: "main" }
      }
    }),
    JSON.stringify({
      timestamp: options.timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.prompt }]
      }
    })
  ].join("\n") + "\n";
}

async function writeClaudeTranscript(options: {
  cwd: string;
  sessionId?: string;
  branch?: string;
  records?: Record<string, unknown>[];
}): Promise<string> {
  const sessionId = options.sessionId ?? "claude-session-1";
  const transcript = join(await temp("claude-session"), `${sessionId}.jsonl`);
  const base = { cwd: options.cwd, sessionId, gitBranch: options.branch ?? "main", version: "2.1.187" };
  await writeFile(
    transcript,
    [
      JSON.stringify({
        type: "user",
        ...base,
        timestamp: "2026-06-24T10:00:00Z",
        message: { role: "user", content: "Fix the login bug so the focused test passes." }
      }),
      JSON.stringify({
        type: "assistant",
        ...base,
        timestamp: "2026-06-24T10:00:01Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "text", text: "Running the focused test to reproduce." },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "bun run test" } }
          ],
          usage: { input_tokens: 120, output_tokens: 30 }
        }
      }),
      JSON.stringify({
        type: "user",
        ...base,
        timestamp: "2026-06-24T10:00:02Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "Exit code: 1\ndone.txt is missing" }]
        }
      }),
      JSON.stringify({
        type: "user",
        ...base,
        timestamp: "2026-06-24T10:00:03Z",
        message: { role: "user", content: "The task is complete only when done.txt exists and the test passes." }
      }),
      ...(options.records ?? []).map((record) => JSON.stringify(record))
    ].join("\n") + "\n"
  );
  return transcript;
}

describe("pbench workspace handling", () => {
  test("initializes and links a local workspace without creating a git repository", async () => {
    const project = await temp("project");
    const workspace = join(await temp("workspace-root"), "workspace");

    const initialized = await initWorkspace(workspace);
    const linkPath = await linkProject(project, workspace);

    expect(initialized.root).toBe(workspace);
    await expect(stat(join(workspace, ".personal-bench", "workspace.json"))).resolves.toBeTruthy();
    await expect(stat(join(workspace, "cases"))).resolves.toBeTruthy();
    await expect(stat(join(workspace, "repos"))).resolves.toBeTruthy();
    await expect(stat(join(workspace, ".git"))).rejects.toThrow();
    expect(linkPath).toBe(join(project, ".personal-bench", "workspace.json"));
    await expect(resolveWorkspaceRoot({ cwd: project })).resolves.toBe(workspace);
  });
});

describe("pbench case validation", () => {
  test("rejects unsafe case-local paths before strict replay", async () => {
    const caseDir = await temp("case");
    await mkdir(join(caseDir, "public"), { recursive: true });
    await writeFile(
      join(caseDir, "case.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "case_bad_20260507T091500Z",
          title: "Bad case",
          status: "active",
          privacy: { level: "private" },
          metadata: {
            createdAt: "2026-05-07T09:15:00Z",
            source: { kind: "codex-session" }
          },
          documents: { prompt: "../prompt.md" },
          subjects: [],
          validators: []
        },
        null,
        2
      )
    );

    const result = await validateCaseBundle(caseDir, { strict: false });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("Unsafe or invalid case-local path");
  });

  test("rejects case-local paths that end in parent directory traversal", async () => {
    const caseDir = await temp("case");
    await writeFile(
      join(caseDir, "case.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "case_bad_20260507T091500Z",
          title: "Bad case",
          status: "active",
          privacy: { level: "private" },
          metadata: {
            createdAt: "2026-05-07T09:15:00Z",
            source: { kind: "codex-session" }
          },
          documents: { prompt: "public/.." },
          subjects: [],
          validators: []
        },
        null,
        2
      )
    );

    const result = await validateCaseBundle(caseDir, { strict: false });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("Unsafe or invalid case-local path");
  });
});

describe("pbench codex capture flow", () => {
  test("asks for confirmation with session and baseline details before capture", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const gitRoot = git(repo, ["rev-parse", "--show-toplevel"]);
    const sessionJsonl = await writeCodexSession(repo, commit);
    let seenPlan: Record<string, unknown> | undefined;

    await expect(
      captureTestCodexSession({
        cwd: repo,
        workspaceRoot,
        input: sessionJsonl,
        title: "Done file missing",
        confirm: (plan: Record<string, unknown>) => {
          seenPlan = plan;
          return false;
        }
      } as Parameters<typeof captureCodexSession>[0] & {
        confirm: (plan: Record<string, unknown>) => boolean;
      })
    ).rejects.toThrow("Capture cancelled");

    expect(seenPlan).toMatchObject({
      inputPath: sessionJsonl,
      sourceRepoRoot: gitRoot,
      baselineCommit: commit,
      title: "Done file missing"
    });
  });

  test("capture command pre-fills private docs from session evidence without TODO authoring placeholders", async () => {
    const repo = await makeRepo();
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit, [
      {
        type: "message",
        role: "assistant",
        content: "Done, all checks pass."
      },
      {
        type: "message",
        role: "user",
        content: "This is still wrong; done.txt was never created."
      }
    ]);
    const originalCwd = process.cwd();
    process.chdir(repo);
    try {
      const output = await createPbenchCommands({ home })
        .find((command) => command.action === "capture")
        ?.run([
          "--source",
          "codex",
          "--workspace",
          workspaceRoot,
          "--input",
          sessionJsonl,
          "--title",
          "Done file missing",
          "--yes"
        ]);
      const result = JSON.parse(String(output));
      const failure = await readFile(join(result.caseDir, "private", "failure.md"), "utf8");
      const success = await readFile(join(result.caseDir, "private", "success.md"), "utf8");
      const verification = await readFile(join(result.caseDir, "private", "verification.md"), "utf8");
      const validator = await readFile(join(result.caseDir, "private", "validators", "check-completion.mjs"), "utf8");
      const checklist = await readFile(result.authoringChecklistPath, "utf8");

      expect(result.initialValidation.ok).toBe(false);
      expect(result.initialValidation.warnings).not.toContain("private/failure.md still contains TODO");
      expect(result.initialValidation.warnings).not.toContain("private/success.md still contains TODO");
      expect(result.initialValidation.warnings).not.toContain("private/verification.md still contains TODO");
      expect(result.initialValidation.warnings).toContain(
        "private/validators/check-completion.mjs needs completion logic from session correction evidence"
      );
      expect(failure).toContain("done.txt was never created");
      expect(success).toContain("Make tests pass by creating done.txt");
      expect(success).toContain("done.txt was never created");
      expect(verification).toContain("completion validator");
      expect(validator).toContain("PBENCH_AUTHORING_REQUIRED");
      expect(`${failure}\n${success}\n${verification}`).not.toContain("TODO");
      expect(result.authoringChecklistPath).toBe(join(result.caseDir, "private", "authoring-checklist.md"));
      expect(checklist).toContain("- Prompt present: yes");
      expect(checklist).toContain("- Failure evidence present: yes");
      expect(checklist).toContain("- Replayable verification found: no");
      expect(checklist).toContain("- Generated validator: needs manual authoring");
      expect(result.next).toContain(`Review ${result.caseDir}`);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("capture blocks strict validation only for the validator when correction history exists without failed verification evidence", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeModernCodexSession({
      repo,
      commit,
      records: [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call_3",
            arguments: JSON.stringify({ cmd: "bun test", workdir: repo })
          }
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_3",
            output: "Process exited with code 0\nOutput:\nAll tests passed\n"
          }
        }
      ]
    });

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Suggestion diff still broken"
    });
    const warnings = (await createPbenchCommands()
      .find((command) => command.action === "validate")
      ?.run(["--case", tx.caseDir])) as string;
    const validation = JSON.parse(warnings);
    const failure = await readFile(join(tx.caseDir, "private", "failure.md"), "utf8");
    const success = await readFile(join(tx.caseDir, "private", "success.md"), "utf8");
    const verification = await readFile(join(tx.caseDir, "private", "verification.md"), "utf8");
    const strictValidation = await strictValidateTransaction(tx.transactionPath);

    expect(validation.ok).toBe(true);
    expect(strictValidation.ok).toBe(false);
    expect(strictValidation.errors.join("\n")).toContain("Unimplemented completion validator");
    expect(failure).toContain("suggestionDiff");
    expect(success).toContain("Fix the CR suggestionDiff parse failure before upload.");
    expect(verification).toContain("No failed verification command was detected");
    expect(`${failure}\n${success}\n${verification}`).not.toContain("TODO");
  });

  test("capture command warns when extracted replay evidence is empty", async () => {
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
    const originalCwd = process.cwd();
    process.chdir(repo);
    try {
      const output = await createPbenchCommands({ home })
        .find((command) => command.action === "capture")
        ?.run(["--source", "codex", "--workspace", workspaceRoot, "--input", sessionJsonl, "--yes"]);
      const result = JSON.parse(String(output));

      expect(result.initialValidation.warnings).toContain("public/prompt.md is empty");
      expect(result.initialValidation.warnings).toContain("public/command-observations.md has no command-like tool calls");
      expect(result.initialValidation.warnings).toContain(
        "private/failure-draft.md has no later user correction or command failure evidence"
      );
      expect(result.initialValidation.warnings).toContain("private/failure.md needs failure evidence from session history");
      expect(result.initialValidation.warnings).toContain(
        "private/validators/check-completion.mjs needs completion logic from session correction evidence"
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("generates a completion validator from a failed replayable verification command", async () => {
    const repo = await makeRepoWithFailingTest();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit, [
      {
        type: "exec_command",
        arguments: { cmd: "bun run test", workdir: repo },
        exit_code: 1,
        stderr: "done.txt is missing"
      },
      {
        type: "message",
        role: "user",
        content: "The benchmark should be complete only when done.txt exists and the test passes."
      }
    ]);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const validator = await readFile(join(tx.caseDir, "private", "validators", "check-completion.mjs"), "utf8");
    const verification = await readFile(join(tx.caseDir, "private", "verification.md"), "utf8");
    const validation = await strictValidateTransaction(tx.transactionPath);

    expect(validator).toContain("bun run test");
    expect(validator).not.toContain("PBENCH_AUTHORING_REQUIRED");
    expect(verification).toContain("bun run test");
    expect(validation.ok).toBe(true);
    expect(validation.validatorOutcomes?.[0]).toMatchObject({
      id: "completion",
      expected: "fail",
      actual: "fail"
    });
  });

  test("generated completion validator preserves captured repo-relative verification cwd", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, "packages", "app"), { recursive: true });
    await writeFile(join(repo, "packages", "app", "package.json"), "{\"scripts\":{\"test\":\"node check-done.mjs\"}}\n");
    await writeFile(
      join(repo, "packages", "app", "check-done.mjs"),
      "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('done.txt') ? 0 : 1);\n"
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "add app package"]);
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const appCwd = join(repo, "packages", "app");
    const sessionJsonl = await writeCodexSession(repo, commit, [
      {
        type: "exec_command",
        arguments: { cmd: "bun run test", workdir: appCwd },
        exit_code: 1,
        stderr: "packages/app/done.txt is missing"
      },
      {
        type: "message",
        role: "user",
        content: "The app package is only complete when packages/app/done.txt exists and its test passes."
      }
    ]);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "App package done file missing"
    });
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));
    const validator = await readFile(join(tx.caseDir, "private", "validators", "check-completion.mjs"), "utf8");
    const verification = await readFile(join(tx.caseDir, "private", "verification.md"), "utf8");
    const validation = await strictValidateTransaction(tx.transactionPath);

    expect(manifest.validators[0].cwd).toBe("packages/app");
    expect(validator).toContain("bun run test");
    expect(validator).not.toContain("PBENCH_AUTHORING_REQUIRED");
    expect(verification).toContain("- cwd: packages/app");
    expect(validation.ok).toBe(true);
    expect(validation.validatorOutcomes?.[0]).toMatchObject({
      id: "completion",
      expected: "fail",
      actual: "fail"
    });
  });

  test("unsafe verification cwd leaves validator unfinished and warns during capture", async () => {
    const repo = await makeRepoWithFailingTest();
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    const outsideCwd = await temp("outside-cwd");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit, [
      {
        type: "exec_command",
        arguments: { cmd: "bun run test", workdir: outsideCwd },
        exit_code: 1,
        stderr: "outside repo failure"
      },
      {
        type: "message",
        role: "user",
        content: "The task is only complete when the replayable repo check passes."
      }
    ]);

    const output = await pbenchCommand("capture", home).run([
      "--source",
      "codex",
      "--workspace",
      workspaceRoot,
      "--input",
      sessionJsonl,
      "--title",
      "Unsafe verification cwd",
      "--yes"
    ]);
    const result = JSON.parse(String(output));
    const validator = await readFile(join(result.caseDir, "private", "validators", "check-completion.mjs"), "utf8");
    const verification = await readFile(join(result.caseDir, "private", "verification.md"), "utf8");

    expect(validator).toContain("PBENCH_AUTHORING_REQUIRED");
    expect(verification).toContain("The captured verification cwd cannot be replayed safely");
    expect(result.initialValidation.warnings).toContain(
      "private/verification.md has unsafe verification cwd; implement validator manually"
    );
  });

  test("captures a Codex session, strict-validates the baseline failure, then finalizes the case", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));

    expect(tx.transactionPath).toContain("tx_done-file-missing_");
    expect(manifest.id).toMatch(/^case_done-file-missing_/);
    expect(manifest.subjects[0].baseline.commit).toBe(commit);
    await expect(
      readFile(join(tx.caseDir, "private", "artifacts", "extracted", "original-prompt.md"), "utf8")
    ).resolves.toContain("Make tests pass");

    await writeFile(join(tx.caseDir, "public", "prompt.md"), "Create done.txt at the repository root.\n");
    await writeFile(join(tx.caseDir, "private", "success.md"), "Success means done.txt exists.\n");
    await writeFile(
      join(tx.caseDir, "private", "verification.md"),
      "The validator checks for done.txt in the replay worktree.\n"
    );
    await writeFile(
      join(tx.caseDir, "private", "validators", "check-completion.mjs"),
      "import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\nprocess.exit(existsSync(join(process.env.PB_REPLAY_DIR, 'done.txt')) ? 0 : 1);\n"
    );

    const validation = await strictValidateTransaction(tx.transactionPath);
    expect(validation.ok).toBe(true);

    const finalized = await finalizeTransaction(tx.transactionPath);
    expect(finalized.casePath).toBe(join(workspaceRoot, "cases", manifest.id));
    await expect(stat(finalized.casePath)).resolves.toBeTruthy();
    await expect(stat(tx.transactionPath)).rejects.toThrow();
  });

  test("finalize rejects a bundle changed after strict validation", async () => {
    const prepared = await runnableTransaction();
    const validation = await strictValidateTransaction(prepared.tx.transactionPath);
    expect(validation.ok).toBe(true);

    await writeFile(
      join(prepared.tx.caseDir, "private", "validators", "check-completion.mjs"),
      "console.error('PBENCH_AUTHORING_REQUIRED'); process.exit(1);\n"
    );

    await expect(finalizeTransaction(prepared.tx.transactionPath)).rejects.toThrow(
      "Cannot finalize: strict validation failed"
    );
    await expect(stat(prepared.tx.transactionPath)).resolves.toBeTruthy();
  });

  test("stores capture authoring transactions under the ya-skills home cache", async () => {
    const repo = await makeRepo();
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);

    const tx = await captureTestCodexSession({
      cwd: repo,
      home,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Persistent capture"
    });

    expect(tx.transactionPath).toContain(join(home, ".ya-skills", "pbench", "tx_persistent-capture_"));
    await expect(stat(tx.transactionPath)).resolves.toBeTruthy();
    await expect(stat(tx.caseDir)).resolves.toBeTruthy();
  });

  test("extracts modern Codex payload messages, tool calls, and correction evidence", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeModernCodexSession({ repo, commit });

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true
    });
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));
    const prompt = await readFile(join(tx.caseDir, "public", "prompt.md"), "utf8");
    const context = await readFile(join(tx.caseDir, "public", "context.md"), "utf8");
    const observations = await readFile(join(tx.caseDir, "public", "command-observations.md"), "utf8");
    const failureDraft = await readFile(join(tx.caseDir, "private", "failure-draft.md"), "utf8");
    const sessionSummary = JSON.parse(
      await readFile(join(tx.caseDir, "private", "artifacts", "extracted", "session-summary.json"), "utf8")
    );
    const touchedFiles = await readFile(join(tx.caseDir, "private", "artifacts", "extracted", "touched-files.json"), "utf8");

    expect(manifest.title).toBe("Fix the CR suggestionDiff parse failure before upload.");
    expect(prompt).toContain("Fix the CR suggestionDiff parse failure before upload.");
    expect(prompt).not.toContain("AGENTS.md instructions");
    expect(context).toContain("modern-session-1");
    expect(context).toContain(commit);
    expect(observations).toContain("sed -n '1,120p' packages/papi-hub/src/features/code-review/index.ts");
    expect(observations).toContain("exitCode: 1");
    expect(observations).toContain("TSX parse failure");
    expect(failureDraft).toContain("还是不太对");
    expect(failureDraft).toContain("TSX parse failure");
    expect(sessionSummary.userMessageCount).toBe(2);
    expect(sessionSummary.toolCallCount).toBe(2);
    expect(touchedFiles).toContain("packages/papi-hub/src/features/code-review/index.ts");
  });

  test("uses session cwd and git baseline when capture is run from another repository", async () => {
    const subjectRepo = await makeRepo();
    const captureRepo = await makeRepo();
    await writeFile(join(captureRepo, "capture-only.txt"), "capture repo only\n");
    git(captureRepo, ["add", "capture-only.txt"]);
    git(captureRepo, ["commit", "-m", "different capture repo head"]);
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const subjectCommit = git(subjectRepo, ["rev-parse", "HEAD"]);
    const captureCommit = git(captureRepo, ["rev-parse", "HEAD"]);
    const subjectGitRoot = git(subjectRepo, ["rev-parse", "--show-toplevel"]);
    const sessionJsonl = await writeModernCodexSession({ repo: subjectRepo, commit: subjectCommit });

    const tx = await captureTestCodexSession({
      cwd: captureRepo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true
    });
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));

    expect(manifest.subjects[0].sourceRootAtCapture).toBe(subjectGitRoot);
    expect(manifest.subjects[0].baseline.commit).toBe(subjectCommit);
    expect(manifest.subjects[0].baseline.commit).not.toBe(captureCommit);
    await expect(
      readFile(join(tx.caseDir, "public", "agent-instructions.md"), "utf8")
    ).resolves.toContain(".agents/skills");
  });

  test("finds a session by scanning Codex sessions when the index omits file paths", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    const fakeHome = await temp("home");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    await writeModernCodexSession({ repo, commit, home: fakeHome, sessionId: "scan-session-1" });
    await mkdir(join(fakeHome, ".codex"), { recursive: true });
    await writeFile(
      join(fakeHome, ".codex", "session_index.jsonl"),
      `${JSON.stringify({
        id: "scan-session-1",
        thread_name: "Fix scanned session",
        updated_at: "2026-06-04T06:30:00Z"
      })}\n`
    );

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      sessionId: "scan-session-1",
      home: fakeHome,
      yes: true
    });
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));

    expect(manifest.metadata.source.sessionId).toBe("scan-session-1");
    expect(manifest.subjects[0].baseline.commit).toBe(commit);
  });

  test("resolves a session by id from its filename without reading competing session files", async () => {
    // The codex session index carries only {id, thread_name, updated_at} — no file path — so a
    // session id must resolve to its transcript file. Codex embeds the id in the filename
    // (rollout-<ts>-<sessionId>.jsonl), so resolution must match the filename rather than opening
    // every transcript. The bait file below carries the requested id in its *content* but not its
    // filename and is the newest session: a content-scanning resolver would pick it and capture
    // the wrong prompt; a filename-based resolver must skip it.
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    const fakeHome = await temp("home");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionsDir = join(fakeHome, ".codex", "sessions", "2026", "06", "24");
    await mkdir(sessionsDir, { recursive: true });

    await writeFile(
      join(sessionsDir, "rollout-2026-06-24T10-00-00-capture-target.jsonl"),
      modernSessionPayloadJsonl({
        metaId: "capture-target",
        cwd: repo,
        commit,
        prompt: "TARGET PROMPT MARKER",
        timestamp: "2026-06-24T10:00:00.000Z"
      })
    );
    await writeFile(
      join(sessionsDir, "rollout-2026-06-24T09-00-00-older-decoy.jsonl"),
      modernSessionPayloadJsonl({
        metaId: "older-decoy",
        cwd: repo,
        commit,
        prompt: "OLDER DECOY MARKER",
        timestamp: "2026-06-24T09:00:00.000Z"
      })
    );
    await writeFile(
      join(sessionsDir, "rollout-2026-06-24T11-00-00-stale-decoy.jsonl"),
      modernSessionPayloadJsonl({
        metaId: "capture-target",
        cwd: repo,
        commit,
        prompt: "STALE DECOY MARKER",
        timestamp: "2026-06-24T11:00:00.000Z"
      })
    );
    await mkdir(join(fakeHome, ".codex"), { recursive: true });
    await writeFile(
      join(fakeHome, ".codex", "session_index.jsonl"),
      [
        { id: "older-decoy", thread_name: "older", updated_at: "2026-06-24T09:30:00Z" },
        { id: "capture-target", thread_name: "target", updated_at: "2026-06-24T10:30:00Z" },
        { id: "capture-target", thread_name: "stale", updated_at: "2026-06-24T11:30:00Z" }
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n"
    );

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      sessionId: "capture-target",
      home: fakeHome,
      yes: true
    });
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));
    const prompt = await readFile(join(tx.caseDir, "public", "prompt.md"), "utf8");

    expect(manifest.metadata.source.sessionId).toBe("capture-target");
    expect(prompt).toContain("TARGET PROMPT MARKER");
    expect(prompt).not.toContain("STALE DECOY MARKER");
  });

  test("captures a Claude Code session through the platform-agnostic source registry", async () => {
    const repo = await makeRepoWithFailingTest();
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const transcript = await writeClaudeTranscript({ cwd: repo });

    const output = await createPbenchCommands({ home })
      .find((command) => command.action === "capture")
      ?.run(["--source", "claude", "--workspace", workspaceRoot, "--input", transcript, "--yes"]);
    const result = JSON.parse(String(output));
    const manifest = JSON.parse(await readFile(join(result.caseDir, "case.json"), "utf8"));
    const prompt = await readFile(join(result.caseDir, "public", "prompt.md"), "utf8");
    const observations = await readFile(join(result.caseDir, "public", "command-observations.md"), "utf8");

    expect(manifest.metadata.source.kind).toBe("claude-session");
    expect(manifest.metadata.source.sessionId).toBe("claude-session-1");
    expect(manifest.metadata.tags).toContain("claude");
    expect(prompt).toContain("Fix the login bug");
    expect(observations).toContain("bun run test");
    expect(observations).toContain("exitCode: 1");
    await expect(
      readFile(join(result.caseDir, "private", "artifacts", "raw", "claude-session.jsonl"), "utf8")
    ).resolves.toContain("claude-test");
  });

  test("extracts Codex errors and approval/sandbox context as private artifacts", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit, [
      {
        type: "exec_command",
        arguments: { cmd: "bun test" },
        exit_code: 1,
        stderr: "expected failure"
      },
      {
        type: "approval_request",
        sandbox_permissions: "require_escalated",
        justification: "Need network"
      }
    ]);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });

    await expect(
      readFile(join(tx.caseDir, "private", "artifacts", "extracted", "errors.json"), "utf8")
    ).resolves.toContain("expected failure");
    await expect(
      readFile(join(tx.caseDir, "private", "artifacts", "extracted", "approval-sandbox.json"), "utf8")
    ).resolves.toContain("workspace-write");
    await expect(
      readFile(join(tx.caseDir, "private", "artifacts", "extracted", "approval-sandbox.json"), "utf8")
    ).resolves.toContain("require_escalated");
  });

  test("detects Bun setup commands for Bun repositories", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "bun.lock"), "");
    git(repo, ["add", "bun.lock"]);
    git(repo, ["commit", "-m", "add bun lock"]);
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));

    expect(manifest.setupCommands).toEqual([
      { command: "bun install --frozen-lockfile", cwd: ".", timeoutSeconds: 300 }
    ]);
  });

  test("writes public replay files and references them from the case manifest", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));
    const replay = await readFile(join(tx.caseDir, "public", "replay.md"), "utf8");
    const contextManifest = JSON.parse(await readFile(join(tx.caseDir, "public", "context.manifest.json"), "utf8"));

    expect(manifest.documents.replay).toBe("public/replay.md");
    expect(manifest.documents.replayManifest).toBe("public/replay.manifest.json");
    expect(manifest.documents.contextManifest).toBe("public/context.manifest.json");
    expect(manifest.documents.agentInstructions).toBe("public/agent-instructions.md");
    expect(manifest.documents.keyObservations).toBe("public/key-observations.md");
    expect(manifest.documents.commandObservations).toBe("public/command-observations.md");
    expect(manifest.documents.failureDraft).toBe("private/failure-draft.md");
    expect(replay).toContain("Done file missing");
    expect(replay).toContain(commit);
    expect(replay).toContain("public/replay.manifest.json");
    expect(contextManifest.caseId).toBe(tx.caseId);
    expect(contextManifest.baseline.commit).toBe(commit);
    expect(contextManifest.replayFiles.replayManifest).toBe("public/replay.manifest.json");
    expect(contextManifest.replayFiles.keyObservations).toBe("public/key-observations.md");
    expect(contextManifest.replayFiles.commandObservations).toBe("public/command-observations.md");
    expect(contextManifest.replayRequirements).toEqual({
      profile: "local",
      network: "unknown",
      requiredEnv: [],
      notes: []
    });
    await expect(readFile(join(tx.caseDir, "public", "replay.manifest.json"), "utf8")).resolves.toContain(tx.caseId);
  });

  test("exports a public-only replay capsule without private evaluator files", async () => {
    const repo = await makeRepo();
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);
    const tx = await captureTestCodexSession({
      cwd: repo,
      home,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const outDir = join(await temp("export-root"), "replay");

    const output = await createPbenchCommands({ home })
      .find((command) => command.action === "export-replay")
      ?.run(["--case", tx.caseDir, "--out", outDir]);
    const result = JSON.parse(String(output));
    const publicCase = JSON.parse(await readFile(join(outDir, "case.public.json"), "utf8"));

    expect(result.outDir).toBe(outDir);
    await expect(stat(join(outDir, "public", "prompt.md"))).resolves.toBeTruthy();
    await expect(stat(join(outDir, "public", "replay.manifest.json"))).resolves.toBeTruthy();
    await expect(stat(join(outDir, "case.json"))).rejects.toThrow();
    await expect(stat(join(outDir, "private", "failure.md"))).rejects.toThrow();
    expect(Object.values(publicCase.documents).every((value) => typeof value === "string" && value.startsWith("public/"))).toBe(true);
    expect(JSON.stringify(publicCase)).not.toContain("private/failure");
    expect(JSON.stringify(publicCase)).not.toContain("private/validators");
    expect(JSON.stringify(publicCase)).not.toContain("sourceRootAtCapture");
    expect(publicCase.documents.prompt).toBe("public/prompt.md");
    expect(publicCase.documents.failure).toBeUndefined();
  });

  test("rejects public replay export when public files reference private evaluator paths", async () => {
    const repo = await makeRepo();
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);
    const tx = await captureTestCodexSession({
      cwd: repo,
      home,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    await writeFile(join(tx.caseDir, "public", "leak.md"), "Read private/failure.md to pass.\n");

    await expect(
      createPbenchCommands({ home })
        .find((command) => command.action === "export-replay")
        ?.run(["--case", tx.caseDir, "--out", join(await temp("export-root"), "replay")])
    ).rejects.toThrow("private evaluator path");
  });

  test("rejects public replay export when public files reference absolute /private paths", async () => {
    const repo = await makeRepo();
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);
    const tx = await captureTestCodexSession({
      cwd: repo,
      home,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    await writeFile(join(tx.caseDir, "public", "leak.md"), "Read /private/var/folders/pbench/private/validators/check-completion.mjs.\n");

    await expect(
      pbenchCommand("export-replay", home).run(["--case", tx.caseDir, "--out", join(await temp("export-root"), "replay")])
    ).rejects.toThrow("private evaluator path");
  });

  test("strict validation fails before replay when required replay environment is missing", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);
    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const manifestPath = join(tx.caseDir, "case.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.replayRequirements = {
      profile: "live-integration",
      network: "required",
      requiredEnv: ["PBENCH_TEST_MISSING_ENV_FOR_STRICT_VALIDATION"],
      notes: ["test-only required env"]
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const validation = await strictValidateTransaction(tx.transactionPath);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("Missing required replay environment variables");
    expect(validation.errors.join("\n")).toContain("PBENCH_TEST_MISSING_ENV_FOR_STRICT_VALIDATION");
    expect(validation.errors.join("\n")).not.toContain(String(process.env.PBENCH_TEST_MISSING_ENV_FOR_STRICT_VALIDATION));
  });

  test("captures repo agent instructions and installed skill names into public replay context", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "AGENTS.md"), "Always run the focused test before final response.\n");
    await mkdir(join(repo, ".agents", "skills", "pbench"), { recursive: true });
    await mkdir(join(repo, ".claude", "skills", "reviewer"), { recursive: true });
    git(repo, ["add", "AGENTS.md"]);
    git(repo, ["commit", "-m", "add agent instructions"]);
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const instructions = await readFile(join(tx.caseDir, "public", "agent-instructions.md"), "utf8");

    expect(instructions).toContain("Always run the focused test");
    expect(instructions).toContain(".agents/skills: pbench");
    expect(instructions).toContain(".claude/skills: reviewer");
  });

  test("keeps unproven tracked changes private until replay-start authoring resolves them", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "ok.mjs"), "console.log('possible repair');\n");
    const { tx } = await captureRepoTransaction(repo);
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));

    await expect(readFile(join(tx.caseDir, "public", "starting.patch"), "utf8")).rejects.toThrow();
    await expect(readFile(join(tx.caseDir, "private", "artifacts", "extracted", "starting.patch"), "utf8"))
      .resolves.toContain("possible repair");
    expect(manifest.replayStart.status).toBe("unresolved");

    const validation = await strictValidateTransaction(tx.transactionPath);
    expect(validation.errors).toContain("START_STATE_UNRESOLVED: choose baseline or curate replay-start files");
    const checklist = await readFile(join(tx.caseDir, "private", "authoring-checklist.md"), "utf8");
    expect(checklist).toContain("Replay start needs authoring");
    expect(checklist).toContain("baseline");
    expect(checklist).toContain("curated");
  });

  test("keeps unproven untracked files out of the public replay capsule", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "add ignore rules"]);
    await mkdir(join(repo, "notes"), { recursive: true });
    await writeFile(join(repo, "notes", "answer.txt"), "possible repair\n");
    await writeFile(join(repo, "ignored.txt"), "Do not capture\n");
    const { tx } = await captureRepoTransaction(repo);
    const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));
    const contextManifest = JSON.parse(await readFile(join(tx.caseDir, "public", "context.manifest.json"), "utf8"));

    await expect(
      readFile(join(tx.caseDir, "public", "context-files", "untracked", "notes", "answer.txt"), "utf8")
    ).rejects.toThrow();
    await expect(
      readFile(join(tx.caseDir, "private", "artifacts", "extracted", "untracked", "notes", "answer.txt"), "utf8")
    ).resolves.toBe("possible repair\n");
    expect(manifest.replayStart.status).toBe("unresolved");
    expect(manifest.replayStart.candidateUntrackedManifest).toBe(
      "private/artifacts/extracted/untracked.manifest.json"
    );
    expect(contextManifest.contextFiles).toEqual([]);
    expect(JSON.stringify(contextManifest)).not.toContain("ignored.txt");
  });

  test("accepts baseline-only replay-start authoring", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "ok.mjs"), "console.log('discard this dirty state');\n");
    const { tx } = await captureRepoTransaction(repo);
    const manifestPath = join(tx.caseDir, "case.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.replayStart = { status: "baseline" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const validation = await strictValidateTransaction(tx.transactionPath);
    expect(validation.errors).not.toContain(
      "START_STATE_UNRESOLVED: choose baseline or curate replay-start files"
    );
  });

  test("accepts explicitly curated replay-start files", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "ok.mjs"), "console.log('curated tracked context');\n");
    await mkdir(join(repo, "notes"), { recursive: true });
    await writeFile(join(repo, "notes", "context.txt"), "curated untracked context\n");
    const { tx } = await captureRepoTransaction(repo);
    const manifestPath = join(tx.caseDir, "case.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.replayStart = { status: "curated" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const privatePatch = await readFile(
      join(tx.caseDir, "private", "artifacts", "extracted", "starting.patch"),
      "utf8"
    );
    await writeFile(join(tx.caseDir, "public", "starting.patch"), privatePatch);
    const publicContextPath = join(tx.caseDir, "public", "context-files", "untracked", "notes", "context.txt");
    await mkdir(join(tx.caseDir, "public", "context-files", "untracked", "notes"), { recursive: true });
    await writeFile(publicContextPath, "curated untracked context\n");

    for (const name of ["context.manifest.json", "replay.manifest.json"]) {
      const publicManifestPath = join(tx.caseDir, "public", name);
      const publicManifest = JSON.parse(await readFile(publicManifestPath, "utf8"));
      publicManifest.replayFiles.startingPatch = "public/starting.patch";
      publicManifest.contextFiles = [
        {
          source: "notes/context.txt",
          publicPath: "public/context-files/untracked/notes/context.txt",
          kind: "untracked"
        }
      ];
      await writeFile(publicManifestPath, `${JSON.stringify(publicManifest, null, 2)}\n`);
    }

    const validation = await strictValidateTransaction(tx.transactionPath);
    expect(validation.errors).not.toContain(
      "START_STATE_UNRESOLVED: choose baseline or curate replay-start files"
    );
  });

  test("writes bounded public command observations and private failure draft", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit, [
      {
        type: "exec_command",
        arguments: { cmd: "bun test", workdir: repo },
        exit_code: 1,
        stdout: "test output",
        stderr: "missing done.txt"
      },
      {
        type: "message",
        role: "assistant",
        content: "Done, tests pass."
      },
      {
        type: "message",
        role: "user",
        content: "This is still wrong; done.txt was never created."
      }
    ]);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const observations = await readFile(join(tx.caseDir, "public", "command-observations.md"), "utf8");
    const failureDraft = await readFile(join(tx.caseDir, "private", "failure-draft.md"), "utf8");

    expect(observations).toContain("bun test");
    expect(observations).toContain("exitCode: 1");
    expect(observations).toContain("missing done.txt");
    expect(failureDraft).toContain("This is still wrong");
    expect(failureDraft).toContain("missing done.txt");
  });

  test("sanitizes private absolute paths from public command observations before replay", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit, [
      {
        type: "exec_command",
        arguments: { cmd: "bun test", workdir: "/private/var/folders/pbench/source-repo" },
        exit_code: 1,
        stdout: "read /private/var/folders/pbench/source-repo/public.log",
        stderr: "validator at /private/var/folders/pbench/case/private/validators/check-completion.mjs failed"
      }
    ]);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const observations = await readFile(join(tx.caseDir, "public", "command-observations.md"), "utf8");
    const keyObservations = await readFile(join(tx.caseDir, "public", "key-observations.md"), "utf8");

    expect(`${observations}\n${keyObservations}`).toContain("<private-path>");
    expectNoAgentVisiblePrivateReferences(`${observations}\n${keyObservations}`);
  });

  test("writes key observations for failed and verification commands without skill bootstrap noise", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit, [
      {
        type: "exec_command",
        arguments: {
          cmd: "sed -n '1,120p' /Users/suosuo/.codex/plugins/cache/openai-curated/superpowers/x/skills/using-superpowers/SKILL.md",
          workdir: repo
        },
        exit_code: 0,
        stdout: "bootstrap skill"
      },
      {
        type: "exec_command",
        arguments: { cmd: "bun test", workdir: repo },
        exit_code: 1,
        stdout: "test output",
        stderr: "missing done.txt"
      },
      {
        type: "exec_command",
        arguments: { cmd: "yk pbench capture --source codex --yes", workdir: repo },
        exit_code: 1,
        stderr: "No matching Codex session found"
      }
    ]);

    const tx = await captureTestCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const keyObservations = await readFile(join(tx.caseDir, "public", "key-observations.md"), "utf8");

    expect(keyObservations).toContain("bun test");
    expect(keyObservations).toContain("missing done.txt");
    expect(keyObservations).not.toContain("using-superpowers");
    expect(keyObservations).not.toContain("yk pbench capture");
  });

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

    expect(runJson.profile).toBe("manual-agent");
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

    expect(Object.keys(finished).sort()).toEqual(["failingValidatorId", "runId", "status"]);
    expect(finished.status).toBe("validator_failed");
    expect(finished.failingValidatorId).toBeTruthy();
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
      expect(runJson.isolation).toBe("workspace-write");
      expect(runJson.attemptNumber).toBe(1);
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
      contaminated: false
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
    const report = JSON.parse(String(await pbenchCommand("report", home).run(["--workspace", workspaceRoot])));
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

  test("installs the runner skill with integrity boundaries and the access-audit rule (P3)", async () => {
    const { home, workspaceRoot, caseId } = await finalizedRunnableCase();
    const started = JSON.parse(
      String(await pbenchCommand("start", home).run(["--case", caseId, "--workspace", workspaceRoot]))
    );
    const skill = await readFile(join(started.worktree, ".agents", "skills", "pbench-runner", "SKILL.md"), "utf8");
    expect(skill).toContain("Integrity boundaries");
    expect(skill).toContain("access-audit.jsonl");
    expect(skill).toContain("one-shot");
    expect(skill).toContain("run-artifacts");
    expect(skill).toContain("harness implementation");
    // The integrity prose must not itself trip the fail-closed private-reference gate.
    expectNoAgentVisiblePrivateReferences(skill);
    // SSOT: the installed runner skill must match the checked-in source verbatim, so the embedded
    // install copy cannot silently diverge from skills/pbench-runner/SKILL.md.
    const checkedInSource = await readFile(join(process.cwd(), "skills", "pbench-runner", "SKILL.md"), "utf8");
    expect(skill).toBe(checkedInSource);
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

  test("reports empty totals when the workspace has no runs", async () => {
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);

    const output = await pbenchCommand("report", home).run(["--workspace", workspaceRoot]);
    const report = JSON.parse(String(output));

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

  test("aggregates run artifacts by status, profile, case, and tokens", async () => {
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    await writeRunArtifact(workspaceRoot, {
      runId: "run_a",
      caseId: "case_one_20260612T000000Z",
      profile: "baseline",
      status: "passed",
      durationMs: 100,
      tokenUsage: { input_tokens: 10, output_tokens: 5 }
    });
    await writeRunArtifact(workspaceRoot, {
      runId: "run_b",
      caseId: "case_one_20260612T000000Z",
      profile: "current",
      status: "validator_failed",
      durationMs: 200,
      tokenUsage: { input_tokens: 20, output_tokens: 10 }
    });
    await writeRunArtifact(workspaceRoot, {
      runId: "run_c",
      caseId: "case_two_20260612T000000Z",
      profile: "current",
      status: "agent_failed",
      durationMs: 300,
      tokenUsage: { input_tokens: 30, output_tokens: 15 },
      manualIntervention: true
    });
    await writeRunArtifact(workspaceRoot, {
      runId: "run_d",
      caseId: "case_two_20260612T000000Z",
      status: "setup_failed",
      durationMs: 400
    });

    const report = JSON.parse(String(await pbenchCommand("report", home).run(["--workspace", workspaceRoot])));
    const current = JSON.parse(
      String(await pbenchCommand("report", home).run(["--workspace", workspaceRoot, "--profile", "current"]))
    );
    const oneCase = JSON.parse(
      String(await pbenchCommand("report", home).run(["--workspace", workspaceRoot, "--case", "case_one_20260612T000000Z"]))
    );

    expect(report.totals).toMatchObject({
      runs: 4,
      cases: 2,
      manualIntervention: 1,
      statusCounts: {
        passed: 1,
        validator_failed: 1,
        agent_failed: 1,
        setup_failed: 1
      }
    });
    expect(report.profiles.baseline).toMatchObject({
      runs: 1,
      passed: 1,
      passRate: 1,
      averageDurationMs: 100,
      tokenUsage: { input_tokens: 10, output_tokens: 5 }
    });
    expect(report.profiles.current).toMatchObject({
      runs: 2,
      passed: 0,
      passRate: 0,
      averageDurationMs: 250,
      tokenUsage: { input_tokens: 50, output_tokens: 25 }
    });
    expect(report.profiles.default).toMatchObject({
      runs: 1,
      passed: 0,
      passRate: 0,
      averageDurationMs: 400
    });
    expect(report.cases.case_one_20260612T000000Z.statusCounts).toEqual({ passed: 1, validator_failed: 1 });
    expect(current.totals.runs).toBe(2);
    expect(Object.keys(current.profiles)).toEqual(["current"]);
    expect(oneCase.totals.runs).toBe(2);
    expect(Object.keys(oneCase.cases)).toEqual(["case_one_20260612T000000Z"]);
  });

  test("renders markdown report with case and recent run tables without private evaluator paths", async () => {
    const home = await temp("home");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const artifactDir = await writeRunArtifact(workspaceRoot, {
      runId: "run_markdown",
      caseId: "case_markdown_20260612T000000Z",
      profile: "current",
      status: "passed",
      durationMs: 100,
      tokenUsage: { input_tokens: 10, output_tokens: 5 }
    });

    const markdown = String(
      await pbenchCommand("report", home).run(["--workspace", workspaceRoot, "--format", "markdown"])
    );

    expect(markdown).toContain("| current | 1 | 1 | 100.0% | 100 | 10 | 5 |");
    expect(markdown).toContain("| passed | 1 |");
    expect(markdown).toContain("## Cases");
    expect(markdown).toContain("| Case | Runs | Profiles | Statuses |");
    expect(markdown).toContain("| case_markdown_20260612T000000Z | 1 | current: 1 | passed: 1 |");
    expect(markdown).toContain("## Recent Runs");
    expect(markdown).toContain("| Run | Case | Profile | Status | Duration (ms) | Summary |");
    expect(markdown).toContain(
      `| run_markdown | case_markdown_20260612T000000Z | current | passed | 100 | ${join(artifactDir, "summary.md")} |`
    );
    expect(markdown).not.toContain("private/validators");
    expect(markdown).not.toContain("PB_PRIVATE_DIR");
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
