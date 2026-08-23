# PBench Integrity and Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent replay-answer contamination, stale finalization, runner-file contamination, repeatable finish attempts, and misleading aggregate reports.

**Architecture:** Keep behavior in the existing `functions-pbench` module for this plan so correctness changes are isolated from later file movement. Add explicit replay-start provenance and run-state/integrity fields, then test every invariant through the current CLI-facing module interface.

**Tech Stack:** Bun 1.4, TypeScript 5.9, `bun:test`, Node filesystem and Git CLI.

**Spec:** `docs/superpowers/specs/2026-08-23-pbench-simplification-design.md`

## Global Constraints

- Existing command spellings remain valid.
- Existing finalized cases and run artifacts remain readable through defaults.
- Private evaluator details never appear in benchmark-agent output.
- Dirty tracked or untracked state is never published without an explicit authoring decision.
- Every behavior change follows red-green-refactor.

---

### Task 1: Make dirty replay-start state explicit

**Files:**
- Modify: `tests/pbench.test.ts` capture dirty-state tests near the current starting-patch tests
- Modify: `packages/functions-pbench/src/index.ts` capture artifact generation and strict manifest validation
- Modify: `docs/pbench.md`
- Modify: `docs/pbench.zh-CN.md`

**Interfaces:**
- Produces manifest field:

```ts
type ReplayStart = {
  status: "clean" | "unresolved" | "baseline" | "curated";
  candidateTrackedPatch?: "private/artifacts/extracted/starting.patch";
  candidateUntrackedManifest?: "private/artifacts/extracted/untracked.manifest.json";
};
```

- Strict validation accepts `clean`, `baseline`, and `curated`; it rejects `unresolved` with `START_STATE_UNRESOLVED`.

- [ ] **Step 1: Add one real capture helper and replace the tracked-dirty happy-path test**

Add this helper beside `captureTestCodexSession`:

```ts
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
});
```

Do not add another fixture layer beyond `captureRepoTransaction` and the existing `finalizedRunnableCase` helper.

- [ ] **Step 2: Add a failing untracked-state sibling test**

```ts
test("keeps unproven untracked files out of the public replay capsule", async () => {
  const repo = await makeRepo();
  await mkdir(join(repo, "notes"), { recursive: true });
  await writeFile(join(repo, "notes", "answer.txt"), "possible repair\n");
  const { tx } = await captureRepoTransaction(repo);
  const manifest = JSON.parse(await readFile(join(tx.caseDir, "case.json"), "utf8"));

  await expect(readFile(join(tx.caseDir, "public", "context-files", "untracked", "notes", "answer.txt"), "utf8"))
    .rejects.toThrow();
  expect(manifest.replayStart.status).toBe("unresolved");
  expect(manifest.replayStart.candidateUntrackedManifest).toBe(
    "private/artifacts/extracted/untracked.manifest.json"
  );
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```sh
bun test tests/pbench.test.ts --test-name-pattern "unproven tracked|unproven untracked"
```

Expected: both tests fail because capture currently writes dirty state into `public/`.

- [ ] **Step 4: Implement private candidate capture and manifest state**

Replace `writeStartingPatch` and `writeUntrackedContextFiles` with one cohesive capture helper:

```ts
type CapturedReplayStart = {
  replayStart: ReplayStart;
  publicContextFiles: PublicContextFile[];
};

async function captureReplayStartCandidates(
  caseDir: string,
  repoRoot: string,
  warnings: string[]
): Promise<CapturedReplayStart>;
```

Rules:

- no dirty state: return `{ replayStart: { status: "clean" }, publicContextFiles: [] }`;
- tracked diff: save only to `private/artifacts/extracted/starting.patch`;
- bounded UTF-8 untracked files: copy only under `private/artifacts/extracted/untracked/` and write `untracked.manifest.json`;
- ignored, binary, oversized, and unsafe files retain current warnings;
- any captured tracked or untracked state sets `status: "unresolved"` and adds one authoring warning;
- do not add unresolved files to `public/context.manifest.json` or `public/replay.manifest.json`.

Add this to `validateManifestShape`:

```ts
const replayStart = asObject(manifest.replayStart);
if (replayStart?.status === "unresolved") {
  errors.push("START_STATE_UNRESOLVED: choose baseline or curate replay-start files");
}
```

- [ ] **Step 5: Add and pass author-resolution tests**

Test both supported resolutions:

```ts
manifest.replayStart = { status: "baseline" };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
expect((await strictValidateTransaction(tx.transactionPath)).errors)
  .not.toContain("START_STATE_UNRESOLVED: choose baseline or curate replay-start files");
