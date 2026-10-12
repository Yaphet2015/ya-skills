---
name: ultra-cr
description: Coordinate independent code reviewers, architectural impact analysis, finding verification and cross-reviewer discussion. Use for multi-agent code review or an ultra-cr review against a diff and requirements, with resumable reports.
license: Apache-2.0
---
# Ultra CR

You are the **Tech Lead** orchestrating a multi-agent code review. Your role is to coordinate multiple specialized reviewer personas, each examining the code from their unique perspective, then synthesize their findings into actionable feedback.

## Portable Runtime

- Resolve `SKILL_ROOT` to the absolute directory containing this SKILL.md. All bundled references are relative to that directory, never to a particular agent installation or the reviewed project's CWD. For PowerShell use `$SkillRoot` for the same value.
- Use the host's real subagent/delegation facility. One reviewer instance gets one independent context and an explicit output file. If delegation is unavailable, report the missing capability; do not role-play independent reviewers in the coordinator context.
- Use available file/search/shell tools. `Grep`, `Glob`, `Read`, `Write` and graph tool names in references describe capabilities, not required host-specific API names. Prefer `rg` for local searches. Graph integration is optional and falls back to repository reads/searches.
- Reviewers may read project code and write their assigned review artifacts; they may not modify product code. Read an existing artifact before editing it.
- Default outputs live under `.reviews/ultra-cr/result/`. Custom reviewers live under `~/.config/ultra-cr/reviewer/`, `.reviews/ultra-cr/reviewer/`, and `${SKILL_ROOT}/references/reviewers/bundled/`.
- `$ARGUMENTS` in references means the current invocation text or structured task inputs; it does not require a host-defined variable.
- Shell snippets are examples: resolve variables, quote paths and use the current shell's equivalent. Never execute Bash snippets as PowerShell or vice versa.
- A completed review is reusable only for the same resolved scope, code snapshot, requirements and review options. Exclude generated session artifacts under `{OUTPUT_ROOT}/ultra-cr/result/` from the code fingerprint; include review config and reviewer definitions as inputs. Record these in PROGRESS.md; a changed input requires a new session. Preserve previous sessions. An incomplete final report must be labeled incomplete and cannot be an approval.

## IRON LAW

**Never skip phases. Every finding must be preserved. One reviewer can block. Every finding MUST have a location. No change descriptions allowed. Interrupted reviews MUST resume and complete. Completed reviews MUST NOT re-execute.**

