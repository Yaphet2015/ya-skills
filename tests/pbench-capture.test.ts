import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { createPbenchFixtures } from "./helpers/pbench-fixtures.js";

const fixtures = createPbenchFixtures();
afterEach(fixtures.cleanup);
const {
  temp,
  captureRepoTransaction,
  captureTestCodexSession,
  git,
  makeRepo,
  makeRepoWithFailingTest,
  modernSessionPayloadJsonl,
  expectNoAgentVisiblePrivateReferences,
  pbenchCommand,
  runnableTransaction,
  writeClaudeTranscript,
  writeCodexSession,
  writeModernCodexSession
} = fixtures;
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

describe("pbench capture and replay flow", () => {
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
      expect(result.state).toBe("needs-authoring");
      expect(result.nextAction).toBe(`Read ${result.authoringChecklistPath}`);
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
    const privateDocuments = await Promise.all(
      ["failure.md", "success.md", "verification.md"].map((name) =>
        readFile(join(result.caseDir, "private", name), "utf8")
      )
    );

    expect(manifest.metadata.source.kind).toBe("claude-session");
    expect(manifest.metadata.source.sessionId).toBe("claude-session-1");
    expect(manifest.metadata.tags).toContain("claude");
    expect(prompt).toContain("Fix the login bug");
    expect(observations).toContain("bun run test");
    expect(observations).toContain("exitCode: 1");
    expect(privateDocuments.join("\n")).toContain("coding-agent session history");
    expect(privateDocuments.join("\n")).not.toContain("Codex session history");
    expect(result.state).toBe("ready-to-finalize");
    expect(result.nextAction).toBe(`yk pbench finalize --transaction ${result.transactionPath}`);
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

  test("does not capture repository-external files through untracked symlinks", async () => {
    const repo = await makeRepo();
    const externalDir = await temp("external-secret");
    await writeFile(join(externalDir, "secret.txt"), "PRIVATE_SYMLINK_SECRET\n");
    await symlink(join(externalDir, "secret.txt"), join(repo, "linked-secret.txt"));

    const { tx } = await captureRepoTransaction(repo);
    const candidateManifest = await readFile(
      join(tx.caseDir, "private", "artifacts", "extracted", "untracked.manifest.json"),
      "utf8"
    );

    await expect(
      readFile(join(tx.caseDir, "private", "artifacts", "extracted", "untracked", "linked-secret.txt"), "utf8")
    ).rejects.toThrow();
    expect(candidateManifest).toContain('"reason": "symbolic link"');
    expect(candidateManifest).not.toContain("PRIVATE_SYMLINK_SECRET");
  });

  test("accepts baseline-only replay-start authoring", async () => {
    const prepared = await runnableTransaction({ dirtyStart: true, dirtyStartResolution: "baseline" });

    const validation = await strictValidateTransaction(prepared.tx.transactionPath);

    expect(validation.ok).toBe(true);
    await expect(readFile(join(prepared.tx.caseDir, "public", "starting.patch"), "utf8")).rejects.toThrow();
  });

  test("accepts explicitly curated replay-start files", async () => {
    const prepared = await runnableTransaction({ dirtyStart: true, dirtyStartResolution: "curated" });

    const validation = await strictValidateTransaction(prepared.tx.transactionPath);

    expect(validation.ok).toBe(true);
    await expect(readFile(join(prepared.tx.caseDir, "public", "starting.patch"), "utf8")).resolves.toContain(
      "dirty starting point"
    );
  });

  test("rejects missing or unknown replay-start decisions", async () => {
    for (const status of [undefined, "typo"] as const) {
      const prepared = await runnableTransaction();
      const manifestPath = join(prepared.tx.caseDir, "case.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (status === undefined) {
        delete manifest.replayStart;
      } else {
        manifest.replayStart = { status };
      }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const validation = await strictValidateTransaction(prepared.tx.transactionPath);
      expect(validation.errors).toContain(
        "/replayStart.status must be clean, unresolved, baseline, or curated"
      );
    }
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
});
