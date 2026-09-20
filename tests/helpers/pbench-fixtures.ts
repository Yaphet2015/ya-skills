import { expect } from "bun:test";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureCodexSession,
  createPbenchCommands,
  finalizeTransaction,
  initWorkspace,
  strictValidateTransaction
} from "@ya-skills/functions-pbench";

export function createPbenchFixtures() {
  const cleanupPaths: string[] = [];

  async function cleanup(): Promise<void> {
    await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  }

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
    dirtyStartResolution?: "baseline" | "curated";
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
      const resolution = options.dirtyStartResolution ?? "curated";
      const manifestPath = join(tx.caseDir, "case.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.replayStart = { status: resolution };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      if (resolution === "curated") {
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
      agentVersion?: string | null;
      manualIntervention?: boolean;
      isolation?: string;
      integrity?: "enforced" | "instruction-only" | "unknown" | "contaminated";
      terminal?: boolean;
      validatorExecuted?: boolean;
      contaminated?: boolean;
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
          agentVersion: "codex-test 0.0.0",
          manualIntervention: false,
          isolation: "workspace-write",
          integrity: "enforced",
          validatorExecuted: true,
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

  return {
    cleanup,
    temp,
    repoTemp,
    captureTestCodexSession,
    captureRepoTransaction,
    git,
    makeRepo,
    makeRepoWithFailingTest,
    runnableTransaction,
    finalizedRunnableCase,
    writeRunArtifact,
    pbenchCommand,
    writeFakeCodex,
    writeFakeClaude,
    expectNoAgentVisiblePrivateReferences,
    writeCodexSession,
    writeModernCodexSession,
    modernSessionPayloadJsonl,
    writeClaudeTranscript
  };
}
