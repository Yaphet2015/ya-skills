# PBench

PBench captures real Codex or Claude failures as private Harbor tasks. Jobs and artifacts stay in the local workspace. Model calls use the provider you select. Running a task requires `uv`, Python 3.12 (installed through uv if needed), Docker and Docker Compose. PBench uses Harbor 0.25.0.

## Capture and run

```sh
yk pbench capture --source codex --session-id SESSION --yes
yk pbench validate --case CASE --fail run:KNOWN_FAILURE --pass run:KNOWN_SUCCESS
yk pbench run --case CASE --agent codex --model openai/MODEL --attempts 5 --profile baseline
yk pbench report --case CASE --format json
```

Capture writes the original request, repository baseline and private session evidence into the workspace. Supply `--task DIR` to start with an existing Harbor task template. Leave `environment/source` empty for the captured repository. Otherwise, edit the generated `harbor/` directory. Declare outputs in `task.toml` and write the checks in `tests/test.sh`. Its `tests/Dockerfile` builds a separate verifier image that includes `/tests/test.sh`. Write a numeric `reward` and individual criteria to `/logs/verifier/reward.json`.

If the repo had uncommitted changes, choose `--baseline-only` when the recorded commit is the start state. For a curated start, edit `harbor/environment/source` using the private capture evidence and set `replayStart.status` to `curated` in `case.json`. Finish the setup and verifier before running `yk pbench finalize --case CASE` to save the Docker images. Capture saves them automatically when the task is ready. If a case or verifier changes, save the new revision before running it.

Versions are separate in reports. Compare the same task revision across profiles. Use `--skill DIR` to snapshot a local skill for one profile. Repository rules and the task MCP configuration are part of the task revision. To pass credentials or other environment settings, supply existing variable names with `--env NAME,NAME`. Active Codex and Claude credential variables are selected by name automatically.

## Validate the verifier

Use samples that you already know are correct or incorrect. `validate --strict` runs a no-op attempt and, if present, `solution/solve.sh`. Set either side explicitly with `--fail` or `--pass`.

| Sample | How it is reused |
| --- | --- |
| `run:TRIAL_ID` | Regrade the saved artifacts of a PBench trial for this case. Copy the trial ID from the report. |
| `trial:/path/to/trial` | Regrade a local Harbor trial directory containing `result.json` and the required artifacts. |
| `git:COMMIT` | Apply the recorded Git diff from the case baseline to that commit in a fresh sandbox. The environment must provide Git and put the repo at `/app`. |
| `nop` / `oracle` | Grade the starting state or run the task's private reference solution. |

Regrading saved artifacts does not run the original agent. A transcript supports authoring. If it contains no actual output, supply a trial or commit that does. A verified case has a valid `0` for the failure sample and a valid `1` for the success sample. Missing samples and execution errors leave the verifier pending. The saved case can still be used to collect trial artifacts.

Use `yk pbench audit` to inspect all cases or `yk pbench export-replay --case CASE --out DIR` to export an agent's task instruction. Older workspace links continue to resolve. Worktree-based manual replay has been retired.

[Harbor task reference](https://docs.harborframework.com/tasks/overview) · [Vercel agent evals](https://vercel.com/blog/agent-evals)
