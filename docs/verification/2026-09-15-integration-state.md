# Integration state/codec lane ledger — 2026-09-15

## Scope and baseline

- Worktree: managed isolated checkout, `/Users/phaethon/workspace/personal/worktrees/worktrees/computer-use-recovery.Qzzi3y/pi-worktree-5a52ec59-347e-48a0-be4d-092c58738cd9-0`.
- Baseline HEAD: `82722ea5e9ab4021b521def8dcae4cf703fe493f` (`wip: preserve integrated computer-use review checkpoint`).
- Only the owned computer-session seams, new integration-state tests/helper, and this lane ledger were changed. No commit, merge, push, release, generated API, shared plan, or original checkout change was made.
- No desktop app, screenshot, input, activation, foreground/global event, or permission operation was performed.

## Finding disposition

### I4 — fixed

The host now records an exec terminal `stateCommitDisposition` in the durable
`request_finished` event:

- `committed`: the returned result has a committed state and recovery verifies
  the historical version/hash and terminal result linkage;
- `abandoned`: only the runner's post-intent cancellation result
  (`interrupted`, `request_cancelled`, `stateCommitted:false`) is treated as a
  conclusive no-commit. Recovery verifies that the proposed history version did
  not land; an orphaned/corrupt history entry remains blocked;
- `uncertain`: failed commits, unknown delivery, timeout, missing terminal event,
  and malformed markers remain conservative. A matching committed historical
  snapshot may recover an uncertain crash without replay; no proof keeps the
  session blocked.

The regression uses the real socket/client, host admission, durable journal
append boundary, exec worker, state persistence, and a same-host next request.
The test callback cancels only after the underlying `state_commit_intent`
append resolves. It verifies state stays at version 0, the terminal event is
marked abandoned, the host returns to idle, and the next exec commits version 1.
A separate regression keeps an unknown intent without a commit proof blocked.

### I5 — fixed

`packages/computer-session/src/json-value.ts` is now the single producer/consumer
JSON validator. It owns plain-JSON shape checks, finite-number/cycle/sparse
array checks, byte accounting, and a shared bounded depth of 256. `exec-state`
re-exports it for the worker/commit paths, and the protocol result decoder uses
the same validator. Ordinary small values at depth 130 are preserved rather
than being accepted by the worker and rejected after commitment. Values beyond
the shared bound fail in the worker before state commit and still return a
schema-decodable failed exec result.

The real encoded request/reply regression verifies 130 nested arrays, state
version 1, persisted state depth, and arbitrary result data
`windowId:"draft"` remaining ordinary user JSON rather than being rewritten.

### I6 — investigated; blocked outside this lane

The owned host already passes its cancellation signal into `driver.call`, but
production `createRealDriverSession` drops that signal on `computer.observe`.
The runtime `Computer.observe` type has no per-call signal/deadline, and the
persistent runtime session is constructed once; its `SessionOptions.signal` and
`deadlineAt` cannot be replaced for each hosted observation. The existing
per-request deadline therefore only supplies host before/after checks and does
not prove cancellation/absolute-deadline propagation through native observation
or setup.

A real fix requires coordinated changes in unowned
`packages/computer-runtime/src/{types,session}.ts` (or an explicitly approved
runtime abstraction). Recreating the runtime session per observation would
break the persistent-driver contract, and a host-side Promise race would be
cosmetic/unsafe. No unowned runtime file was edited; this residual was sent to
the supervisor for runtime-lane coordination.

## Test-first and verification evidence

- Regression red was observed at the real seam by running the corrected state
  integration file against the unchanged baseline host: after cancellation at
  the durable intent boundary, the same-host next request returned `failed`
  instead of `completed` because recovery treated the uncommitted intent as
  corruption. The 130-depth case also reproduced the old protocol rejection.
  The baseline red log was captured at `/tmp/ya-skills-i4-red.log`.
- Initial typecheck infrastructure attempt: `bun run typecheck` exited 127
  because `node_modules/.bin/tsc` was absent. The allowed
  `bun install --frozen-lockfile` restored `typescript@5.9.3` and
  `@types/bun@1.3.14`; manifests and `bun.lock` remained unchanged.
- `bun run typecheck` — PASS (Bun 1.4.0 in this checkout).
- `bun test tests/computer-integration-state-codec.test.ts` — PASS, 4 tests,
  32 expects.
- `bun test tests/computer-integration-state-codec.test.ts tests/computer-exec-state.test.ts tests/computer-session-host.test.ts tests/computer-session-protocol.test.ts` — PASS, 51 tests, 145 expects.
- `bun test tests/computer-use-review-fixes.test.ts tests/computer-lane-core-lifecycle.test.ts tests/computer-lane-runtime-admission.test.ts tests/computer-lane-protocol-schema.test.ts` — PASS, 33 tests, 136 expects.
- Final combined focused run (`bun run typecheck && bun test tests/computer-integration-state-codec.test.ts tests/computer-exec-state.test.ts tests/computer-session-host.test.ts tests/computer-session-protocol.test.ts tests/computer-use-review-fixes.test.ts tests/computer-lane-core-lifecycle.test.ts tests/computer-lane-runtime-admission.test.ts tests/computer-lane-protocol-schema.test.ts && git diff --check`) — PASS: 85 tests, 286 expects, 0 failures; typecheck and diff check also passed. Final changes remain unstaged/uncommitted.

## Changed files

- `packages/computer-session/src/host.ts`
- `packages/computer-session/src/protocol.ts`
- `packages/computer-session/src/exec-state.ts`
- `packages/computer-session/src/json-value.ts` (new shared validator)
- `tests/computer-integration-state-codec.test.ts` (new real-socket regressions)
- `tests/helpers/integration-state-host.ts` (new durable-boundary fixture)
- `docs/verification/2026-09-15-integration-state.md` (this lane ledger)

## Residual risk / next step

I4 and I5 are desktop-free verified at the production host, persistence, worker,
and encoded-reply seams. Native deadline behavior for hosted final observation
(I6), plus all native/TCC/UI/model/performance acceptance, remains open. The
next step is for the runtime owner/supervisor to add an explicit per-operation
observe deadline/cancel seam, followed by a focused hosted-observation regression;
this lane must not implement that cross-owner change unilaterally.
