# Release-proof lane ledger (2026-09-15)

Status: focused I7/I8/I9 regressions only. This lane does not claim the
cumulative release gates or native desktop acceptance. The authoritative
cumulative record is [`2026-09-15-parallel-integration.md`](2026-09-15-parallel-integration.md);
mutable full-suite counts remain there rather than being duplicated here.

Baseline: integrated checkpoint `82722ea5e9ab4021b521def8dcae4cf703fe493f`.
Changes remain unstaged and uncommitted for managed capture. The original
checkout was not touched.

## I7 — packaged loop proof

- `tests/computer-session-release.test.ts` no longer treats the worker's
  pre-body `exec_started` frame as execution proof.
- The fixture script installs a TERM handler in the worker body, starts an
  owned shell descendant whose `trap '' TERM` handler is installed before it
  writes readiness, reads and verifies the descendant-reported PID, then emits
  an `exec_body_ready` frame on fd3 from the body itself.
- The test verifies both worker and descendant process-group membership,
  signals only the owned group with TERM, confirms the descendant remains
  runnable, then invokes production `stopProcessGroup` and requires SIGKILL,
  no group survivors, and no runnable descendant.
- No production fake-driver flag, global-name sweep, or desktop operation was
  added.

TDD evidence:

- Omitting the body ACK in a temporary fixture copy failed with
  `compiled loop did not acknowledge body readiness on fd3`.
- Restored body ACK fixture passed against a temporary compiled current-source
  `yk` executable; no package:release or sidecar was assembled in this lane.

## I8 — mutable verification counts

- The historical `docs/verification/2026-09-14-computer-use-agentic.md`
  pointer now links to the authoritative cumulative record and does not repeat
  mutable current test/package counts.
- A regression test fails if numeric current-section count claims reappear.

## I9 — release workflow coverage

- Both `.github/workflows/release.yml` and
  `.github/workflows/release-please.yml` run
  `tests/computer-lane-release-packaging.test.ts` in the existing
  `YK_RELEASE_TESTS=1` post-package command.
- The existing `package:release` entrypoint and gate order were preserved.
- A regression test checks both workflow commands include the packaged lane
  after `bun run package:release`.

## Focused validation

Using the pinned Bun 1.3.14 executable:

- `bun test tests/computer-integration-release-loop.test.ts tests/computer-integration-release-workflow.test.ts`
  — 5 pass, 0 fail.
- `YK_RELEASE_TESTS=1 bun test tests/computer-session-release.test.ts --test-name-pattern 'compiled exec loop'`
  — 1 pass, 0 fail, against the temporary compiled executable described above.
- `bun run typecheck` — pass.
- `git diff --check` — pass.

Full package:release, full default suite, release artifact lane, build, smoke,
and native/desktop gates remain integration-owned. No desktop app was
activated and no screenshot, input, foreground/global event, or permission
operation was performed.
