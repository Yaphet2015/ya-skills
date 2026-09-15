# Release / benchmark lane ledger (2026-09-15)

> Lane-local handoff snapshot at checkpoint `e7c172f57b2bdb846ad388ba4961757d969bd59a`. Its outside-lane notes describe pre-integration ownership, not the current cumulative status; see `docs/verification/2026-09-15-parallel-integration.md`.

Status: focused lane evidence only. This ledger does not claim the cumulative release gates or native desktop acceptance.

Baseline: `e7c172f57b2bdb846ad388ba4961757d969bd59a` (`pi-subagents/release-benchmark-2cc81d9-dba7-s0-t0`). The original checkout was not touched. Changes remain unstaged and uncommitted for managed capture.

## Assigned finding evidence

### F16 — packaged loop startup and cleanup gate

- `tests/computer-session-release.test.ts` now runs only when `YK_RELEASE_TESTS=1`; artifacts are not an implicit opt-in.
- The compiled loop is spawned as a detached process group with fd3 allocated as the control pipe. The test drains fd3 and requires an `exec_started` frame before any timeout/termination action. A startup exit without that frame rejects the test; a nonzero startup exit cannot be interpreted as a timeout pass.
- The loop starts an owned `/bin/sh` descendant that ignores TERM. `stopProcessGroup` sends TERM and escalates to KILL for the exact worker process group. The assertion requires `exited === true`, `groupSurvivors === null`, and no `exec_done` terminal-success frame. Cleanup also runs when startup acknowledgement fails.
- The opt-in packaged cases were not run in this lane because no `dist/release/ya-skills/yk` artifact was present and the user required the integrator to run package/release gates.

### F17 — generated API references

- Regenerated `skills/computer-use/references/api.d.ts` and `skills/computer-e2e/references/api.d.ts` from the current checkpoint sources.
- The computer-use reference now includes `ExecResult.stateHash` and `ExecResult.observationsDropped`.
- The computer-e2e reference now includes the current optional `Computer.batch(..., signal?: AbortSignal)` parameter and its source comment.
- Both byte-identity and `skipLibCheck=false` generation fixtures pass.

### P2 benchmark evidence

- `scripts/bench/computer-use.ts` now drives one shared four-action task (click, type, Return, wait) in all variants; `EXEC_CODE` includes the wait action.
- The persistent-batch and exec variants create one real in-process session host for the measured phase and send multiple unique request IDs through that same host/driver. The fake driver increments an initialization counter at construction and reports it through the host diagnostics control path; counts are not hardcoded.
- Measured samples include failed durations, explicit measured and warmup sample/failure counts, p50/p95 for both measured and warmup durations, and recovery-event text for failed samples.
- Model turns, native timing availability, and input/output/reasoning token usage are explicitly unavailable (`null`/`false`). The benchmark note identifies the result as synthetic desktop-free runtime evidence, not native speed or token proof.
- `tests/computer-lane-release-benchmark.test.ts` checks all four variants, equivalent sample counts, observed initialization counts (12 single-step, 3 batch, 1 persistent-batch, 1 exec for its 3-sample run), and unavailable-data markers.

### Packaged live-session coverage

- `tests/computer-lane-release-packaging.test.ts` adds two opt-in cases using an actual packaged `yk` host process and a separate dynamically loaded fake driver process. The fake module is written into a unique private temporary directory and records its own PID/calls; no production fake-driver flag is added.
- The first case sends the same live batch request twice and asserts one fake-driver action call, one initialization PID, a live host lease containing that worker PID, and a real host/driver PID split.
- The second case invokes the packaged binary through a symlink and completes a live batch through its self-spawned driver worker.
- These release cases remain skipped until package:release has produced the expected macOS arm64 artifact.

## Commands run

- `bun install --frozen-lockfile` — pass; no tracked lock/workspace manifest changes.
- `bun scripts/generate-computer-use-api.ts` — pass.
- `bun scripts/generate-computer-e2e-api.ts` — pass.
- `bun run typecheck` — pass.
- `bun test tests/computer-api-generation.test.ts tests/computer-use-api-generation.test.ts tests/computer-lane-release-benchmark.test.ts` — pass: 8 tests, 94 expects.
- `bun test tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts` — release-only cases skipped: 0 pass, 9 skip, 0 fail (no `YK_RELEASE_TESTS=1`).
- `bun scripts/bench/computer-use.ts --samples 3 --warmup 1` — pass; emitted four JSON rows with measured p50/p95, failure counters, observed fixture init counts, and null model/token fields.
- `git diff --check` — pass.

## Explicitly unrun / uncovered

- `package:release`, `YK_RELEASE_TESTS=1` packaged loop/live-session tests, full test suite, build, smoke, and all release workflow gates were not run in this lane.
- No desktop app, native SDK, foreground/global input, screenshot, or model/provider was used. Background/TCC, Retina, AX/canvas, real model-token usage, and native timing remain unverified.
- The benchmark's fake-driver initialization counts measure the synthetic fixture/session boundary only; they do not prove native driver initialization or performance.
- The cumulative checkpoint's other review findings and generated files outside this lane remain integration-owned. The integrator should rerun both generators after sibling changes, then run the prescribed release sequence and report any resulting drift.
- The existing workflow release-test lists may need integration-owned wiring to include `tests/computer-lane-release-packaging.test.ts`; this lane did not edit workflow files.
