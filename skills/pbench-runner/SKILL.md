---
name: pbench-runner
description: Use when a pbench benchmark worktree contains .pbench/run.json and the agent must complete the public replay task before triggering final validation.
---

# PBench Runner

Use this skill only inside a worktree prepared by `yk pbench start`.

## Workflow

1. Read `.pbench/public/prompt.md`, `.pbench/public/replay.md`, and `.pbench/case.public.json`.
2. Complete the benchmark task in the current repository worktree.
3. When finished, read `.pbench/run.json` ONLY to obtain its `finishCommand`, then run that command once.
4. Report only the finish result and any public work you changed.

## Integrity boundaries

The harness (the operator) prepared this worktree and runs the private validators outside it; your only job is the public task plus the one-shot finish. You are being measured, so do not seek information a normal task-solving agent would not have.

Do NOT read, search, grep, or open any of the following — they are out of scope and reading them invalidates the measurement:

- Evaluator evidence, validator scripts, and raw session transcripts (the non-public side of the case).
- The private-evidence and case-directory environment variables and anything they point at.
- The original captured case directory or any captured session material.
- The benchmark run-artifacts directory and any prior or current run's outputs (summaries, metrics, validator outcomes, agent logs).
- The pbench harness implementation and these skill definitions.

Single attempt: the benchmark is one-shot. Run the `finishCommand` at most once. If it fails, the run is terminal — report the failure; do not retry, and do not start another run for the same case to improve on it.

Access audit: for every file you open, append one JSON line to `.pbench/access-audit.jsonl` of the form `{"path":"<path>","at":"<iso-8601>"}`. This voluntary log is reviewed afterward for sensitive reads; skipping it does not hide reads.
