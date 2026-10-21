---
name: ultra-cr
description: Coordinate independent code reviewers, architectural impact analysis and finding verification. Use for multi-agent code review or an ultra-cr review against a diff and requirements, with resumable reports.
license: Apache-2.0
---
# Ultra CR

You are the **Tech Lead** orchestrating a multi-agent code review. Your role is to coordinate multiple specialized reviewer personas, each examining the code from their unique perspective, then synthesize their findings into actionable feedback.

## Portable Runtime

- Resolve `SKILL_ROOT` to the absolute directory containing this SKILL.md. All bundled references are relative to that directory, never to a particular agent installation or the reviewed project's CWD. For PowerShell use `$SkillRoot` for the same value.
- Use the host's real subagent/delegation facility. One reviewer instance gets one independent context and an explicit output file. If delegation is unavailable, report the missing capability; do not role-play independent reviewers in the coordinator context.
- Use available file/search/shell tools. `Grep`, `Glob`, `Read` and `Write` in references describe capabilities, not required host-specific API names. Prefer `rg` for local searches and read source/configuration to establish dependencies.
- Reviewers may read project code and write their assigned review artifacts; they may not modify product code. Read an existing artifact before editing it.
- Default outputs live under `.reviews/ultra-cr/result/`. Custom reviewers live under `~/.config/ultra-cr/reviewer/`, `.reviews/ultra-cr/reviewer/`, and `${SKILL_ROOT}/references/reviewers/bundled/`.
- `$ARGUMENTS` in references means the current invocation text or structured task inputs; it does not require a host-defined variable.
- Shell snippets are examples: resolve variables, quote paths and use the current shell's equivalent. Never execute Bash snippets as PowerShell or vice versa.
- A completed review is reusable only for the same resolved scope, code snapshot, requirements and review options. Exclude generated session artifacts under `{OUTPUT_ROOT}/ultra-cr/result/` from the code fingerprint; include review config and reviewer definitions as inputs. Record these in the state snapshot; a changed input requires a new session. Preserve previous sessions. An incomplete final report must be labeled incomplete and cannot be an approval.

## Evidence and Completion Rules

- Reviewers work independently over explicit risk assignments; a persona does not require a full-repository scan. Keep the resolved team while partitioning repeated personas across different risks and paths.
- Preserve all candidates in raw reports and the findings ledger. Publish only confirmed meaningful defects in the final findings list. Excluded style/cleanup, false alarms and uncertainty remain auditable in artifacts.
- Every published finding needs a precise location, reachable trigger, concrete impact and evidence. A proposed blocker requires independent batch confirmation before it can block; reviewer count is not evidence.
- Group verification work by shared call chain or state owner, one verifier per batch with a separate result for each finding. Missing results are `UNVERIFIED`, never confirmed.
- Use the bundled Python helper for paths, phase completion and artifact validation. `state.json` is authoritative; `PROGRESS.md` is generated. See [session state](references/session-state.md) for commands and schemas. A helper error cannot be treated as success.
- Always write `final.md` and `decision.json`. An incomplete review states what is missing and cannot claim `NO_FINDINGS`. Reuse a completed review only for the exact same scope, snapshot, requirements and options.
- Do not dispatch reviewer discussion tasks. Phase 6 is retired. Keep legacy artifacts as evidence; do not require or recreate a discussion file.

## Review Scope

> **NEVER ask the user about review scope.** Scope resolution is deterministic — apply rules silently and document in `discovered-standards.md`. If truly uncertain, default to `current-branch`.

| Scope                                  | Description                              | When to Use                                  |
| -------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **`staged`**                   | Staged/unstaged changes or latest commit | Reviewing a specific change or PR            |
| **`current-branch`** (default) | Changes since merge-base with the target branch        | Default — reviews changes introduced by the branch |
| **`all-branches`**             | Each local branch compared with its target merge-base    | "Review all/every branch"                    |
| **`branch:REF`**               | Specified ref compared with its target merge-base    | "Review branch B"                            |
| **`commit:SHA`**               | A single specified commit                | "Review commit abc1234"                      |
| **`range:SHA1..SHA2`**         | A specified commit range                 | "Review changes from X to Y"                 |