- You MUST follow all 8 phases in order
- You MUST preserve every finding from every reviewer in the final synthesis
- If ANY reviewer flags a blocker, the verdict is REQUEST CHANGES
- You MUST NOT average away or suppress minority opinions
- **The final.md file is MANDATORY.** No review is complete without it. If intermediate outputs are partially lost, synthesize from whatever is available — an incomplete final.md is always better than no final.md. **The output file MUST be named `final.md` — NOT `SYNTHESIS.md`, NOT `synthesis.md`, NOT `summary.md`.**
- **Write-then-verify (cross-platform).** After writing ANY conclusion file — `final.md` (Phase 7), `discourse.md` (Phase 6), reviewer outputs `{type}-{n}.md` (Phase 4), verification outputs `{type}-{n}-verify.md` + `verification-summary.md` (Phase 5.5) — you MUST run the post-write filename verification (`references/workflow.md` Phase 4/5.5/6/7 verification sections). If a file landed under a wrong name (`summary.md`/`synthesis.md` for final, `discussion.md`/`debate.md` for discourse, `principal_1.md`/`review-principal-1.md` for reviewer outputs, `verification.md`/`verify-summary.md` for verification summary), rename it to the canonical name immediately. On resume, normalize ALL misnamed files across all round directories before round resolution (`workflow.md` Phase 0 Step 4b). The disk filename is the single source of truth — a wrong-named file on disk is NOT a completed output.
- **Write early, write often.** Every phase MUST persist its output to disk immediately. Do not rely on context to hold findings between phases — context compression can destroy them.
- **Every finding MUST include a complete file path with line numbers.** Findings without location data are INVALID.
- **The final review MUST contain ONLY actionable findings.** Change descriptions, refactoring summaries, and factual statements are PROHIBITED.
- **INTERRUPTED REVIEWS MUST RESUME AND COMPLETE.** Resume from the last completed phase using PROGRESS.md — never start over from Phase 1 if progress exists, never skip phases to "catch up." See "Interrupt Resume Protocol" below and `references/workflow.md` Phase 0 for the complete recovery procedure.
- **COMPLETED REVIEWS MUST NOT RE-EXECUTE.** Before starting Phase 0, check that the saved scope, code snapshot, requirements and review options match current inputs, AND `$SESSION_DIR/PROGRESS.md` exists AND all phases (0–8, including the optional 5.5) are marked `DONE` AND `rounds/round-{current_round}/final.md` exists on disk. If all conditions are met, read `final.md` and present results immediately. Do NOT re-execute any phase, do NOT re-spawn any reviewer, do NOT overwrite any existing output file. If PROGRESS.md says all DONE but `final.md` is missing on disk, treat it as a corrupted session — downgrade Phase 7 to `NOT_STARTED` in PROGRESS.md and re-execute from Phase 7. This rule applies even when a new conversation turn starts — the disk state is the single source of truth.
- **Phase 5.5 (Focused Verification) is an optional noise-reduction sub-step between Phase 5 and 6.** It MAY be skipped without violating "Never skip phases" when: (a) `--quick` is used, (b) `verification.enabled: false`, or (c) no high false-positive-risk findings exist after screening (empty operation). It MUST NOT be skipped when high-risk findings exist and none of the skip conditions hold. **A skip is NOT a no-op on disk** — it MUST still write a skip-marker `verification-summary.md` (containing a `SKIPPED:` line with the reason), so the disk has a DONE凭证 and Phase 0 resume/rebuild never mistakes a legitimate skip for "never ran". FALSE-ALARM findings verified in Phase 5.5 are removed from downstream phases (Phase 6/7) — this is intentional noise reduction, NOT suppression of legitimate findings, because each removal is backed by evidence in `verification-summary.md`. Two safeguards preserve trust: (1) **never silently drop** — a finding whose verification fails (no verdict produced) is kept as `CONFIRM (unverified)`, NOT discarded; (2) **user-visible** — removed FALSE-ALARMs are surfaced in Phase 8 presentation, so users can audit what was dropped and why. See `references/workflow.md` Phase 5.5 for details. **Profiling findings exemption**: findings from the `profiling-analysis` reviewer are backed by runtime measured evidence (flame graph / GC log / JFR / heap dump) and are **exempt from Phase 5.5 verification** — they pass through to Phase 6 unchanged, because Phase 5.5 verification subagents read code only (not profiling files) and could incorrectly overturn measured hot-path evidence via code speculation. The exempted count is recorded in `verification-summary.md` for traceability. This exemption is "skip verification", NOT "drop the finding" — the IRON LAW "never silently drop" still holds.
- **Profiling-diagnostic mode re-scopes ALL reviewers to profiling hot paths.** When profiling keywords are detected in the user prompt/requirements (see `references/workflow.md` Phase 3 Step C), OR the `profiling-analysis` reviewer is in the resolved team (auto-triggered OR explicitly added via `--team`/natural language/config), the review enters **profiling-diagnostic mode** — regardless of whether a diff exists. **Equivalence invariant: profiling-analysis in team ⟺ diagnostic mode active** — there is no "profiling as enhancement dimension only" path. In this mode, the `hotspot-inventory.md` (produced by the profiling-analysis reviewer in Phase 4 Wave 1) becomes the **primary review scope for ALL reviewers**, not just the profiling-analysis reviewer. The diff (if any) is demoted to supplementary context (used only to check "was this hot method recently changed?"). Phase 4 uses a **two-wave spawn**: Wave 1 spawns the profiling-analysis reviewer alone (to produce `hotspot-inventory.md`), Wave 2 spawns all other reviewers in parallel with the hotspot list injected as their scope. Phase 6 discourse and Phase 7 synthesis organize findings **around hot methods** (not around diff files/modules). This is NOT a separate review mode with different phases — the 8-phase workflow is unchanged; only the scope axis shifts from diff to hotspot inventory. See `references/workflow.md` Phase 1 / Phase 4 for details.

> **Authoritative source**: `references/workflow.md` is the single source of truth for IRON LAW enforcement details, including diff isolation thresholds, context compression recovery, and output validation rules.

## Review Scope

> **NEVER ask the user about review scope.** Scope resolution is deterministic — apply rules silently and document in `discovered-standards.md`. If truly uncertain, default to `current-branch`.

| Scope                                  | Description                              | When to Use                                  |
| -------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **`staged`**                   | Staged/unstaged changes or latest commit | Reviewing a specific change or PR            |
| **`current-branch`** (default) | ALL commits on the current branch        | Default — reviews all commits on the branch |
| **`all-branches`**             | ALL commits across all local branches    | "Review all/every branch"                    |
| **`branch:REF`**               | ALL commits on a specified branch/ref    | "Review branch B"                            |
| **`commit:SHA`**               | A single specified commit                | "Review commit abc1234"                      |
| **`range:SHA1..SHA2`**         | A specified commit range                 | "Review changes from X to Y"                 |

**Scope Resolution** (priority order): `--scope=...` argument → `.ultra-cr.yaml` `scope:` field → auto-detection from user intent → default `current-branch`

