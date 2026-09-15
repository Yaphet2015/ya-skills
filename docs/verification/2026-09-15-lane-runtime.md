# Runtime/CLI lane verification (2026-09-15)

> Lane-local handoff snapshot at checkpoint `e7c172f57b2bdb846ad388ba4961757d969bd59a`. Outside-lane notes describe pre-integration ownership; current cumulative status is in `docs/verification/2026-09-15-parallel-integration.md`.

**Scope:** This ledger covers only the runtime/CLI ownership lane. It is not a cumulative project completion claim. No desktop application, input, screenshot capture, native SDK operation, release gate, build, smoke test, or full test suite was run.

## Findings addressed

| Finding / requirement | Evidence | Status |
|---|---|---|
| F8 standalone batch deadline | `packages/functions-computer-use/src/batch-command.ts` starts one absolute deadline before journal claim/start persistence, passes it into the session, recomputes remaining time after each persisted `action_started`, and refuses final observation after expiry. `packages/computer-runtime/src/batch.ts` also refuses to start final evidence after its absolute deadline. `tests/computer-lane-runtime-batch.test.ts` injects 45ms action-start persistence latency into a 30ms batch and observes zero dispatches plus `not_run` receipts. | fixed in this lane |
| F10 close during lease/setup | `SessionImpl` reserves operation admission in `beginOp`, releases it in all operation paths, waits for admissions before cleanup, and checks `closed`/`poisoned` immediately before native dispatch. `tests/computer-lane-runtime-admission.test.ts` covers lease-wait close, late driver setup, matching `action_finished:not_delivered`, and repeated public close. | fixed in this lane |
| F12 dead-listener status/close | `session-command.ts` validates session identity, generation, target, host PID, state, socket path, and idle metadata before recovery. Status/close recover only known dead-listener errors and retain ownership; live-host listener races remain errors. | fixed in this lane |
| F15 screenshot privacy | `ensurePrivateFile` performs chmod + regular-file and mode `0600` verification. Base64 saves, copied source screenshots, observation-store paths, and existing source/derived resize paths enforce the check; failures are not swallowed. | fixed in this lane |
| Natural same-epoch freshness | `tests/computer-lane-runtime-freshness.test.ts` observes through a live fake backend, then performs same-session `clickPoint`; no hand-seeded epoch is used. | regression added |
| Session CLI timeout/max-actions | `createComputerUseCommands` accepts an injected transport only as a test seam; production routing reads the file once, applies both overrides, and sends them through `runOnSession`. `tests/computer-lane-runtime-cli.test.ts` verifies the real command routing and peer request envelope. | regression added |
| Public repeated close | The same CLI session command returns the recorded `alreadyClosed` envelope twice without contacting a removed listener; runtime close is also asserted idempotent. | regression added |
| Node unsupported runtime | `tests/computer-lane-runtime-cli.test.ts` launches Node with the production `process.ts` selector and verifies `unsupported_runtime` before spawn. | regression added |

## Commands run

- `bun install --frozen-lockfile` — passed; no lock/workspace manifest changes.
- `bun run typecheck` — passed after dependency installation.
- `bun test tests/computer-lane-runtime-*.test.ts tests/computer-runtime-budget.test.ts tests/computer-batch.test.ts tests/computer-observation-store.test.ts tests/computer-screenshot-scale.test.ts tests/computer-point-click.test.ts tests/computer-observation.test.ts tests/computer-use-batch-cli.test.ts tests/computer-use-session-cli.test.ts tests/computer-use-exec-cli.test.ts tests/computer-use.test.ts tests/computer-use-act.test.ts tests/computer-runtime.test.ts` — passed, 190 tests / 0 failures.
- `git diff --check` — passed.

## Uncovered / pending

- F1–F7, F9, F11, F13–F17 and P2 findings remain outside this lane or require host/session/E2E/release ownership; they were not silently reimplemented here.
- Native Background-coordinate/TCC behavior and real desktop freshness remain unverified by the explicit no-desktop constraint.
- Full `bun test`, `package:release`, release tests, build, and smoke were intentionally not run.
- Generated API drift and host-side state recovery remain report-only because those files are outside this lane.

## Hygiene

All lane changes are intentionally unstaged and uncommitted. No commits, merges, pushes, or publication were performed. No staged files were present at verification time.