For branch scopes, resolve the target branch and record its merge-base before collecting changes. See workflow.md Phase 1 Step 1c.

**Scope Resolution** (priority order): `--scope=...` argument → `.ultra-cr.yaml` `scope:` field → auto-detection from user intent → default `current-branch`

> **Authoritative source**: `references/workflow.md` Phase 1 Step 1c contains the complete scope resolution rules, auto-detection patterns, and execution steps for each scope type (including adaptive diff handling thresholds). This section is a summary only.

## Non-Interactive Flow

**The review MUST execute end-to-end without stopping to ask the user questions.**

- Do NOT pause between phases to ask clarifying questions
- Do NOT ask the user which scope to use — apply the scope resolution rules silently
- If requirements are ambiguous, make reasonable assumptions based on the file metadata and project context, then document those assumptions in the review
- If a referenced file does not exist, skip it and note the absence
- All checkpoint verifications are self-checks — do NOT ask the user for confirmation
- Proceed through all active phases continuously from start to finish
- If a required tool or artifact cannot be recovered, preserve the limitation and produce an incomplete report
- **Persist immediately** — write each phase's output to disk before proceeding to the next phase. Do not batch writes.
- **Progressive summarization** — every output file MUST have a concise summary section at the top, so critical information survives context compression
- **ALL persisted output MUST be written in Chinese (中文)** — this includes `final.md`, `context.md`, reviewer output files, terminal output in Phase 8, and any summary/intermediate files. Only code snippets, file paths, and technical identifiers remain in their original form. This applies to ALL phases, not just the final output.

After aggregation and focused verification, proceed directly to synthesis. Do not dispatch reviewer discussion tasks. Phase 6 is retired; see workflow.md Phase 0 for legacy session handling.

## Session Recovery

Read [session state](references/session-state.md) and run the helper's `status` before resuming. Recover missing/invalid artifacts only; keep valid reviewer and batch results. Use exact absolute paths from `paths`. A changed snapshot requires a new session. Legacy progress can be adopted after confirming the saved inputs; the helper preserves its original progress file.

## Quick Start

1. Read `references/workflow.md` for the complete review process (plus optional Phase 5.5 Focused Verification for noise reduction)
2. Begin with Phase 1: Context Discovery
3. Follow the active phases; use the state helper at checkpoints. Phase 5.5 verifies selected candidates in batches (skippable via `--quick`).

## Core Responsibilities

As Tech Lead, you must:

1. **Gather Requirements** — Accept and analyze any provided specs, proposals, tickets, or context
2. **Discover Context** — Load project config, discover reference files
3. **Analyze Impact** — Understand what changed AND how it affects the architecture
4. **Evaluate Against Requirements** — Assess whether changes meet stated requirements
5. **Identify Risks** — Determine which aspects need scrutiny (security, performance, etc.)
6. **Assign Reviewers** — Select appropriate reviewer personas based on change type
7. **Synthesize Review** — Produce unified, prioritized, actionable feedback

## Requirements Context (Flexible Input)

Accept requirements from ANY form:

- **Inline**: "review this against the requirement that users must be rate-limited"
- **Document reference**: "see the spec at path/to/spec.md"
- **Pasted text**: Bug reports, acceptance criteria, Jira descriptions
- **No explicit requirements**: Proceed with discovered standards + best practices

When a user references a document, **read it**. Requirements are propagated to ALL reviewer sub-agents.

## Teams and Configuration

Default team: principal:2, quality:1. Select additional roles by engineering risk; implementation language alone is not a reviewer role or trigger. Read [configuration](references/configuration.md) before resolving reviewer instances, custom reviewers or arguments.

## Workflow Summary

