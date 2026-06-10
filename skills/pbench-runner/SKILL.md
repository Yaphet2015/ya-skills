---
name: pbench-runner
description: Use when a pbench benchmark worktree contains .pbench/run.json and the agent must complete the public replay task before triggering final validation.
---

# PBench Runner

Use this skill only inside a worktree prepared by `yk pbench start`.

## Workflow

1. Read `.pbench/public/prompt.md`.
2. Read `.pbench/public/replay.md` and `.pbench/case.public.json` for the public replay context.
3. Complete the benchmark task in the current repository worktree.
4. Read `.pbench/run.json` and run its `finishCommand`.
5. Report the finish result and the public work you changed.

## Boundaries

- Use only the repository files and the public replay capsule under `.pbench/public`.
- Do not search for private evaluator files, private validators, raw transcripts, or the original case directory.
- Do not run `yk pbench finish` more than once for the same run. The benchmark is one-shot.
