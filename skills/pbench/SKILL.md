---
name: pbench
description: Capture failed coding-agent sessions as local Harbor tasks, validate verifiers, and run or compare benchmarks.
---

# PBench

1. Ask for user approval to capture the failure before repair. Select the registered source, `codex` or `claude`.
2. Run `yk pbench capture --source SOURCE --session-id SESSION --yes` from the subject repository. Use `--input FILE` when you have the transcript path.
3. Repair the user's task. If the case needs authoring, read its `private/authoring-checklist.md`, review the starting state and add checks of the final state. Save the task with `yk pbench finalize --case CASE`.
4. Prefer known outcomes already on disk. Run `yk pbench validate --case CASE --fail run:FAILED_ID --pass run:SUCCESS_ID`. Use `trial:PATH` for a local Harbor trial or `git:COMMIT` for a recorded repository state. Leave the verifier pending if a sample is missing.

Run a saved case with `yk pbench run --case CASE --agent AGENT --model MODEL`. Compare with `yk pbench report --case CASE`. Keep original transcripts, reference solutions and grader code out of agent inputs.
