# Computer-Use Agentic Implementation Verification

Date: 2026-09-15. Recovery worktree: this allocated managed clone, base/ref `49890437c2632b746eca07ab9a35904da71facc4`. This document records independently rerun evidence after the review-fix pass. It does not claim native desktop acceptance where the no-disruption rule prevented it.

## Runtime and evidence policy

- Final gate used the pinned Bun **1.3.14** binary from `/tmp/bun-1.3.14/bun-darwin-aarch64/bun`; system Bun 1.4.0 was used only for earlier diagnosis.
- All default tests are desktop-free. One explicit default skip remains the pre-existing `YK_CU_NATIVE_TESTS=1` real-SDK/apps test; it was not forced or relabeled green.
- Real desktop input was not run in this recovery pass. Earlier probe evidence with activation/foreground input remains disclosed separately and is not used as acceptance evidence.
- No model/provider was invoked by the benchmark; token/usage fields are `null`, never inferred from bytes.

## Prescribed final gate (fresh, in order)

| Step | Exact command | Result |
|---|---|---|
| typecheck | `PATH=/tmp/bun-1.3.14/bun-darwin-aarch64:$PATH bun run typecheck` | PASS, exit 0 |
| default tests | `PATH=/tmp/bun-1.3.14/bun-darwin-aarch64:$PATH bun test` | PASS: 532 pass / 1 skip / 0 fail, 533 tests, 1,725 expects |
| package | `PATH=/tmp/bun-1.3.14/bun-darwin-aarch64:$PATH bun run package:release --version 0.19.0` | PASS; generated both API declarations and `ya-skills-v0.19.0-macos-arm64.tar.gz` |
| release tests | `PATH=/tmp/bun-1.3.14/bun-darwin-aarch64:$PATH YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts` | PASS: 10 pass / 0 fail |
| build | `PATH=/tmp/bun-1.3.14/bun-darwin-aarch64:$PATH bun run build` | PASS; `packages/cli/dist/cli.js` generated |
| smoke | `PATH=/tmp/bun-1.3.14/bun-darwin-aarch64:$PATH bun run smoke` | PASS; source and Node-target CLI help/version/list/demo checks |

The default-test run's only skip was:

1. `compiled yk native (opt-in via YK_CU_NATIVE_TESTS=1) > loads the SDK sidecar in-process from a hostile cwd and reads real apps` — real desktop/SDK gate, not run to preserve the user's foreground-PID rule.

## Review-fix coverage

The independent review's 23 findings and seven P2 findings are dispositioned in `docs/verification/2026-09-15-computer-use-review-fixes.md`. Key verified regressions include:

- app-level target lease shared by persistent host/one-shot/E2E paths; corrupt/identity-uncertain leases block rather than overwrite;
- native promise tracking after timeout, cancel/close admission sequencing, whole process-group cleanup after successful leader exit, and no unawaited exec success;
- interrupted/unknown batch reduction, single-action rejection, state/request session isolation, BigInt journal serialization, durable event ordering, and fail-closed journal errors;
- same-epoch screenshot freshness, incomplete/empty AX fallback, propagated batch budgets, pre-dispatch selector errors, explicit artifact/resize errors, and final-observation freshness;
- failure CLI envelopes retain `ExecResult` receipts, bounded separate control/log channels, per-frame UTF-8 decoding, E2E observation stores, optional-window resolution, idempotent confirmed close, and Node `unsupported_runtime` rejection;
- release invokes both API generators; benchmark runs every synthetic variant and emits measured p50/p95 plus null model usage; the visual batch example has the required `{ "actions": [...] }` shape.

Relevant tests added or updated across `tests/computer-target-lease.test.ts`, `computer-session-host.test.ts`, `computer-exec-lifecycle.test.ts`, `computer-runtime-budget.test.ts`, `computer-point-click.test.ts`, `computer-request-journal.test.ts`, `computer-session-protocol.test.ts`, `computer-use-batch-cli.test.ts`, `computer-use-session-cli.test.ts`, and helpers. E2E supervisor now uses separate numeric file descriptors for stdout/stderr and a parent-polled fd3 event spool, avoiding Bun 1.3.14's mixed-pipe event-loss failure while retaining parent-owned `events.jsonl` as SSOT.

## Benchmark evidence

`PATH=/tmp/bun-1.3.14/bun-darwin-aarch64:$PATH bun scripts/bench/computer-use.ts --samples 10 --warmup 2` is the reproducible desktop-free benchmark command. It executes single-step, one-shot batch, persistent host batch, and exec variants against synthetic fixtures; each JSON line contains `measured`, sample count in `note`, p50 `durationMs`, `p95DurationMs`, observed counts, failures/recovery events, and `modelTurns/inputTokens/outputTokens/reasoningTokens: null`. The fresh run emitted:

| variant | p50/p95 ms | driverInitializations | observations | success |
|---|---:|---:|---:|---|
| single-step | 0 / 0 | 40 | 0 | true |
| batch | 0 / 0 | 10 | 10 | true |
| session | 6 / 7 | 10 | 0 | true |
| exec | 61 / 62 | 10 | 10 | true |

These numbers are synthetic runtime measurements, not a real model-token or native-desktop comparison; no performance percentage is claimed.

## Native acceptance gaps

Still blocked and explicitly not claimed:

- Background `Coordinates` success against a never-activated owned fixture while proving the user's frontmost PID is unchanged;
- session-host TCC attribution and real driver/session/exec native closed loop;
- AX form, no-AX canvas, Retina/window movement, interrupted-native-batch, and unknown-delivery desktop matrix;
- real model usage and single-step/batch/persistent-batch/exec A/B measurements.

The earlier foreground/activation-contaminated probe evidence and the strict no-input policy are documented in `docs/verification/2026-09-14-computer-use-agentic-primitives.md`; no routine permission request or retry was made.

## Hygiene

The managed worktree remains on branch `pi-subagents/luna-continue-fixes-75094b9d-8db5-s0-t0`, ref `49890437c2632b746eca07ab9a35904da71facc4`, with changes intentionally uncommitted and unstaged. No original checkout, main branch, push, or release publication was touched.
