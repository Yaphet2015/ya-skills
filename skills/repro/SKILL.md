---
name: repro
description: Generate manual acceptance steps from a diff, with expected and before-change behavior, evidence, and optional mock setup. Use for /repro or human QA handoffs.
---

# Repro

Turn a change into a manual acceptance sheet the user can follow. Each case explains how to reach the changed behavior, what to observe, what should happen, and what happened before. Write the sheet in the user's language.

The deliverable is a sheet, not an application test run. Do not launch the app, inject mocks, modify product code, or mark cases passed as part of generating it. Use existing observations and read-only repository evidence; describe any remaining manual setup explicitly.

## Modes

| Invocation | Deliverable |
| --- | --- |
| `/repro [diff range or requirement]` | Acceptance sheet for the selected change; default mode. |
| `/repro baseline [file...]` | Before-change evidence note for the selected behavior, before implementation. Runtime observations remain pending unless supplied. |
| `/repro again [previous sheet]` | Updated sheet with stable IDs; prioritize user-reported failures, blocked cases whose prerequisites changed, and adjacent behavior affected by the fix. |

Read [references/template.md](references/template.md) for the report and mode-specific fields. Read [references/surfaces.md](references/surfaces.md) when locating entrypoints and observations. Read [references/mock-contract.md](references/mock-contract.md) only if a case needs fault injection or controlled timing.

## Establish the comparison

1. Read the request, available requirement/PR description, repository instructions, and any supplied review or previous sheet. Use connected session tools when the user references another conversation. Recover this context before asking the user to repeat it.
2. Resolve the repository root, branch, HEAD, and requested scope. In `baseline` mode, capture current HEAD plus selected dirty contents; no branch target is needed. Otherwise prefer an explicit range or the PR's actual target. Use a target documented by the repository or session; a local default-branch ref is a fallback only when that matches the task. Do not invent a release branch or assume the feature branch's tracking branch is its target. Ask one focused question if the target remains ambiguous.
3. Freeze the base and head SHAs. For branch acceptance, compare the target's merge-base with HEAD, plus staged, unstaged, and non-ignored untracked files. An explicit `A..B` means the exact two endpoints; `A...B` means merge-base(A,B) to B. Honor narrower scopes, historical heads, and explicit exclusions instead of silently adding the current worktree. Record the resolved scope and omissions in the sheet.

For the common branch-to-current-worktree scope, run the bundled scanner using its installed path:

```sh
node "<skill-dir>/scripts/repro-scan.mjs" --repo "<repo-root>" --base "<target-ref-or-sha>"
```

`bun` can run the same script. It emits JSON inventory and immutable commit IDs; it does not read file contents or decide which behavior changed. `committed` is merge-base to HEAD; `staged` is HEAD to index; `unstaged` is index to worktree; `untracked` excludes ignored files. Renames appear as delete/add so both paths remain visible. Files can appear in several layers, including changes later canceled; inspect the final contents before generating cases. For other scopes use equivalent NUL-delimited Git commands with explicit endpoints. Scanner failure is a scope blocker, not an empty diff.

## Derive cases from evidence

Read the actual hunks, changed file contents, callers, and baseline implementation at the recorded comparison SHA. For untracked files, read the files directly; they do not appear in `git diff`. Deleted files still need caller/entrypoint analysis. For a submodule change, inspect the nested commit range or state the missing nested evidence as a blocker.

Group by distinct behavior and user surface, not one case per file. Trace shared components to their affected rendering points. Identify an exact label, route, command, or other user-facing entrypoint from the repository. For services, storage, and build changes use an observable log, query, file, command exit, or generated artifact. Do not invent a click path for invisible behavior. Unmerged (`U`) paths block acceptance of that surface until resolved.

Every changed file must map to a case, a blocker, or an explicit reason it needs no manual check. Documentation and tests often need no manual check, but inspect whether they change shipped instructions, fixtures, or acceptance expectations. Preserve a coverage table even for large changes.

### Correct expectation and previous behavior are separate claims

Choose expected behavior from the user's requirement or acceptance criteria first, then a relevant confirmed review finding. Existing contracts/tests and implementation can inform a proposed expectation, but cannot prove product intent. Label an expectation derived only from code as **proposed, needs confirmation**. If sources conflict, expose the conflict instead of choosing whichever matches the implementation.

Tag each before-change claim:

| Tag | Meaning | Required evidence |
| --- | --- | --- |
| `[E]` | Baseline code establishes this deterministic result. | Baseline SHA, file/lines, and causal path or supplied calculation. Does not mean the app was run. |
| `[R]` | Baseline code suggests the behavior, but timing, data, services, or rendering affect it. | Baseline code reference plus the runtime dependency still to check. |
| `[?]` | Before-change behavior is unknown. | Say **先测基线 / test the baseline first**, with the missing evidence. |

Record actual baseline observations separately with observer/source, build SHA, environment, and artifact if available. A user report is an attributed observation, not automatically deterministic code evidence. Missing baseline files for new features can establish absence only after checking for alternate implementations. Never invent timing limits, pixel tolerances, data counts, selectors, or log strings. Use requirement values or mark proposed criteria. Agreement with baseline establishes regression consistency; it does not establish correctness.

## Write and deliver

Use the template. Lead with up to three highest-value cases, an environment card, and blockers. Prioritize the changed primary path, failure/recovery behavior where relevant, and a specific adjacent behavior that must remain stable. Explain that adjacent case's relationship to the change.

Keep each sheet to at most ten detailed cases. For broader changes, split into linked sheets by surface and keep a complete coverage index; do not discard the remaining cases. Each case needs a decisive observable outcome and reset instructions for stateful steps. An unknown entrypoint or unavailable fixture makes the case blocked; it does not justify a plausible-sounding sequence.

Use the artifact location already established by the task/repository. Use `.fleet/artifacts/<clone>--<branch>/` only when that convention exists. Otherwise create a unique directory under the OS temporary directory and give its absolute path. Do not edit ignore rules or install into other clones. Keep reports outside the selected diff so generating the sheet does not add acceptance work.

In `baseline` mode, record HEAD, dirty layers and relevant contents/diffs: HEAD alone cannot identify an uncommitted baseline. Describe the manual observation needed and link the note when later generating the sheet. In `again` mode, read the previous sheet and any user results first. Keep IDs for the same behavior; append IDs for new behavior and record removed cases with reasons. Do not infer failure from unchecked boxes. With no reported results, say results are unknown and prioritize cases affected by the new diff. Preserve attributed past results as history; the current build's checks remain `☐ 待验` or `☐ 阻塞`.

Before delivery, check that all files are accounted for, all cases identify the correct clone/build, all expectations have sources, all before-change claims have evidence tags, and every mock has a restore path. Return the report link, the first three cases, and material blockers in a short message. Never claim human acceptance is complete.
