# Bankai execution contract

Bankai is the explicit execution interface. Stage reads the same engine records for `current` or `all`; no argument means `all`. Project entry and ordinary conversation never launch or resume Bankai. Runtime state lives under the registered clones' parent `.fleet/` directory.

The idempotent registration/installation command is `scripts/cowork_install.py --root CENTRAL_ROOT --repo EXACT_ROOT ...`. It previews by default. `--apply` keeps the skill packages under `CENTRAL_ROOT/skills`, creates discovery links only in each registered clone's `.agents/skills` and `.logoscode/skills`, and excludes those links through that clone's `.git/info/exclude`. It adds no tracked instructions and installs no user-level skills. An unchanged entry block from the earlier installer is removed during migration; other `AGENTS.md` content is preserved. `--uninstall` removes owned local links and exclude entries while preserving execution history.

## Catalog and local registration

`yk install bankai` installs the complete execution skill without catalog dependencies. `yk install stage` installs the read-only entry and its Bankai dependency. Fleet's overview is part of `/stage all`, so no separate Fleet package is needed.

Skill installation does not register clones or launch tasks. To enable discovery only in selected local clones, run the bundled installer from a catalog or installed skill directory containing `bankai` and, optionally, its sibling `stage` package:

```text
python3 -B <bankai>/scripts/cowork_install.py --root <clones-parent>/.fleet --repo <clone-1> --repo <clone-2>
```

List every intended clone with a separate `--repo`. All must share the same declared project and Git origin. Inspect the preview, then repeat with `--apply`. The default runtime root is the clone parent's `.fleet`; a different location requires `--root` on helper commands. Runtime manifests, ownership records, logs, backups and run history stay local and are not catalog assets. For compatibility, execution records remain under `.fleet/ultra-produce/`; this directory name is a storage format, not a skill dependency. Existing runs retain their frozen helpers. New runs freeze Bankai and all of its scripts, so recovery needs no Ultra Produce installation.

## Commands

Use `python3 -B <bankai>/scripts/pipeline.py cowork`. Global options precede the command: `--repo`, optional `--root`, `--session`, `--run`, `--token`, and repeated `--skill-root`. `status current|all` never writes workflow state. Mutation commands require the actual session ID, selected run ID, writer token, and the run's frozen helper.

```text
... cowork --repo REPO status current
... cowork --repo REPO --session SESSION start --invocation bankai --contract CONTRACT
... cowork --repo REPO --session SESSION --run RUN continue --invocation bankai
... cowork --repo REPO --session SESSION --run RUN --token TOKEN next
```

Start returns the run ID, token and frozen helper path. Switch to that helper for every subsequent mutation. `next` prepares the next eligible engine task and returns its attempt directory. It does not execute source edits or invoke models itself; the agent executes the task, then calls `next` again after delivery. This loop supplies automatic progression within an active Bankai invocation.

For delegation, use `next --defer-bind`, create the actual host agent with that task path, then `bind-step --step ID --agent ACTUAL_ID`. This binds the engine attempt to the real executor and registers it as an outstanding writer. Use the host completion notification and a terminal observation to remove it with `writer --id ACTUAL_ID --state ended --observation FILE`. Do not declare independent review by recording the coordinator as its own reviewer.

## Contract

Write the contract to an allowed temporary path before launch. Scope and delivery authorization must come from the actual user request. A minimal change contract has implementation and verification; include a plan task and independent review when the scope requires them. Use actual acceptance conditions, not a target test count.

```json
{
  "goal": "Cap the prompt at 10000 characters",
  "source": "The current user request or a session message reference",
  "acceptance": ["Input cannot exceed the requested limit"],
  "delivery": {"commit": false, "push": false, "mr": false},
  "steps": [
    {"id": "implement", "phase": "implement", "role": "builder", "unit": "prompt",
     "criteria": ["Limit and counter behave correctly"], "skills": ["simplify"]},
    {"id": "verify", "phase": "verify", "role": "verifier", "after": ["implement"],
     "criteria": ["Input cannot exceed the requested limit"],
     "checks": [{"id": "typecheck", "argv": ["pnpm", "typecheck"]}]}
  ]
}
```

Required skills are resolved transitively from the actual contract. Their hashes are pinned. `revise --contract FILE --reason TEXT` preserves previous contracts and dependency pins; started tasks stay immutable, so changed work uses a new step ID. At most three repair revisions are allowed. Stop earlier when consecutive attempts add no diagnostic evidence. Do not use a revision to broaden delivery authorization without a new sourced task.

