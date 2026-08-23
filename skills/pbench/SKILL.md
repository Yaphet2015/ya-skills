---
name: pbench
description: Use when a coding-agent outcome is wrong or incomplete, or when the user asks to capture, run, replay, compare, report, or operate PBench.
---

# PBench

## Outcome mismatch

1. Stop claiming completion.
2. Ask for user approval to snapshot the failure **before repair**.
3. Select the registered source that produced the transcript: `codex` or `claude`. Run `yk pbench capture --source <registered-source> --yes` from the subject repository. If the transcript source is not registered, stop and report that direct capture is unsupported.
4. Repair the user task.
5. Read the generated `private/authoring-checklist.md` and follow the single printed recovery or finalization action.

The snapshot records dirty tracked and untracked state as unresolved private candidates. Do not silently treat those edits as replay input.

## Explicit benchmark operation

- Headless: `yk pbench run --case <case> --agent <agent> --profile <label>`.
- Manual: `yk pbench run --case <case> --manual --profile <label>`.
- Compare: `yk pbench report --profile <label>`.

Current built-in runners are `codex` and `claude`. Use stable profile labels for comparisons.

## Invariants

- Private material never enters replay input or benchmark-agent context.
- Finalization must pass fresh strict validation of the exact case bundle.