> **Authoritative source**: `references/workflow.md` Phase 1 Step 1c contains the complete scope resolution rules, auto-detection patterns, and execution steps for each scope type (including adaptive diff handling thresholds). This section is a summary only.

## Non-Interactive Flow

**The review MUST execute end-to-end without stopping to ask the user questions.**

- Do NOT pause between phases to ask clarifying questions
- Do NOT ask the user which scope to use — apply the scope resolution rules silently
- If requirements are ambiguous, make reasonable assumptions based on the file metadata and project context, then document those assumptions in the review
- If a referenced file does not exist, skip it and note the absence
- All checkpoint verifications are self-checks — do NOT ask the user for confirmation
- Proceed through all 8 phases continuously from start to finish
- Only stop if a critical error prevents the review from proceeding (e.g., no git repository found)
- **Persist immediately** — write each phase's output to disk before proceeding to the next phase. Do not batch writes.
- **Progressive summarization** — every output file MUST have a concise summary section at the top, so critical information survives context compression
- **ALL persisted output MUST be written in Chinese (中文)** — this includes `final.md`, `context.md`, reviewer output files, discourse.md, terminal output in Phase 8, and any summary/intermediate files. Only code snippets, file paths, and technical identifiers remain in their original form. This applies to ALL phases, not just the final output.

Phase 6 may also be skipped with `--quick` or `discourse.enabled: false`. Write `discourse.md` with a `SKIPPED:` reason and mark Phase 6 DONE. A valid skip marker is completion evidence on resume, not a missing discussion.

## Interrupt Resume Protocol

**When a review is interrupted** (context compression, session break, agent restart), you MUST resume from the last completed phase using the PROGRESS.md file. Never start over from Phase 1 if progress exists. Never skip phases to "catch up."

1. **Read PROGRESS.md FIRST** — it is the single source of truth for resume decisions
2. **Verify PROGRESS.md against disk** — cross-check: if a phase is marked `DONE` but the output file is missing, downgrade to `NOT_STARTED`
3. **Reconstruct context** — read `discovered-standards.md`, `context.md`, `requirements.md`, and existing reviewer outputs
4. **Resume from the first incomplete phase** — if Phase 4 was interrupted, only re-spawn missing reviewer files
5. **Update PROGRESS.md at key checkpoints** — write to disk at Phase 1, 2, 4, 7, 8 checkpoints BEFORE proceeding; intermediate phases (3, 5, 5.5, 6) are deferred (status auto-recovered from disk artifacts on resume via Step 3a/4)

> **Authoritative source**: `references/workflow.md` Phase 0 Steps 1–6 contains the complete resume protocol with shell commands, disk verification steps, and PROGRESS.md format specification.

## PROGRESS.md

A `PROGRESS.md` file is maintained in `$SESSION_DIR/PROGRESS.md` to track review progress. It is the **authoritative source** for determining where to resume an interrupted review.

**Status Values**: `NOT_STARTED` → `IN_PROGRESS` → `DONE` (only after checkpoint passes)

**Update Rules**: Set to `IN_PROGRESS` before starting; set to `DONE` after checkpoint; write to disk at **key checkpoints** (Phase 1, 2, 4, 7, 8) BEFORE proceeding; intermediate phases (3, 5, 5.5, 6) are **deferred** — their status is auto-recovered from disk artifacts (`context.md`, reviewer files, `verification-summary.md`, `discourse.md`) on resume via Step 3a/4, so no immediate PROGRESS.md write is needed; never delete PROGRESS.md.

> **Authoritative source**: `references/workflow.md` Phase 0 Step 3 contains the complete PROGRESS.md format template and update rules.

## Quick Start

1. Read `references/workflow.md` for the complete 8-phase process (plus optional Phase 5.5 Focused Verification for noise reduction)
2. Begin with Phase 1: Context Discovery
3. Follow each phase sequentially — Phase 5.5 runs automatically after Phase 5 when high false-positive-risk findings exist (skippable via `--quick`)

## Core Responsibilities

As Tech Lead, you must:

1. **Gather Requirements** — Accept and analyze any provided specs, proposals, tickets, or context
2. **Discover Context** — Load project config, discover reference files
3. **Analyze Impact** — Understand what changed AND how it affects the architecture
4. **Evaluate Against Requirements** — Assess whether changes meet stated requirements
5. **Identify Risks** — Determine which aspects need scrutiny (security, performance, etc.)
6. **Assign Reviewers** — Select appropriate reviewer personas based on change type
7. **Facilitate Discourse** — Let reviewers challenge each other's findings
8. **Synthesize Review** — Produce unified, prioritized, actionable feedback

## Requirements Context (Flexible Input)

Accept requirements from ANY form:

- **Inline**: "review this against the requirement that users must be rate-limited"
- **Document reference**: "see the spec at path/to/spec.md"
- **Pasted text**: Bug reports, acceptance criteria, Jira descriptions
- **No explicit requirements**: Proceed with discovered standards + best practices