```

For `curated`, copy a selected patch/file into `public/`, update the relevant public manifest, set `{ status: "curated" }`, and assert strict validation reaches the existing validator checks instead of replay-start validation.

- [ ] **Step 6: Run focused and full pbench tests**

```sh
bun test tests/pbench.test.ts
```

Expected: all pbench tests pass.

- [ ] **Step 7: Update authoring documentation**

Document that dirty state is private candidate evidence until the author chooses baseline or curated replay input. Remove statements that current dirty files are automatically public replay context.

- [ ] **Step 8: Commit**

```sh
git add packages/functions-pbench/src/index.ts tests/pbench.test.ts docs/pbench.md docs/pbench.zh-CN.md
git commit -m "fix(pbench): require replay-start provenance"
```

---

### Task 2: Revalidate the exact bundle during finalization

**Files:**
- Modify: `tests/pbench.test.ts`
- Modify: `packages/functions-pbench/src/index.ts:3968-3990`

**Interfaces:**
- `finalizeTransaction(transactionPath)` always calls `strictValidateTransaction(transactionPath)`.

- [ ] **Step 1: Write the failing stale-validation regression test**

Factor the capture portion of `finalizedRunnableCase` into `runnableTransaction(options)` and keep `finalizedRunnableCase` as strict-validate plus finalize over that helper. Then test:

```ts
test("finalize rejects a bundle changed after strict validation", async () => {
  const prepared = await runnableTransaction();
  expect((await strictValidateTransaction(prepared.tx.transactionPath)).ok).toBe(true);

  await writeFile(
    join(prepared.tx.caseDir, "private", "validators", "check-completion.mjs"),
    "console.error('PBENCH_AUTHORING_REQUIRED'); process.exit(1);\n"
  );

  await expect(finalizeTransaction(prepared.tx.transactionPath))
    .rejects.toThrow("Cannot finalize: strict validation failed");
  await expect(stat(prepared.tx.transactionPath)).resolves.toBeTruthy();
});
```

`runnableTransaction` uses the existing `makeRepoWithFailingTest`, `writeCodexSession` records, and required-env setup currently inside `finalizedRunnableCase`; do not create a second fixture system.

- [ ] **Step 2: Run the focused test and verify RED**

```sh
bun test tests/pbench.test.ts --test-name-pattern "changed after strict validation"
```

Expected: finalize succeeds incorrectly or fails for the wrong reason.

- [ ] **Step 3: Implement fresh validation**

Replace the current conditional validation assignment with:

```ts
const validation = await strictValidateTransaction(transactionPath);
if (!validation.ok) {
  throw new Error(`Cannot finalize: strict validation failed:\n${validation.errors.join("\n")}`);
}
```

Keep the existing destination collision check, case copy, copied-manifest verification, and transaction removal unchanged. Do not use `strictValidatedAt` as an authorization shortcut.

- [ ] **Step 4: Run focused and full pbench tests**

```sh
bun test tests/pbench.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add packages/functions-pbench/src/index.ts tests/pbench.test.ts
git commit -m "fix(pbench): revalidate cases during finalize"
```

---

### Task 3: Make runner injection reversible and target-aware

**Files:**
- Modify: `packages/functions-pbench/src/index.ts`
- Modify: `tests/pbench.test.ts`

**Interfaces:**
- Consumes: `detectSkillTargets(worktree)` from `@ya-skills/core`.
- Produces:

```ts
type InstalledRunnerSkill = { directories: string[] };
async function installRunnerSkill(worktree: string): Promise<InstalledRunnerSkill>;
async function removeInstalledRunnerSkill(installed: InstalledRunnerSkill): Promise<void>;
```

- [ ] **Step 1: Write failing target and collision tests**

Extend `runnableTransaction` and `finalizedRunnableCase` with `skillTargets?: "claude" | "agents" | "both"` and `existingRunnerSkill?: boolean`. Before the baseline commit, create selected target directories with tracked `.keep` files; for `existingRunnerSkill`, track `.agents/skills/pbench-runner/SKILL.md` containing `project-owned\n`.

```ts
test("installs the manual runner into the worktree's existing Claude skill target", async () => {
  const prepared = await finalizedRunnableCase({ skillTargets: "claude" });
  const started = JSON.parse(String(await pbenchCommand("start", prepared.home).run([
    "--case", prepared.caseId, "--workspace", prepared.workspaceRoot
  ])));
  await expect(stat(join(started.worktree, ".claude", "skills", "pbench-runner", "SKILL.md"))).resolves.toBeTruthy();
  await expect(stat(join(started.worktree, ".agents", "skills", "pbench-runner", "SKILL.md"))).rejects.toThrow();
});

