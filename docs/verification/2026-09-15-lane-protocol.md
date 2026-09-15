# Protocol lane verification ledger (2026-09-15)

> Lane-local handoff snapshot at checkpoint `e7c172f57b2bdb846ad388ba4961757d969bd59a`. Outside-lane notes describe pre-integration ownership; current cumulative status is in `docs/verification/2026-09-15-parallel-integration.md`.

Scope is limited to the session protocol/client/script-computer seam and the
lane-owned protocol tests. No desktop, SDK, foreground input, global input, or
release gate was run.

## F13 — targeted window-id restoration

**Status: fixed in the owned protocol seam.**

- Removed the recursive `windowId` property rewrite. `decodeSessionReply`
  dispatches to the declared observe, batch, or exec result schema.
- Only `Observation.target.windowId` (including observations nested in a
  `BatchResult` or `ExecResult`) is restored from a decimal wire string to a
  runtime `bigint`.
- `SessionInfo.target.windowId` is validated and retained as its declared
  decimal string by `decodeControlReply`.
- `ExecResult.value` and optional result metadata are validated as JSON but are
  not traversed for id-like property names. String values such as
  `{windowId:"draft"}` and numeric values such as `{windowId:123}` remain
  unchanged.
- The compatibility `deepRestoreWindowIds` seam used by the existing exec
  worker recognizes only complete observation/batch/exec result shapes;
  unrelated objects are returned without recursive rewriting.

Evidence: `tests/computer-session-protocol.test.ts`,
`tests/computer-lane-protocol-schema.test.ts`, and
`tests/computer-lane-protocol-roundtrip.test.ts` cover large bigint target ids,
Chinese text, nested arbitrary return values, metadata, control info, and
malformed/incomplete targets.

## P2 — deep wire-shape validation

**Status: implemented for the owned decoders.**

- Requests validate operation discriminators, observe options, selectors,
  conditions, scroll specs, point-click coordinates/UUIDs, batch budgets, and
  finite/safe numeric fields before reaching the host operation path. Exec
  empty/code-budget policy remains the host's existing `normalizeExecOptions`
  business response so invalid-code callers retain their structured reply.
- Observations validate all required identity/timing/title fields, channel
  enums, complete AX elements, receipt-compatible geometry, finite dimensions,
  and image metadata. Incomplete observations are rejected rather than
  accepted as typed values.
- Batch results validate status, every receipt's index/kind/status/error, and
  optional final observation/error.
- Exec results validate status, state counters, commit metadata, bounded
  receipts/observations, UTF-8 log byte budget, finite JSON return values, and
  nested observation shapes. Optional forward-compatible result metadata is
  retained without id rewriting.
- Control replies validate `SessionInfo`, session states, target identity, and
  idle budget. Generic reply decoding remains envelope-only and does not guess
  where a target may be embedded.
- `FrameReader` retains streaming fatal UTF-8 decoding and per-frame 1 MiB
  accounting; direct line decoders also enforce the byte cap.

## Commands and evidence

- `bun install --frozen-lockfile` — passed; installed missing local TypeScript/Bun
  dev dependencies without a lock/workspace-manifest diff.
- `bun test tests/computer-session-protocol.test.ts` — passed, 15 tests.
- `bun test tests/computer-lane-protocol-schema.test.ts tests/computer-lane-protocol-roundtrip.test.ts tests/computer-session-protocol.test.ts` — passed, 23 tests.
- `bun test tests/computer-exec-worker.test.ts tests/computer-exec-state.test.ts` — passed, 22 tests.
- `bun test tests/computer-session-host.test.ts tests/computer-use-session-cli.test.ts` — passed, 24 tests.
- `bun test tests/computer-use-batch-cli.test.ts tests/computer-use.test.ts` — passed, 57 tests.
- `bun run typecheck` — passed (`tsc --noEmit`).
- `git diff --check` — passed.

## Uncovered gaps / interface assumptions

- `exec-worker.ts` remains unowned; its existing one-argument compatibility
  call is supported by the schema-aware `deepRestoreWindowIds` implementation.
  No sibling host/worker contract was changed.
- The protocol retains the host's existing business-level empty/oversized exec
  code errors instead of converting them into transport decode failures.
- No generated API files were changed; no baseline API-generation drift was
  introduced by this lane.
- Native/background/TCC behavior, process lifecycle/recovery, desktop fixtures,
  release packaging, and full project gates remain outside this lane and were
  not independently verified.
- Working tree changes remain unstaged and uncommitted for managed capture.
