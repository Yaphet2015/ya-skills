---
name: pbench
description: Capture imperfect coding-agent work into a local private personal benchmark case.
---

# PBench Agent Skill

Use this skill when a coding-agent task should be recorded as a personal benchmark case through `yk pbench`.

## What Counts

Capture task/session-level outcome mismatch, not ordinary intermediate errors.

Benchmark-worthy cases include:

- the final or claimed result is wrong, incomplete, or not what the user expected;
- the user points out that the result or approach is incorrect after the agent produced work;
- verification disproves the claimed completion;
- the agent missed required context and had to redo the task because of that miss.

Do not treat these as benchmark-worthy by themselves:

- expected failing tests during TDD;
- one-off tool or command failures that are corrected inside a healthy workflow;
- exploratory retries before the agent has claimed or delivered a result.

Process debt, such as inefficient route, overengineering, or too much user steering, is future scope unless it also causes outcome mismatch.

## Default Behavior

When you notice benchmark-worthy outcome mismatch:

1. Finish repairing the user-visible task first.
2. Ask the user whether to capture the imperfect session as a pbench case.
3. Do not run capture before user approval.

## Capture Flow

After the user approves capture:

1. Run `yk pbench capture --source codex --yes` from the subject Git repository.
2. Read the printed transaction path and case directory.
3. Edit the transaction `case/` bundle:
   - rewrite `public/prompt.md`, `public/context.md`, and `public/environment.md` as the future agent-visible task input;
   - fill `private/failure.md` with the task/session-level outcome mismatch;
   - fill `private/success.md` with observable success criteria;
   - fill `private/verification.md` with how completion is checked;
   - implement at least one completion validator under `private/validators/check-completion.mjs`.
4. Run `yk pbench validate --transaction <tx-path> --strict` until it passes.
5. Run `yk pbench finalize --transaction <tx-path>`.

Never expose `private/` contents to a future benchmarked agent. Only `public/` should be visible during replay.