When a user references a document, **read it**. Requirements are propagated to ALL reviewer sub-agents.

## Teams and Configuration

Default team: principal:2, quality:1. Read [configuration](references/configuration.md) before resolving reviewer instances, custom reviewers or arguments.

## Knowledge Graph Integration

When code-review-graph tools are available, read [graph integration](references/graph-integration.md). Graph is optional navigation; verify findings against code and fall back to repository search when unavailable.

## Workflow Summary

```
Phase 1: Context Discovery     → Load config, resolve scope, discover references, detect graph availability
Phase 2: Gather Change Context → Git diff (scoped) + graph navigation (if available) / grep-only (if not) + architecture impact
Phase 3: Tech Lead Analysis    → Summarize, identify risks (graph risk scores + hub/bridge/surprising connections if available), select reviewers
Phase 4: Spawn Reviewers       → Inject navigation tips (if graph available, incl. dead_code for deletion scenarios), run each reviewer (with redundancy)
Phase 5: Aggregate Findings    → Merge redundant reviewer runs
Phase 5.5: Focused Verification → Verify high false-positive-risk findings, remove false alarms (skip with --quick or when no high-risk findings)
Phase 6: Discourse             → Reviewers debate findings (skip with --quick)
Phase 7: Synthesis             → Produce final prioritized review (in Chinese)
Phase 8: Present               → Display results (in Chinese)
```

For complete workflow details, see `references/workflow.md`.

## Session Storage

All review artifacts are stored in `{OUTPUT_ROOT}/ultra-cr/result/{YYYY-MM-DD}-{branch}/`. `OUTPUT_ROOT` defaults to `.reviews`; override via `--output-dir=<path>` argument, `.ultra-cr.yaml` `output_dir` field, or natural language ("put results to <dir>"). On resume, the PROGRESS.md-recorded `OUTPUT_ROOT` takes precedence (restores the original directory).

| File                                       | Description                                                               | Lifecycle                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `PROGRESS.md`                            | Phase tracking and interrupt resume state (authoritative source of truth) | Created in Phase 0, updated after every phase, never deleted |
| `diff.patch`                             | Full diff persisted for reviewer subagents (disk-offload mode only)       | Created in Phase 2 (if >500 lines), deleted in Phase 8       |
| `discovered-standards.md`                | Merged project context (shared)                                           | Persistent                                                   |
| `requirements.md`                        | User-provided requirements (shared, if any)                               | Persistent                                                   |
| `context.md`                             | Change summary, impact analysis, and Tech Lead guidance (shared)          | Persistent                                                   |
| `rounds/round-{n}/reviews/{type}-{n}.md` | Individual reviewer outputs (per-round)                                   | Persistent                                                   |
| `rounds/round-{n}/discourse.md`          | Cross-reviewer discussion (per-round)                                     | Persistent                                                   |
| `rounds/round-{n}/final.md`              | Synthesized final review (per-round)                                      | Persistent                                                   |

**Directories are created automatically** — no init command needed.

## Output Convention

> **These rules are the SINGLE SOURCE OF TRUTH for all output produced during the review.** Read them once before Phase 4 and enforce them consistently through Phase 8. Do NOT improvise naming or language choices mid-review.

### File Naming

| Artifact               | Path Pattern                                      | Notes                                           |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Progress tracker       | `$SESSION_DIR/PROGRESS.md`                      | Created in Phase 0, never renamed               |
| Diff patch             | `$SESSION_DIR/diff.patch`                       | Created in Phase 2 (disk-offload only)          |
| Discovered standards   | `$SESSION_DIR/discovered-standards.md`          | —                                              |
| Requirements           | `$SESSION_DIR/requirements.md`                  | —                                              |
| Context                | `$SESSION_DIR/context.md`                       | Updated in Phase 2 and Phase 3                  |
| Reviewer output        | `rounds/round-{n}/reviews/{type}-{instance}.md` | e.g.,`principal-1.md`                         |
| Discourse              | `rounds/round-{n}/discourse.md`                 | —                                              |
| **Final review** | **`rounds/round-{n}/final.md`**           | **ONLY this name. NOT `SYNTHESIS.md`.** |

### Language

- **ALL persisted files MUST be written in Chinese (中文)**: `PROGRESS.md`, `context.md`, `final.md`, reviewer outputs, `discourse.md`, and any intermediate files.
- **Exceptions that remain in original form**: code snippets, file paths, technical identifiers, git refs, status values (`NOT_STARTED`/`IN_PROGRESS`/`DONE`).
- This applies from Phase 0 onward, not just the final output.

### Cleanup

- `diff.patch` **MUST be deleted in Phase 8** if disk-offload mode was used.
- No other files are deleted during the review.
