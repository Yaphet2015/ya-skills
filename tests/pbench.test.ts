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

  test("capture command prints initial validation warnings for authoring placeholders", async () => {
    const repo = await makeRepo();
    const workspaceRoot = join(await temp("workspace-root"), "workspace");
    await initWorkspace(workspaceRoot);
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const sessionJsonl = await writeCodexSession(repo, commit);
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

      expect(result.initialValidation.ok).toBe(false);
      expect(result.initialValidation.warnings).toContain("private/failure.md still contains TODO");
      expect(result.next).toContain(`Fill ${result.caseDir}`);
    } finally {
      process.chdir(originalCwd);
    }
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
});
