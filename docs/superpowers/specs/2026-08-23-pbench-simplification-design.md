# PBench Simplification and Integrity Design

Date: 2026-08-23
Status: Approved

## Goal

Make PBench harder to invalidate and easier to operate without merging the operator and benchmark-runner roles.

Success means:

- replay input cannot silently include an already-completed repair;
- finalization validates the exact case content being finalized;
- harness-injected runner files cannot alter candidate results;
- reports separate trusted, comparable runs from operational or instruction-only runs;
- the common capture and replay paths expose fewer commands and concepts;
- skill text, runtime runner text, command metadata, and public documentation do not drift;
- implementation complexity is local to a few deep modules with real adapter seams.

## Non-goals

- Dynamic third-party plugin discovery.
- Hosted storage, cloud sync, or a public leaderboard.
- A cross-platform filesystem sandbox in this change.
- Automatic reconstruction of arbitrary pre-session dirty working trees.
- Removing advanced diagnostic commands or breaking their existing CLI spellings immediately.

## Role and information seams

Keep the two skills conceptually separate.

### Operator skill: `pbench`

The operator may use captured session evidence and private authoring files. Its interface is a short router for:

1. a benchmark-worthy outcome mismatch;
2. an explicit request to capture, replay, compare, audit, or report PBench cases.

It repairs no benchmark state without user approval. It delegates file-level authoring guidance to the generated `private/authoring-checklist.md` rather than duplicating it in `SKILL.md`.

### Benchmark runner skill: `pbench-runner`

The benchmarked agent receives only repository files, the public replay capsule, and an opaque one-shot finish command. The runner skill remains a separate runtime role because merging it with the operator skill would expose evaluator knowledge.

The runner is an internal harness asset. It must not appear as a normal user-installable catalog skill.

## Replay-start provenance

Current repository state at capture time is not proof of the task's starting state. It may contain:

- pre-existing user work;
- changes made by the failed agent;
- changes made while repairing the failed result.

Therefore capture must not silently publish `git diff HEAD` as `public/starting.patch` or copy current untracked files into the public capsule.

### Required behavior

1. Save detected tracked and bounded untracked dirty state as private authoring evidence.
2. Mark the starting-state decision unresolved.
3. Require the author to choose one of:
   - baseline commit only;
   - an explicitly curated public starting patch and curated context files.
4. Record the choice and provenance in the case manifest.
5. Strict validation fails while detected dirty state is unresolved.

For a clean repository, capture remains automatic. The operator skill asks for capture approval before starting repair so later changes cannot be mistaken for starting context.

## Finalization invariant

`finalize` always runs strict validation against the current transaction content. A historical `strictValidatedAt` timestamp is evidence only; it never authorizes a later bundle.

A finalized case is copied only after that fresh validation succeeds. Failure leaves the transaction intact and returns one recovery action.

## Runner injection lifecycle

A skill-mediated run may need an on-disk skill for agent discovery. Injection follows this lifecycle:

1. Detect existing `.claude/skills` and `.agents/skills` targets using the core target rules.
2. Refuse to overwrite an existing `pbench-runner` path.
3. Record every harness-created path.
4. Install the internal canonical runner asset into the selected targets.
5. Before candidate diff collection and private validation, remove only the recorded harness-created paths.
6. Candidate artifacts always exclude harness-owned files.

If both targets exist, install to both. If neither exists, create `.agents/skills`.

## One-shot run state

Skill-mediated finish uses an explicit state transition:

```text
running -> finishing -> passed | validator_failed | blocked
```

The transition from `running` to `finishing` is persisted before reading audit data or executing private validators. Any later infrastructure exception becomes terminal `blocked`. Repeating finish for `finishing` or any terminal state fails. A retry creates a new run linked through `priorRunIds`.

## Integrity and reporting

Public/private path scanning remains a fail-closed content check. It is not described as a filesystem sandbox.

Each run records an integrity classification:

```text
enforced | instruction-only | unknown | contaminated
```

- `enforced`: the runner has an enforced sandbox appropriate to the recorded policy.
- `instruction-only`: isolation depends on runner instructions.
- `unknown`: required integrity evidence is unavailable.
- `contaminated`: a known invalidating event occurred.

Manual runs and unsandboxed runners are not silently treated as equivalent to sandboxed runs.

The default report:

- uses Markdown for humans;
- calculates pass rate only from terminal, validator-executed, non-contaminated runs;
- groups comparable cohorts by profile, agent, version, model when available, isolation, manual/headless mode, and integrity;
- lists running, setup failures, malformed artifacts, and untrusted runs as excluded counts;
- does not let one malformed run artifact block the complete report.

