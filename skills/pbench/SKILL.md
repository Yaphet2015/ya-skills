---
name: pbench
description: Use when a coding agent's final result is wrong, incomplete, or disproved by verification — capture the imperfect session as a personal benchmark case via `yk pbench`.
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

1. Run `yk pbench capture --source codex --yes` from the subject Git repository. If capturing an older or non-current session, pass `--input <jsonl>` or `--session-id <id>`; capture uses the session cwd and Git baseline when Codex recorded them.
2. Read the printed transaction path, case directory, and `initialValidation` warnings.
   - Read `private/authoring-checklist.md` first for the generated capture-quality summary.
   - Treat empty prompt, empty command observations, or missing failure evidence warnings as capture-quality gaps to fix before finalizing.
3. Edit the transaction `case/` bundle:
   - read `public/replay.md` and `public/context.manifest.json` to understand the replay capsule;
   - keep all future agent-visible task input inside `public/`; use `public/key-observations.md` for filtered failure/verification evidence and `public/command-observations.md` only as supporting context;
   - refine `public/prompt.md`, `public/context.md`, `public/environment.md`, `public/replay.md`, and public context files as the future agent-visible task input;
   - review generated `private/failure.md`, `private/success.md`, and `private/verification.md` against `private/failure-draft.md` and the raw session transcript;
   - fix generated private docs only when the session evidence is missing, ambiguous, or incomplete;
   - keep generated command validators only when their captured cwd was normalized to the replay repository; unsafe cwd warnings mean the validator must be authored manually;
   - if `private/validators/check-completion.mjs` says `PBENCH_AUTHORING_REQUIRED`, implement the validator from the correction evidence and private transcript;
   - if strict validation needs live services or secrets, record the required environment variable names in `replayRequirements.requiredEnv` and on the validator instead of putting secret values in docs;
   - ask the user for clarification only when the captured session does not identify the failure or does not imply an observable completion check.
4. Run `yk pbench validate --transaction <tx-path> --strict` until it passes.
5. Run `yk pbench finalize --transaction <tx-path>`.

Never expose `private/` contents to a future benchmarked agent. Use `yk pbench export-replay --case <case-dir-or-case-id> --out <dir>` when preparing replay input for an agent; the export contains only sanitized `public/` files plus `case.public.json`. Replay startup fails closed if agent-visible pbench inputs expose `/private`, `private/...`, `PB_PRIVATE_DIR`, `PB_CASE_DIR`, raw transcript paths, validator paths, or the original case directory.

## Replay Flow

Use finalized cases through the harness when comparing agents, models, rules, or skills:

- For Codex CLI automation, run `yk pbench run --case <case-id-or-dir> --agent codex --profile <comparison-label>`.
- For agents that cannot be launched by CLI, run `yk pbench start --case <case-id-or-dir> --profile <comparison-label>`, open the printed `<workspace>/.personal-bench/replays/<run-id>/worktree` with that agent, and let the installed `pbench-runner` skill trigger the one-shot `yk pbench finish --run <run-id>` validation.
- Use stable profile labels such as `baseline`, `current-model`, `current-skills`, or `new-harness` when comparing model, skill, rules, or harness changes.
- Use `yk pbench audit` before a comparison pass when you want a quick quality check across finalized cases.
- After runs finish, use `yk pbench report --profile <comparison-label>` or `yk pbench report --format markdown` to summarize status, manual-intervention, duration, token, case, and recent-run results. For debugging an individual run, inspect the run summary plus `runner-environment.json`, `agent.diff`, and `candidate/untracked.json` in the artifact directory.

Do not give a benchmarked agent the full case bundle. The runner prepares `.pbench/public/`, `.pbench/case.public.json`, and `.pbench/run.json` as the agent-visible surface inside the workspace-owned replay worktree, then runs private validators outside the public replay capsule.
