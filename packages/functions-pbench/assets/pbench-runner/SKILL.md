---
name: pbench-runner
description: Use when `.pbench/run.json` exists in a prepared PBench worktree and the public replay task must be completed exactly once.
---

# PBench Runner

1. Read `.pbench/public/prompt.md`, `.pbench/public/replay.md`, and `.pbench/case.public.json`.
2. Solve the task using only this repository and `.pbench/public/`.
3. Read only `finishCommand` from `.pbench/run.json`, run it once, and report its result.

Do not inspect evaluator evidence, validators, captured sessions, case storage, run artifacts, or harness source. They are outside the task and invalidate the measurement.

A failed finish is terminal. Do not retry or start a replacement run.
