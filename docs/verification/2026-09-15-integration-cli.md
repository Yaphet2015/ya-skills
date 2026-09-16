# CLI boundary lane verification — 2026-09-15

## Scope

This lane addresses only independent review findings I1 and I6 from the
current review artifact. The original checkout was not touched. No commit,
merge, push, release, desktop application, screenshot, input, activation,
Foreground route, or global event was used.

## Fixes

- **I1 — strict session request envelope:** `runOnSession` now constructs a
  clean `SessionOperation` (`observe` with only its options, or `batch` with
  only its validated request). CLI file paths and dedup IDs remain outside the
  operation, in the request envelope / local orchestration. Session `act`
  forwards its real socket transport and therefore uses the same strict codec.
- **I6 — standalone final observation:** `batchCommand` classifies
  `command_timeout`, `aborted`, and `request_cancelled` during final
  observation as `interrupted`, retains already-delivered receipts, and
  rechecks the absolute deadline after a successful observation. The journal
  terminal status and returned result status are asserted together.
- The existing runtime `SessionOptions.deadlineAt` path already bounds
  standalone native observation through `SessionImpl.read`/`ensureReady`; no
  protocol, host, driver-worker, or public runtime API change was required.

## Regression evidence

`tests/computer-integration-cli-boundaries.test.ts` uses a real Unix-socket
peer and production `sendRequest`/`encodeRequest`/`decodeRequest` for both
public session batch and session act routing. It also exercises the production
journal-backed standalone command seam for timeout, cancellation, and a
successful observation resolving after the absolute deadline.

`tests/helpers/integration-cli-peer.ts` is test-only infrastructure and records
strictly decoded request envelopes; it does not stub `sendRequest`.

## Commands run

- `bun install --frozen-lockfile` — passed; manifests and lockfile unchanged.
- `bun test tests/computer-integration-cli-boundaries.test.ts` — passed,
  5 tests / 35 expects.
- `bun run typecheck` — passed.
- Focused desktop-free regression set:
  `bun test tests/computer-integration-cli-boundaries.test.ts tests/computer-lane-runtime-cli.test.ts tests/computer-lane-runtime-batch.test.ts tests/computer-use-batch-cli.test.ts tests/computer-use-session-cli.test.ts tests/computer-runtime-budget.test.ts tests/computer-batch.test.ts`
  — passed, 73 tests / 203 expects.

The first focused run used the installed Bun 1.4.0 in this worktree. The
same focused tests and typecheck were then rerun with the required
`/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64/bun` (Bun 1.3.14), with the
same 73-test/203-expect pass result. The prior integrated release gates were
not rerun per lane scope.

## Residual risk

- Native observation, Background Coordinates, TCC, and real UI acceptance were
  not run under the no-disruption rule.
- I2–I5 and I7–I9 remain outside this lane and are not claimed fixed here.
- The standalone command has no new public cancellation API; existing runtime
  deadline/signal facilities are used and cancellation-shaped runtime errors
  are classified conservatively at the final-observation boundary.

All lane deltas remain unstaged and uncommitted for managed capture.
