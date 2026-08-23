# PBench Deep Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3990-line PBench implementation file with a small composition interface and cohesive authoring, replay, reporting, and adapter modules without changing public behavior.

**Architecture:** Extract only proven seams. `index.ts` remains the package interface, `commands.ts` adapts CLI arguments, three lifecycle modules own behavior, and Codex/Claude implementations satisfy two real adapter contracts. Avoid per-filesystem-call ports and runtime plugin discovery.

**Tech Stack:** Bun 1.4, TypeScript 5.9, Node APIs, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-23-pbench-simplification-design.md`

## Global Constraints

- Plans 1 and 2 must be complete and verified first.
- This plan changes module ownership, not public behavior or schemas.
- Existing package exports remain available until a dedicated breaking release.
- Tests target lifecycle interfaces; tests do not reach into private helpers.
- Every extraction keeps tests green before the next extraction begins.

---

### Task 1: Freeze the public package and command interfaces

**Files:**
- Create: `tests/pbench-exports.test.ts`
- Modify: `packages/functions-pbench/src/index.ts`

**Interfaces:**

`index.ts` must continue exporting:

```ts
createPbenchCommands
slugify
makeCaseId
initWorkspace
linkProject
resolveWorkspaceRoot
resolveGitRoot
captureCodexSession // compatibility alias
captureSession
validateCaseBundle
strictValidateTransaction
finalizeTransaction
```

- [ ] **Step 1: Write the export contract test**

Import each named export and assert it is a function. Assert `captureCodexSession === captureSession` only after the compatibility alias is introduced.

- [ ] **Step 2: Run the test and verify RED for the new neutral name**

```sh
bun test tests/pbench-exports.test.ts
```

Expected: `captureSession` is missing.

- [ ] **Step 3: Add the neutral export and compatibility alias**

Rename the implementation to `captureSession`, then export:

```ts
export const captureCodexSession = captureSession;
```

Do not duplicate implementation.

- [ ] **Step 4: Run full tests and commit**

```sh
bun run typecheck
bun run test
git add packages/functions-pbench/src/index.ts tests/pbench-exports.test.ts
git commit -m "refactor(pbench): freeze package interfaces"
```

---

### Task 2: Extract registered source and runner adapters

**Files:**
- Create: `packages/functions-pbench/src/adapters/types.ts`
- Create: `packages/functions-pbench/src/adapters/codex.ts`
- Create: `packages/functions-pbench/src/adapters/claude.ts`
- Create: `tests/pbench-adapters.test.ts`
- Modify: `packages/functions-pbench/src/index.ts`

**Interfaces:**

```ts
export type JsonObject = Record<string, unknown>;

export type NormalizedSession = {
  meta: JsonObject;
  userMessages: string[];
  assistantMessages: string[];
  toolCalls: JsonObject[];
  errorRecords: JsonObject[];
  approvalSandboxRecords: JsonObject[];
  touchedFiles: string[];
  timeline: string[];
};

export type SessionSource = {
  id: string;
  sourceKind: string;
  locate(options: { cwd: string; sessionId?: string; home: string }): Promise<string>;
  extract(rawText: string): NormalizedSession;
};

export type AgentRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type AgentRunSummary = {
  lastMessage: string | null;
  tokenUsage: JsonObject | null;
  cost?: number | null;
};

export type AgentRunner = {
  id: string;
  defaultIsolation: "none" | "workspace-write";
  launch(options: { worktree: string; prompt: string; env: NodeJS.ProcessEnv; timeoutMs: number }): AgentRunResult;
  parseSummary(stdout: string): AgentRunSummary;
  versionProbe(env: NodeJS.ProcessEnv): string | null;
};
```

- [ ] **Step 1: Write adapter contract tests**

Use fixture transcript strings already represented in `tests/pbench.test.ts`. Assert each source normalizes prompt, tool output, metadata, and errors. Use fake executables for each runner and assert environment, timeout, summary, token, and cost normalization.

- [ ] **Step 2: Run adapter tests and verify RED**

```sh
bun test tests/pbench-adapters.test.ts
```

Expected: adapter modules do not exist.

- [ ] **Step 3: Move Codex behavior**

Move Codex record normalization, session extraction, locator, spawn arguments, and JSONL summary parsing into `adapters/codex.ts`. Export `createCodexSessionSource()` and `createCodexAgentRunner()`.

- [ ] **Step 4: Move Claude behavior**

Move Claude transcript extraction, filename locator, spawn arguments, and stream-JSON summary parsing into `adapters/claude.ts`. Export `createClaudeSessionSource()` and `createClaudeAgentRunner()`.

- [ ] **Step 5: Compose static registries**

In package composition:

```ts
const sessionSources = indexById([
  createCodexSessionSource(),
  createClaudeSessionSource()
]);
const agentRunners = indexById([
  createCodexAgentRunner(),
  createClaudeAgentRunner()
]);
```

`indexById` fails on empty or duplicate IDs. Do not implement dynamic discovery.

- [ ] **Step 6: Run adapter, pbench, typecheck, and build gates**

```sh
bun test tests/pbench-adapters.test.ts tests/pbench.test.ts
bun run typecheck
bun run build
```

- [ ] **Step 7: Commit**

```sh
git add packages/functions-pbench/src/adapters packages/functions-pbench/src/index.ts tests/pbench-adapters.test.ts tests/pbench.test.ts
git commit -m "refactor(pbench): extract agent adapters"
```

---

### Task 3: Extract reporting as a deep query module

**Files:**
- Create: `packages/functions-pbench/src/reporting.ts`
- Create: `tests/pbench-reporting.test.ts`
- Modify: `packages/functions-pbench/src/index.ts`
- Modify: `tests/pbench.test.ts`

**Interfaces:**

```ts
export type ReportQuery = {
  workspaceRoot: string;
  caseFilter?: string;
  profileFilter?: string;
  includeUntrusted?: boolean;
};