JSON output remains available explicitly. An opt-in flag may include untrusted runs.

The voluntary per-file access log cannot prove completeness. Remove the manual logging requirement from the runner skill. If automatic access observation is unavailable, record integrity as `instruction-only` or `unknown`.

## Common user interface

Keep existing commands for compatibility, but document this default path:

```sh
yk pbench capture [--source <registered-source>]
yk pbench finalize --transaction <path>
yk pbench run --case <case> [--agent <registered-runner> | --manual]
yk pbench report [--profile <label>]
```

Behavior:

- `capture` prints one state and one next action.
- `finalize` owns fresh strict validation; `validate` is an advanced diagnostic command.
- `run --manual` is the operator-facing spelling for the existing start flow. Existing `start` and `finish` remain compatible; the benchmarked agent receives finish internally.
- `report` defaults to trusted human-readable output. `--format json` remains available.
- workspace initialization, project linking, replay export, validation, and audit remain advanced operations and are removed from the short skill workflow.

Only registered capture sources are accepted. Documentation must not imply that an arbitrary transcript format works merely because `--input` is present.

## Internal module design

Keep one `@ya-skills/functions-pbench` package. Split by lifecycle, not by individual helper:

```text
packages/functions-pbench/src/
  index.ts                 public exports and composition
  commands.ts              CLI argument/output adapter
  authoring.ts             capture, strict validation, finalization
  replay.ts                run preparation, execution, finish state machine
  reporting.ts             report and audit queries
  adapters/
    codex.ts               Codex session and runner adapters
    claude.ts              Claude session and runner adapters
  assets/pbench-runner/
    SKILL.md               canonical internal runner skill body
```

Real adapter seams:

- `SessionSource`: acquire and normalize Codex or Claude transcripts.
- `AgentRunner`: launch and normalize Codex or Claude execution results.
- internal runner asset provider: supplies the single canonical runner skill text.

Do not add runtime plugin discovery, a generic event bus, or wrappers around every filesystem call. Filesystem, Git, worktree, clock, and process dependencies stay internal unless a second concrete adapter is needed by behavior tests.

Tests exercise the authoring, replay, and reporting module interfaces. Existing tests are moved or split only when their ownership becomes clear; behavior is not weakened to match the refactor.

## Skill and metadata SSOT

- Move the canonical runner body to `packages/functions-pbench/assets/pbench-runner/SKILL.md`, import it with Bun's text loader so compiled releases embed it, and remove the public `skills/pbench-runner` catalog entry plus the TypeScript string copy.
- `pbench` frontmatter and `skill.json` use aligned trigger language.
- Command capability metadata must match the registered command descriptors. If a metadata field has no consumer or leverage, remove it rather than maintaining a speculative list.
- English docs, Chinese docs, README, and CLI help use capability-neutral terms and list `codex` and `claude` only as current built-ins.

## Error model

User-visible errors include a stable category, safe summary, current state, and one recovery action. Relevant categories are:

- `START_STATE_UNRESOLVED`
- `AUTHORING_REQUIRED`
- `STRICT_VALIDATION_FAILED`
- `PUBLIC_BOUNDARY_VIOLATION`
- `REQUIRED_ENV_MISSING`
- `RUNNER_UNAVAILABLE`
- `SETUP_FAILED`
- `AGENT_FAILED`
- `VALIDATOR_FAILED`
- `FINISH_ALREADY_CONSUMED`
- `RUN_BLOCKED`
- `MALFORMED_RUN_ARTIFACT`

Private validator details remain in local artifacts and are not returned to the benchmarked agent.

## Verification strategy

Implementation is split into three independently shippable plans:

1. **Correctness and integrity**
   - unresolved dirty-start provenance;
   - fresh finalization validation;
   - non-polluting runner injection;
   - atomic finish state;
   - trusted report cohorts and malformed-artifact tolerance.
2. **Skill and interface simplification**
   - thin operator skill;
   - minimal internal runner skill;
   - manual-run alias and human-readable default report;
   - metadata and documentation consistency.
3. **Deep-module extraction**
   - extract authoring, replay, reporting, and two adapter implementations;
   - preserve public exports and CLI compatibility;
   - replace old internal tests with interface-level behavior tests where appropriate.

Each behavior change follows red-green-refactor. Skill changes also receive fresh-agent scenarios for:

- capture timing under pressure to repair first;
- attempts to inspect private evidence;
- temptation to retry a failed one-shot finish.

Required final verification:

```sh
bun run typecheck
bun run test
bun run build
bun run smoke
```

## Compatibility

Existing command spellings remain valid during this optimization. JSON schemas are extended compatibly; readers provide defaults for old run artifacts. No existing finalized case is rewritten automatically.
