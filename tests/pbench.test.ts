import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function makeRepoWithFailingTest(): Promise<string> {
  const repo = await temp("repo");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "pbench@example.local"]);
  git(repo, ["config", "user.name", "PBench Test"]);
  await writeFile(join(repo, "package.json"), "{\"scripts\":{\"test\":\"node check-done.mjs\"}}\n");
  await writeFile(
    join(repo, "check-done.mjs"),
    "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('done.txt') ? 0 : 1);\n"
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "baseline"]);
  return repo;
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
      captureCodexSession({
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
      const output = await createPbenchCommands()
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

    const tx = await captureCodexSession({
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
      const output = await createPbenchCommands()
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

    const tx = await captureCodexSession({
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

  test("captures a Codex session, strict-validates the baseline failure, then finalizes the case", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);

    const tx = await captureCodexSession({
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

  test("extracts modern Codex payload messages, tool calls, and correction evidence", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeModernCodexSession({ repo, commit });

    const tx = await captureCodexSession({
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

    const tx = await captureCodexSession({
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

    const tx = await captureCodexSession({
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

    const tx = await captureCodexSession({
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

    const tx = await captureCodexSession({
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

    const tx = await captureCodexSession({
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
    expect(manifest.documents.contextManifest).toBe("public/context.manifest.json");
    expect(manifest.documents.agentInstructions).toBe("public/agent-instructions.md");
    expect(manifest.documents.commandObservations).toBe("public/command-observations.md");
    expect(manifest.documents.failureDraft).toBe("private/failure-draft.md");
    expect(replay).toContain("Done file missing");
    expect(replay).toContain(commit);
    expect(replay).toContain("public/context.manifest.json");
    expect(contextManifest.caseId).toBe(tx.caseId);
    expect(contextManifest.baseline.commit).toBe(commit);
    expect(contextManifest.replayFiles.commandObservations).toBe("public/command-observations.md");
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

    const tx = await captureCodexSession({
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

  test("captures tracked dirty changes as public starting patch", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "ok.mjs"), "console.log('dirty starting point');\nprocess.exit(0);\n");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);

    const tx = await captureCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const patch = await readFile(join(tx.caseDir, "public", "starting.patch"), "utf8");
    const contextManifest = JSON.parse(await readFile(join(tx.caseDir, "public", "context.manifest.json"), "utf8"));

    expect(patch).toContain("dirty starting point");
    expect(contextManifest.replayFiles.startingPatch).toBe("public/starting.patch");
  });

  test("copies non-ignored untracked text files and warns about ignored files", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "add ignore rules"]);
    await mkdir(join(repo, "notes"), { recursive: true });
    await writeFile(join(repo, "notes", "context.txt"), "Important local context\n");
    await writeFile(join(repo, "ignored.txt"), "Do not capture\n");
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);

    const tx = await captureCodexSession({
      cwd: repo,
      workspaceRoot,
      input: sessionJsonl,
      yes: true,
      title: "Done file missing"
    });
    const copied = await readFile(join(tx.caseDir, "public", "context-files", "untracked", "notes", "context.txt"), "utf8");
    const contextManifest = JSON.parse(await readFile(join(tx.caseDir, "public", "context.manifest.json"), "utf8"));

    expect(copied).toBe("Important local context\n");
    expect(contextManifest.contextFiles).toEqual([
      {
        source: "notes/context.txt",
        publicPath: "public/context-files/untracked/notes/context.txt",
        kind: "untracked"
      }
    ]);
    expect(JSON.stringify(contextManifest)).not.toContain("ignored.txt");
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

    const tx = await captureCodexSession({
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
});