export async function createPbenchReport(query: ReportQuery): Promise<JsonObject>;
export function renderPbenchReportMarkdown(report: JsonObject): string;
export async function auditPbench(query: { workspaceRoot: string; caseDir?: string }): Promise<JsonObject>;
```

- [ ] **Step 1: Move report behavior tests to the new interface and verify RED**

Move empty, aggregate, cohort, malformed artifact, Markdown, single-case audit, and workspace-audit tests into `tests/pbench-reporting.test.ts`. Replace command lookup with direct calls to the new interface.

```sh
bun test tests/pbench-reporting.test.ts
```

Expected: imports fail.

- [ ] **Step 2: Move reporting implementation as one cluster**

Move run-artifact reading/normalization, aggregation, cohort selection, Markdown rendering, and audit functions. Keep low-level JSON/file helpers private inside `reporting.ts` unless another lifecycle module already consumes them.

- [ ] **Step 3: Adapt CLI calls**

The command layer resolves workspace/case inputs, then calls `createPbenchReport` or `auditPbench`. It does not inspect report internals.

- [ ] **Step 4: Delete replaced tests and run gates**

```sh
bun test tests/pbench-reporting.test.ts tests/pbench.test.ts
bun run typecheck
```

Confirm no report test remains duplicated in `tests/pbench.test.ts`.

- [ ] **Step 5: Commit**

```sh
git add packages/functions-pbench/src/reporting.ts packages/functions-pbench/src/index.ts tests/pbench-reporting.test.ts tests/pbench.test.ts
git commit -m "refactor(pbench): extract reporting module"
```

---

### Task 4: Extract replay lifecycle and one-shot state ownership

**Files:**
- Create: `packages/functions-pbench/src/replay.ts`
- Create: `tests/pbench-replay.test.ts`
- Modify: `packages/functions-pbench/src/index.ts`
- Modify: `tests/pbench.test.ts`

**Interfaces:**

```ts
export type RunCaseRequest = {
  caseDir: string;
  workspaceRoot: string;
  home?: string;
  profile: string;
  agent: string;
};

export type StartManualRunRequest = Omit<RunCaseRequest, "agent"> & {
  contaminated?: boolean;
};

export async function runCase(request: RunCaseRequest): Promise<JsonObject>;
export async function startManualRun(request: StartManualRunRequest): Promise<JsonObject>;
export async function finishRun(request: { runId: string; home?: string }): Promise<JsonObject>;
```

`replay.ts` owns worktree creation, public capsule preparation, setup, agent launch, runner injection cleanup, state transitions, validators, redaction, and candidate/run artifacts.

- [ ] **Step 1: Move replay behavior tests and verify RED**

Move automatic Codex/Claude run, manual start/finish, required env, setup failure, agent failure, validator failure, one-shot, redaction, injection, and candidate-artifact tests into `tests/pbench-replay.test.ts` using the new interface.

- [ ] **Step 2: Extract the replay implementation cluster**

Move all functions from run ID/state path helpers through finish/report boundary, plus worktree/validator helpers currently used only by replay. Inject static `agentRunners` and the canonical runner asset through a small composition object internal to the package.

Do not expose private validator paths in return types.

- [ ] **Step 3: Adapt command handlers**

`run`, `start`, and `finish` parse arguments and call the three replay functions. No command handler reads or writes run state directly.

- [ ] **Step 4: Run replay and full tests**

```sh
bun test tests/pbench-replay.test.ts tests/pbench.test.ts
bun run typecheck
bun run build
```

- [ ] **Step 5: Commit**

```sh
git add packages/functions-pbench/src/replay.ts packages/functions-pbench/src/index.ts tests/pbench-replay.test.ts tests/pbench.test.ts
git commit -m "refactor(pbench): extract replay lifecycle"
```

---

### Task 5: Extract authoring and validation lifecycle

**Files:**
- Create: `packages/functions-pbench/src/authoring.ts`
- Create: `tests/pbench-authoring.test.ts`
- Modify: `packages/functions-pbench/src/index.ts`
- Modify: `tests/pbench.test.ts`

**Interfaces:**

```ts
export type AuthoringDependencies = {
  sessionSources: ReadonlyMap<string, SessionSource>;
};

