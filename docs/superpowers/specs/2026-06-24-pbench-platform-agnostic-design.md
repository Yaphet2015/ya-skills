# pbench: Platform-Agnostic Capture & Rerun — Design

Date: 2026-06-24
Status: Approved (verbal). Implementation in progress.

## Problem

pbench was hard-bound to Codex:

- `yk pbench capture` rejected anything but `--source codex` and read Codex's own session logs.
- `yk pbench run` rejected anything but `--agent codex` and shelled out to the `codex` binary.
- Capture latency was catastrophic when `--session-id` was used (resolved separately by the
  `fix/pbench-capture-session-id-scan` hotfix — filename-based resolution).

Goal: capture and rerun benchmark cases for **any** coding agent (Claude Code, Codex, OpenCode, …),
with full automation on the rerun side.

## What is already agent-neutral (reused, not rebuilt)

- The on-disk case format (`case.json`, `public/` + `private/` layout, validators,
  `replayRequirements`) encodes no agent name.
- The skill-mediated `start`/`finish` rerun path is already harness-agnostic.
- Everything downstream of session extraction (`buildAuthoringArtifacts`, rendering, validator
  generation) is already neutral.
- The `runPbenchCase` pipeline is shared; only ~2 lines (spawn + parse) are agent-specific.
- Provenance is already harness-agnostic: `isolation` (sandbox level) is separate from the agent.

## Design: two orthogonal registries

### 1. Capture side — `SessionSource`

```ts
interface SessionSource {
  id: string;                                    // "codex" | "claude" | "opencode" …
  sourceKind: string;                            // stored as metadata.source.kind ("codex-session", …)
  locate(opts: { cwd, sessionId, home }): Promise<string | null>;
  extract(rawText: string): NormalizedSession;
}

type NormalizedSession = {
  meta: { cwd?: string; id?: string; model?: string; gitBaseline?: { commit?: string; branch?: string } };
  userMessages: string[];
  assistantMessages: string[];
  toolCalls: Array<{ command?: string; cwd?: string; stdout?: string; stderr?: string; exitCode?: number; status?: string }>;
  errorRecords: JsonObject[];
  approvalSandboxRecords: JsonObject[];
  touchedFiles: string[];
};
```

`NormalizedSession` is the existing `ExtractedCodexSession` shape, generalised. The Codex source
is the current `extractCodexSession` + the (fixed) filename locator. Capture dispatches via a
registry keyed by `--source`. **Non-Codex sources require `--input <transcript>`** (per-agent
locators are deferred — YAGNI); the existing `--input` hatch and all downstream authoring are reused.

### 2. Rerun side — `AgentRunner`

```ts
interface AgentRunner {
  id: string;                                    // "codex" | "claude" | "opencode" …
  launch(opts: { worktree, prompt, env, timeoutMs }): { exitCode: number | null; stdout: string; stderr: string };
  parseSummary(stdout: string): { lastMessage: string | null; tokenUsage: JsonObject; cost?: number | null };
  defaultIsolation: PbenchIsolation;             // "workspace-write" | "none"
  versionProbe(): string | null;
}
```

The Codex runner is the current `spawnCodexAgent` + `parseCodexJsonlSummary`. `run --agent <id>`
dispatches via a registry. The whole `createStartedRun → launch → completeRunWithValidators`
pipeline is reused; the two agent-specific call sites become `runner.launch` / `runner.parseSummary`.

## Integrity: the boundary is agent-independent

The replay worktree stages **only `.pbench/public/`**. Private evaluator material (failure/success/
verification docs, validators, raw transcript) lives in the case directory and is never present in
the worktree. Therefore evaluator integrity comes from the public/private boundary — which is
agent-independent and already enforced — **not** from the Codex sandbox. The Codex
`--sandbox workspace-write` contains the agent's *side effects* on the world; it does not protect
pbench secrets. Full-auto runs against any agent are integrity-safe; `isolation` simply records the
real containment level for honest provenance.

## Storage changes (small, localized)

| Field | Was | Becomes |
|---|---|---|
| `metadata.source.kind` | literal `codex-session` | `source.sourceKind` (closed set, per source) |
| raw transcript filename | `codex-session.jsonl` | `${sourceId}-session.jsonl` — **and the leak regex + authoring message are parameterized with the same value** (the one correctness/privacy-critical seam) |
| `metadata.tags[0]` | literal `codex` | the source id |
| `runner-environment.json` tools | hardcoded `tools.codex` | `{ [runnerId]: versionProbe() }` |
| `RunState.agentMode: "codex"\|"skill"` | two-value union | `runnerId: string` + `manualIntervention: boolean` (skill-mediated = `manualIntervention: true`) |
| `tokenUsage` parsing | Codex JSONL only | each runner's `parseSummary` normalises to `{ input_tokens, output_tokens, … }`; aggregation stays schema-flexible |

`validateManifestShape` does not constrain `source.kind`, so adding values is storage-safe.

## Runner skill SSOT

`skills/pbench-runner/SKILL.md` is duplicated verbatim as `PBENCH_RUNNER_SKILL_MARKDOWN` in
`index.ts`. Rather than introduce a build-time asset step, we enforce SSOT with a test that asserts
the embedded constant equals the checked-in file — divergence fails CI instead of silently shipping
a divergent installed skill.

## Second agent: Claude Code (proves platform-independence)

- **Source:** extracts `~/.claude/projects/**/<sessionId>.jsonl`. Records have top-level `cwd` +
  `gitBranch`; user `message.content` is a string; assistant `message.content` is an array of blocks
  (`text`, `tool_use`, `thinking`) with `message.usage.{input_tokens,output_tokens,…}`;
  `tool_use = { type, name, input }` (Bash → `input.command`); `tool_result = { tool_use_id, content }`.
  Git commit is not stored → baseline falls back to `getHeadCommit(cwd)`.
- **Runner:** `claude -p <prompt> --output-format stream-json --input-format text --dangerously-skip-permissions --model <m>`,
  run in the worktree. `parseSummary` reads the stream-json `result` event for `result` (lastMessage)
  + `usage` (tokenUsage) + `total_cost_usd` (cost). `defaultIsolation = "none"` (Claude has no
  Codex-equivalent workspace sandbox; integrity rests on the public/private boundary as above).

## Non-goals

- Per-agent session locators beyond Codex/Claude filename matching (use `--input`).
- A/B multi-agent comparison in a single run (`runnerId` is per-run).
- A read-whitelist sandbox for skill-mediated mode (existing best-effort + access-audit remains).
- Declarative/manual capture (Approach C) — deferred.