test("refuses to overwrite an existing runner skill", async () => {
  const prepared = await finalizedRunnableCase({ existingRunnerSkill: true });
  await expect(pbenchCommand("start", prepared.home).run([
    "--case", prepared.caseId, "--workspace", prepared.workspaceRoot
  ])).rejects.toThrow("Refusing to overwrite existing pbench-runner skill");
});
```

- [ ] **Step 2: Write the failing candidate-contamination test**

Start and finish a manual run in a repository that does not ignore `.agents/`. Assert `agent.diff` and `candidate/untracked.json` do not contain `pbench-runner`.

- [ ] **Step 3: Run focused tests and verify RED**

```sh
bun test tests/pbench.test.ts --test-name-pattern "existing Claude skill target|overwrite an existing runner|candidate artifacts exclude"
```

- [ ] **Step 4: Implement target-aware reversible injection**

- import `detectSkillTargets` from `@ya-skills/core`;
- run setup before injecting the runner;
- refuse when any target runner directory already exists;
- store created directories on `RunState.runnerSkillDirs`;
- remove exactly those directories before private validation and before any candidate diff is collected;
- cleanup created empty parent directories only when this run created them;
- on start/setup failure, remove injected files during cleanup.

- [ ] **Step 5: Add a both-target test and run pbench tests**

When both `.claude/skills` and `.agents/skills` exist, assert both receive the runner and both are absent from candidate artifacts after finish.

```sh
bun test tests/pbench.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add packages/functions-pbench/src/index.ts tests/pbench.test.ts
git commit -m "fix(pbench): isolate injected runner skills"
```

---

### Task 4: Make finish an atomic one-shot state transition

**Files:**
- Modify: `packages/functions-pbench/src/index.ts`
- Modify: `tests/pbench.test.ts`

**Interfaces:**
- Extend `PbenchRunStatus` with `finishing` and retain terminal `blocked`.
- `finishPbenchRun` returns a safe terminal result on post-transition infrastructure failure.

- [ ] **Step 1: Write a failing exceptional-path test**

```ts
test("finish consumes the attempt when validation infrastructure fails", async () => {
  const prepared = await finalizedRunnableCase();
  const started = JSON.parse(String(await pbenchCommand("start", prepared.home).run([
    "--case", prepared.caseId, "--workspace", prepared.workspaceRoot
  ])));
  await writeFile(join(prepared.casePath, "case.json"), "not-json\n");

  const first = JSON.parse(String(await pbenchCommand("finish", prepared.home).run(["--run", started.runId])));
  expect(first.status).toBe("blocked");
  await expect(pbenchCommand("finish", prepared.home).run(["--run", started.runId]))
    .rejects.toThrow("already finished");

  const statePath = join(prepared.home, ".ya-skills", "pbench", "runs", `${started.runId}.json`);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  expect(state.terminal).toBe(true);
});
```

Expose no production-only test hook; derive the state path using the documented home layout in the test.

- [ ] **Step 2: Run the test and verify RED**

```sh
bun test tests/pbench.test.ts --test-name-pattern "consumes the attempt"
```

- [ ] **Step 3: Implement persisted transition and failure terminalization**

```ts
state.status = "finishing";
state.updatedAt = nowIso();
await saveRunState(state, options.home);
try {
  await removeInstalledRunnerSkill({ directories: state.runnerSkillDirs ?? [] });
  const manifest = await readJson(join(state.caseDir, "case.json"));
  const accessAudit = await summarizeAccessAudit(state.worktree);
  if (accessAudit) {
    state.accessAuditSuspicious = accessAudit.suspicious;
    await writeJson(join(state.artifactDir, "access-audit.json"), accessAudit);
  }
  const finished = await completeRunWithValidators(state, manifest, options.home);
  return { runId: finished.runId, status: finished.status, failingValidatorId: finished.failingValidatorId ?? null };
} catch {
  state.status = "blocked";
  state.terminal = true;
  state.finishedAt = nowIso();
  await writeRunSummary(state, ["Run blocked by validation infrastructure."]);
  await saveRunState(state, options.home);
  await cleanupReplayWorktree(state.repoCache, state.worktree);
  return { runId: state.runId, status: state.status, failingValidatorId: null };
}
```

Do not include the private exception text in the benchmark-agent response.

- [ ] **Step 4: Test concurrent/repeated state rejection**

Persist a synthetic `finishing` state and assert another finish is rejected. Retain the existing second-finish terminal test.

- [ ] **Step 5: Run pbench tests and commit**

```sh
bun test tests/pbench.test.ts
git add packages/functions-pbench/src/index.ts tests/pbench.test.ts
git commit -m "fix(pbench): make finish attempts atomic"
```

---

### Task 5: Report only comparable evaluated cohorts by default

**Files:**
- Modify: `packages/functions-pbench/src/index.ts`
- Modify: `tests/pbench.test.ts`
- Modify: `docs/pbench.md`
- Modify: `docs/pbench.zh-CN.md`

**Interfaces:**

```ts
type PbenchIntegrity = "enforced" | "instruction-only" | "unknown" | "contaminated";
```

New normalized run fields use backward-compatible defaults:

```ts
terminal: boolean;
integrity: PbenchIntegrity;
validatorExecuted: boolean;
agentVersion: string | null;
```

Reports retain profile totals for compatibility and add comparable cohorts keyed by `profile`, `agentMode`, `agentVersion`, `isolation`, `manualIntervention`, and `integrity`. Both profile and cohort summaries expose `runs`, `evaluated`, `passed`, `passRate`, and `excludedStatusCounts`; default Markdown renders cohorts.

- [ ] **Step 1: Write failing cohort-denominator tests**

Create artifacts for `passed`, `validator_failed`, `running`, `setup_failed`, contaminated, and instruction-only runs under one profile. Assert only trusted `passed` and `validator_failed` runs form the default denominator, and different agent versions produce separate cohorts.

```ts
expect(report.profiles.current).toMatchObject({
  runs: 6,
  evaluated: 2,
  passed: 1,
  passRate: 0.5,
  excludedStatusCounts: { running: 1, setup_failed: 1, untrusted: 2 }
});
expect(Object.values(report.cohorts)).toEqual(expect.arrayContaining([
  expect.objectContaining({ profile: "current", agentMode: "codex", agentVersion: "0.9.2", evaluated: 2 })
]));
```

- [ ] **Step 2: Write a failing malformed-artifact tolerance test**

Write one invalid `runs/*/run.json` beside one valid run. Assert report succeeds, includes the valid run, and returns one warning with category `MALFORMED_RUN_ARTIFACT` without leaking file contents.

- [ ] **Step 3: Run focused tests and verify RED**

```sh
bun test tests/pbench.test.ts --test-name-pattern "cohort denominator|malformed run artifact"
```

- [ ] **Step 4: Record integrity and validator execution**

- Current Codex, Claude headless, and manual skill runners: `instruction-only`, because none enforces a private-read whitelist.
- A future runner may use `enforced` only when its sandbox enforces the recorded read policy.
- `--contaminated`: `contaminated`.
- old artifacts without a field: `unknown`.
- persist the selected runner's version probe as `agentVersion`; old artifacts default to `null`.
- set `validatorExecuted = true` immediately before private validators run; persist terminal state afterward.

A default evaluated run satisfies:

```ts
function isDefaultEvaluatedRun(run: PbenchReportRun): boolean {
  return run.terminal &&
    run.validatorExecuted &&
    run.integrity === "enforced" &&
    !run.contaminated &&
    (run.status === "passed" || run.status === "validator_failed");
}
```

Instruction-only runs remain visible but excluded unless `--include-untrusted` is passed.

- [ ] **Step 5: Tolerate malformed artifacts**

Change `listReportRuns` to return `{ runs, warnings }`. Catch errors per artifact, append a safe warning, and continue. Do not catch directory-level access errors.

- [ ] **Step 6: Update JSON and Markdown tests/docs**

Show evaluated and excluded counts. Explain that default pass rate is a trusted cohort metric, not all observed runs.

- [ ] **Step 7: Run pbench tests and commit**

```sh
bun test tests/pbench.test.ts
git add packages/functions-pbench/src/index.ts tests/pbench.test.ts docs/pbench.md docs/pbench.zh-CN.md
git commit -m "fix(pbench): report trusted benchmark cohorts"
```

---

### Task 6: Verify the correctness milestone

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run all required gates**

```sh
bun run typecheck
bun run test
bun run build
bun run smoke
```

Expected: every command exits 0 with no skipped tests.

- [ ] **Step 2: Inspect the milestone diff**

```sh
git diff 1461cf1...HEAD --check
git diff 1461cf1...HEAD --stat
git status --short
```

Confirm changes are limited to correctness, integrity, tests, and matching docs.

- [ ] **Step 3: Request fresh-context review**

Review against this plan and the design spec with three angles: replay correctness, privacy/integrity, and test intent. Fix P0/P1 findings before starting Plan 2.