When a fix invalidates an accepted verification step, append a replacement verification with `"supersedes": ["earlier-step-id"]`. It must preserve the earlier verification role and cover all earlier criteria. Only an accepted replacement supersedes earlier freshness requirements; both receipts remain in history. A test-only step cannot replace an independent review.

## Delivery and checks

`check --id ID -- COMMAND ARG...` executes a command without a shell, records its output and exit code, and compares its inputs before and after. Declared checks must match the contract argv. A completed check ID cannot silently execute again. For changed inputs or interrupted checks, first reconcile the old action, then use a new ID in a revised step.

Checks also record executable identities, selected environment hashes, installed dependency metadata and the native build stamp. Declare additional ignored files in each check's `inputs` array and relevant variable names in its `environment` array. Values are hashed rather than copied into receipts. Changing these inputs makes the check stale even when tracked source is unchanged.

Write evidence files under the returned attempt's `artifacts/` or the run's reports directory. Build a result using the current `status current` input snapshot:

```json
{
  "status": "completed",
  "summary": "Observed behavior and relevant results",
  "inputs": {"head": "...", "status": "...", "fingerprint": "...", "content": "..."},
  "coverage": {"The step criterion": ["/absolute/run/tasks/step/attempt-0001/artifacts/evidence.md"]},
  "artifacts": ["/absolute/run/tasks/step/attempt-0001/artifacts/evidence.md"],
  "findings": []
}
```

Publish a full handoff describing the goal, decisions, source references, completed facts, original user changes, known side effects, pending work and recovery instructions. `deliver --step ID --result FILE --handoff FILE` uses the original engine checkpoint, collection and acceptance mechanisms. Artifact existence is not semantic acceptance: the responsible agent must verify that coverage and findings reflect the actual requirement.

Review receipts may include findings with `id`, `required`, `status` and `reason`. Required findings need a verified closed resolution before completion. Append repair and re-review steps through `revise`; preserve original findings and their resolution evidence.

Use `checkpoint --step ID --summary TEXT --next TEXT --handoff FILE [--evidence FILE]` for unfinished work. `release` relinquishes the claim after registered writers stop. A new session uses explicit Bankai continuation, restores handoff and evidence, and gets a new attempt for interrupted work. Never infer previous termination from idle status or elapsed time.

When the user pauses an active task, checkpoint it and use `release --reason paused`; Stage reports the pause. A normal handover reports that explicit continuation is needed. Neither state resumes without an explicit Bankai continuation request.

`finish --result FILE` requires all steps accepted, current verification inputs, no unfinished actions, closed required findings, and final coverage of every run acceptance criterion. Final coverage uses the same criterion-to-evidence array shape. Finish releases ownership. Git hooks remain mandatory; a successful push alone does not satisfy completion.

## Side effects and ownership

Before each batch of edits, command launches, Git operations and delegation, validate the current token using `next` or the relevant guarded command. Register delegated writer IDs with `writer --id ID --state active`; remove one only with a terminal host observation. The owner cannot release while registered writers remain.

Before an externally executed side effect, call `begin-action --id ID --kind edit|commit|push|mr|dispatch --expected FILE`. The JSON expectation for a commit includes exact `parent` and `tree`; push includes `remote`, full branch `ref` and expected `commit`. Delivery actions must be authorized by the current task. The helper records intent, not permission beyond that task.

After execution, or after interruption, use `reconcile-action --id ID [--proof FILE]`. Commit and push reconciliation checks Git outcomes directly. Other external results require proof containing `source`, matching `expected`, and artifact `evidence` paths. An interrupted check is rerunnable only after its process is confirmed stopped. Unknown outcomes are blockers; never blindly replay an external action.

When changing owners, `continue --invocation bankai --observation FILE` requires a fresh host observation if the prior owner has not released. Its schema is:

```json
{"source": "Host lifecycle tool and observation reference", "observed_at": 1792980000,
 "evidence": ["Actual host result reference"],
 "writers": {"previous-session-id": "ended", "worker-id": "completed"}}
```

The observation must cover every recorded writer, be at most 120 seconds old, and use terminal states. Obtain it from actual host tools; a model guess is not a lifecycle observation. A local process requires PID plus its start identity. User-session operation lookup may not work from another session, so retain actual session identities and outcome evidence. Writer fencing coordinates cooperating agents; it does not isolate arbitrary filesystem writers.