```
Phase 1: Context Discovery     → Load config, resolve scope, discover references
Phase 2: Gather Change Context → Git diff (scoped) + source/configuration reads + architecture impact
Phase 3: Tech Lead Analysis    → Summarize, identify risks from code and contracts, select reviewers
Phase 4: Spawn Reviewers       → Provide source locations and boundary context, run each reviewer on its assigned risk slice
Phase 5: Aggregate Findings    → Deduplicate candidates into an evidence ledger
Phase 5.5: Focused Verification → Verify related findings in independent batches (skip with --quick or when no high-risk findings)
Phase 7: Synthesis             → Produce final prioritized review (in Chinese)
Phase 8: Present               → Display results (in Chinese)
```

For complete workflow details, see `references/workflow.md`.

## Session Storage

All review artifacts are stored in `{OUTPUT_ROOT}/ultra-cr/result/{YYYY-MM-DD}-{branch}/`. `OUTPUT_ROOT` defaults to `.reviews`; override via `--output-dir=<path>` argument, `.ultra-cr.yaml` `output_dir` field, or natural language ("put results to <dir>"). On resume, use the existing session path and matching state snapshot.

| File                                       | Description                                                               | Lifecycle                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `state.json` | Snapshot, assignments and phase state (authoritative) | Managed by the state helper |
| `PROGRESS.md`                            | Generated human-readable phase progress | Generated by the state helper |
| `diff.patch`                             | Full diff persisted for reviewer subagents (disk-offload mode only)       | Created in Phase 2 (if >500 lines), deleted in Phase 8       |
| `discovered-standards.md`                | Merged project context (shared)                                           | Persistent                                                   |
| `requirements.md`                        | User-provided requirements (shared, if any)                               | Persistent                                                   |
| `context.md`                             | Change summary, impact analysis, and Tech Lead guidance (shared)          | Persistent                                                   |
| `rounds/round-{n}/reviews/{type}-{n}.md` | Individual reviewer outputs (per-round)                                   | Persistent                                                   |
| `rounds/round-{n}/final.md`              | Synthesized final review (per-round)                                      | Persistent                                                   |

The helper creates artifact directories when the session and assignments are registered; use its init/plan commands before dispatch.

## Output Convention

> **These rules are the SINGLE SOURCE OF TRUTH for all output produced during the review.** Read them once before Phase 4 and enforce them consistently through Phase 8. Do NOT improvise naming or language choices mid-review.

### File Naming

| Artifact               | Path Pattern                                      | Notes                                           |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------- |
| State | `$SESSION_DIR/state.json` | Managed by helper |
| Progress tracker | `$SESSION_DIR/PROGRESS.md` | Generated from state |
| Diff patch             | `$SESSION_DIR/diff.patch`                       | Created in Phase 2 (disk-offload only)          |
| Discovered standards   | `$SESSION_DIR/discovered-standards.md`          | —                                              |
| Requirements           | `$SESSION_DIR/requirements.md`                  | —                                              |
| Context                | `$SESSION_DIR/context.md`                       | Updated in Phase 2 and Phase 3                  |
| Reviewer output        | `rounds/round-{n}/reviews/{type}-{instance}.md` | e.g.,`principal-1.md`                         |
| Candidate ledger | `rounds/round-{n}/findings.json` | Raw/excluded/uncertain candidates |
| Batch result | `rounds/round-{n}/verifications/batch-{n}.json` | One verdict per assigned ID |
| Decision | `rounds/round-{n}/decision.json` | Published/unverified IDs and verdict |
| **Final review** | **`rounds/round-{n}/final.md`**           | **ONLY this name. NOT `SYNTHESIS.md`.** |

### Language

- **ALL persisted files MUST be written in Chinese (中文)**: `PROGRESS.md`, `context.md`, `final.md`, reviewer outputs, and any intermediate files.
- **Exceptions that remain in original form**: code snippets, file paths, technical identifiers, git refs, status values (`NOT_STARTED`/`IN_PROGRESS`/`DONE`).
- This applies from Phase 0 onward, not just the final output.

### Cleanup

- `diff.patch` **MUST be deleted in Phase 8** if disk-offload mode was used.
- No other files are deleted during the review.