export function createAuthoring(dependencies: AuthoringDependencies): {
  captureSession(options?: CaptureOptions): Promise<CaptureResult>;
  validateCaseBundle(caseDir: string, options?: ValidationOptions): Promise<ValidationResult>;
  strictValidateTransaction(transactionPath: string): Promise<ValidationResult>;
  finalizeTransaction(transactionPath: string): Promise<{ casePath: string; caseId: string }>;
};
```

- [ ] **Step 1: Move authoring tests and verify RED**

Move workspace, capture, extraction, authoring documents, replay-start provenance, export, strict validation, and finalization tests into `tests/pbench-authoring.test.ts`. Keep adapter parsing specifics in adapter tests.

- [ ] **Step 2: Extract authoring implementation**

Move workspace/case resolution required by authoring, transaction skeleton generation, public/private document rendering, dirty-state candidates, validation, strict baseline execution, export, and finalization.

Keep `captureCodexSession` compatibility alias in `index.ts`; it delegates to the composed authoring module.

- [ ] **Step 3: Adapt command handlers and exports**

Capture, validate, export, finalize, workspace-init, and project-link handlers call authoring functions. `index.ts` re-exports stable types/functions.

- [ ] **Step 4: Run authoring and full gates**

```sh
bun test tests/pbench-authoring.test.ts tests/pbench-adapters.test.ts tests/pbench.test.ts
bun run typecheck
bun run build
```

- [ ] **Step 5: Commit**

```sh
git add packages/functions-pbench/src/authoring.ts packages/functions-pbench/src/index.ts tests/pbench-authoring.test.ts tests/pbench.test.ts
git commit -m "refactor(pbench): extract authoring lifecycle"
```

---

### Task 6: Extract the CLI adapter and remove the monolith

**Files:**
- Create: `packages/functions-pbench/src/commands.ts`
- Modify: `packages/functions-pbench/src/index.ts`
- Modify: `tests/functions.test.ts`
- Delete if empty: `tests/pbench.test.ts`

**Interfaces:**

```ts
export function createPbenchCommands(options: PbenchCommandOptions = {}): FunctionCommand[];
```

`commands.ts` owns only CLI argument parsing, command descriptions, safe output formatting, and delegation to composed lifecycle modules.

- [ ] **Step 1: Add command delegation tests**

Use injected fake lifecycle methods to prove each action delegates with normalized options. Do not inspect private implementation state.

- [ ] **Step 2: Move command parsing and descriptors**

Move `createPbenchCommands`, `parseArgs`, `getString`, `requireString`, `getBoolean`, and output-format selection into `commands.ts`.

- [ ] **Step 3: Reduce `index.ts` to composition and exports**

Target shape:

```ts
const adapters = createBuiltInAdapters();
const authoring = createAuthoring({ sessionSources: adapters.sessionSources });
const replay = createReplay({ agentRunners: adapters.agentRunners, runnerSkillMarkdown });

export const createPbenchCommands = createCommands({ authoring, replay, reporting });
export { /* stable public types and compatibility exports */ };
```

If this conflicts with `createPbenchCommands({ home })`, keep it as a wrapper function that injects `home` into the composed modules. Do not break test isolation.

- [ ] **Step 4: Delete duplicated old implementation and tests**

No copied helper may remain in `index.ts`. Delete `tests/pbench.test.ts` only after every behavior has an owning test file.

- [ ] **Step 5: Run all gates**

```sh
bun run typecheck
bun run test
bun run build
bun run smoke
```

- [ ] **Step 6: Commit**

```sh
git add packages/functions-pbench/src tests
git commit -m "refactor(pbench): compose deep lifecycle modules"
```

---

### Task 7: Simplify and verify the final architecture

**Files:**
- Modify only recently extracted code when simplification is behavior-preserving.

- [ ] **Step 1: Run the simplify pass**

Check recently modified code for duplicated JSON/file helpers, unnecessary public exports, pass-through modules, nested ternaries, and stale Codex-specific names. Keep helpers private to the lifecycle module that owns them; share only helpers consumed by at least two lifecycle modules.

- [ ] **Step 2: Run deletion tests**

For each new module, ask: deleting it would move meaningful complexity back into callers. Inline any module that only forwards calls without hiding behavior.

- [ ] **Step 3: Run fresh full verification**

```sh
bun run typecheck
bun run test
bun run build
bun run smoke
git diff --check
git status --short
```

- [ ] **Step 4: Request architecture and regression review**

Review module depth, locality, adapter seam discipline, public compatibility, test ownership, privacy, and release bundling. Resolve P0/P1 findings and rerun affected gates before completion.
