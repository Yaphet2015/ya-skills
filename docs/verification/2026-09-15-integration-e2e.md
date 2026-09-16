# Integration E2E tail/cancellation lane ledger — 2026-09-15

Base: `82722ea5e9ab4021b521def8dcae4cf703fe493f` (managed worktree only).
This lane owns only E2E supervisor/suite sources, the new integration regressions,
and this ledger. Changes remain unstaged and uncommitted.

## Review dispositions

### I2 — worker-exit spool tail: fixed in this lane

`IncrementalE2ESpoolReader.drainToEof()` continues reading at most the live
64 KiB chunk size after the worker process group is reaped. It requires two
stable empty polls, then `finalize()` checks the UTF-8/frame tail before the
reader and spool are closed/deleted. This prevents a newline-aligned tail or a
frame split across a chunk boundary from being discarded or falsely reported as
truncated. Reaping before the drain also prevents inherited fd3 descendants
from appending after the EOF check.

Coverage includes:

- production-reader bursts of four 64 KiB newline-aligned frames;
- production-reader bursts with a frame crossing the 64 KiB boundary;
- real `supervise()` worker-exit bursts larger than two chunks, with terminal
  case, cleanup step, `afterAll`, and `run_finished` evidence retained;
- no `worker_protocol_error`, false truncation, or missing cleanup events.

### I3 — E2E batch caller cancellation: fixed in this lane

The case guard now accepts the optional third `Computer.batch` signal argument,
combines it with the case-owned signal for that invocation, and removes both
listeners in `finally`. Abort listeners are one-shot. A caller signal already
aborted before dispatch returns the runtime's interrupted/not-run result; a
caller abort during the first delayed action preserves that delivered action
and prevents later actions. The skipped-case path also removes its case
propagation listener rather than retaining it until suite shutdown.

The regression enters through `runSuite` and a production
`createSessionWithBackend` runtime session backed by a private fake backend;
it does not replace `Computer.batch` with a proxy stub. It covers pre-aborted
caller cancellation, mid-first-action cancellation, no second/third dispatch
while `afterAll` runs, and caller listener cleanup.

### Other current review findings

I1 and I4–I9 were not edited in this ownership lane. No claim is made that they
are fixed here; they remain integration follow-up items as described by the
current independent review.

## Test-first and verification evidence

The new regressions were run against the pre-fix source first:

- `bun test tests/computer-integration-e2e-cancellation.test.ts` — 0 pass,
  2 fail (caller signal was ignored).
- `bun test tests/computer-integration-e2e-spool.test.ts` — 0 pass, 2 fail
  (worker-exit burst ended with a truncated tail and dropped events).

The first typecheck attempt found missing local tooling (`tsc: command not
found`). `bun install --frozen-lockfile` restored already-declared ignored
workspace dependencies; no manifest or lockfile source change was made.

Final focused run used the exact Bun 1.3.14 binary:

```text
bun test tests/computer-integration-e2e-cancellation.test.ts \
  tests/computer-integration-e2e-spool.test.ts \
  tests/computer-lane-e2e-control.test.ts \
  tests/computer-lane-e2e-supervisor.test.ts \
  tests/computer-e2e-suite.test.ts \
  tests/computer-e2e-supervisor.test.ts
51 pass, 0 fail, 186 expects
bun run typecheck
PASS
 git diff --check
PASS
```

No desktop application, screenshot, activation, foreground/global input,
native SDK, release gate, build, or smoke test was run. No process-wide cleanup
or global PID/name sweep was used; all fixtures use private temporary roots and
owned child workers.

## Changed files

- `packages/functions-computer-e2e/src/supervisor.ts`
- `packages/functions-computer-e2e/src/suite.ts`
- `tests/computer-integration-e2e-cancellation.test.ts`
- `tests/computer-integration-e2e-spool.test.ts`
- `tests/helpers/integration-e2e-burst.ts`
- `tests/helpers/integration-e2e-runtime.ts`
- `tests/helpers/integration-e2e-spool.ts`
- `docs/verification/2026-09-15-integration-e2e.md`

## Residual risk / next step

Spool evidence remains conservative if a worker group cannot be reaped or if a
frame is genuinely malformed; such runs are not reported as successful. Native
computer-use acceptance, release gates, and the other independent review
findings remain outside this lane. The integration owner should review this
unstaged delta and run the project-level gates after all lanes are captured.
