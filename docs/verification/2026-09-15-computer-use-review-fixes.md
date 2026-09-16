# Computer-use review-fix ledger (current integration, 2026-09-15)

**Status: desktop-free/release integration verified; native acceptance still open.**
The authoritative current record is `docs/verification/2026-09-15-parallel-integration.md`.
This ledger supersedes the earlier checkpoint wording in this file. The current
worktree is checkpoint `82722ea5e9ab4021b521def8dcae4cf703fe493f` plus four
current lane deltas and narrow integration fixes. No commit, merge, push, or
publication was performed.

## Current R1–R17 dispositions

“Verified” below means independently exercised in the current desktop-free
integration run. It does not mean native macOS/TCC acceptance.

| Item | Current disposition | Evidence |
|---|---|---|
| R1 host admission | **Verified** | Synchronous host reservation before the first await; same-chunk two-request regression passes. |
| R2 hosted cancellation | **Verified** | Driver signals and per-action host dispatch pass; cancellation during final observation now returns `interrupted` rather than completed. |
| R3 stale reclamation lock | **Verified fail-closed** | Unproven stale reclaim ownership is preserved and reported as `owner_identity_unknown`; no unchecked unlink. |
| R4 journal recovery loser | **Verified** | Only the recovery winner appends `request_finished`; loser rereads or fails explicitly. |
| R5 durable per-action receipts | **Verified desktop-free** | Hosted/standalone/exec boundaries persist action start/finish; mixed receipt and subprocess crash fixtures retain `delivered`/`unknown`/`not_run`. |
| R6 unknown mutation delivery | **Verified desktop-free** | Driver loss, late unawaited delivery, and unknown batch paths remain unknown and are not replayed. |
| R7 failed exec-group cleanup | **Verified desktop-free** | Unresolved worker groups and cleanup poison are retained; dead leader plus live group blocks target reclamation. |
| R8 state commit truth/linkage | **Verified desktop-free** | Hashes, historical snapshots, commit intents, final-observation cancellation, and pre-admission recovery validation pass. Native power-loss/fsync evidence remains open. |
| R9 observation capacity | **Verified** | Explicit, batch, and final observations share the bounded registration path; the 21-observation regression fails closed at 20. |
| R10 aggregate result budget | **Verified desktop-free** | Oversized results retain bounded receipts and lifecycle severity, preserve unknown/interrupted, report dropped observations, and do not commit state. |
| R11 deadlines/admission | **Verified desktop-free** | Absolute deadlines span journal/setup/action/final evidence; runtime close reservations and final dispatch guards pass. |
| R12 standalone opener | **Verified desktop-free** | Opener exits after the status handshake while the detached host remains usable. |
| R13 dead listener recovery | **Verified desktop-free** | Validated metadata fallback reports retained unusable ownership; malformed metadata and live-host races fail closed. |
| R14 window-ID restoration | **Verified** | Decoder restores IDs only at declared observation target locations; arbitrary exec JSON `windowId` values remain unchanged. |
| R15 E2E supervisor lock/spool | **Verified desktop-free** | Lock wait is bounded/abortable and uncertain owners are preserved; fd3 spool polling is incremental, bounded, UTF-8-fatal, and tail-aware. |
| R16 screenshot privacy | **Verified desktop-free** | Copied, existing, and derived screenshot artifacts are chmod/stat verified as `0600`; failures remain loud. |
| R17 packaged loop/gate | **Verified desktop-free** | Required opt-in release loop passes with fd3 `exec_started` acknowledgement and TERM/KILL cleanup; no startup failure is accepted as timeout success. |

## Current P2 dispositions

| Item | Current disposition | Evidence / remaining boundary |
|---|---|---|
| Equivalent benchmark, reused sessions, observed initialization | **Verified synthetic-only** | Ten measured/two warmup samples use the same four-action task; persistent batch/exec reuse one host/driver and counts are instrumented. Native/model/token usage is intentionally unavailable. |
| Deep wire validation | **Verified** | Request, control, observation, geometry, batch, receipts, exec, JSON, budgets, enums, UTF-8, and 1 MiB framing are schema-validated. |
| Unique run-level receipt indexes | **Verified** | Mixed single/batch exec regression asserts `[0,1,2]` and complete statuses. |
| Incremental E2E spool | **Verified** | `IncrementalE2ESpoolReader` retains offsets, reads bounded chunks, detects rotation/truncation, and rejects malformed/partial frames. |
| Consistent verification counts/docs | **Verified for current record** | Current counts and command logs are in `parallel-integration.md`; older checkpoint/benchmark statements are explicitly labelled historical. |
| Natural same-epoch freshness | **Verified desktop-free** | Same-session observe → point-click freshness regression passes using the production observation store and geometry path. |
| E2E observe → point-click closed loop | **Verified desktop-free** | Production `runSuite` + runtime fake backend + observation persistence/mapping regression passes. |
| Node unsupported-runtime boundary | **Verified desktop-free** | Node invoking the internal worker selector receives `unsupported_runtime` before spawn. |
| Live packaged dedup | **Verified opt-in desktop-free** | Packaged binary and separate injected fake-driver process pass same-request dedup and lease/PID assertions. |
| Packaged symlink executable | **Verified opt-in desktop-free** | Symlinked packaged executable self-spawns its driver worker and completes a request. |
| Native Background/TCC/frontmost matrix | **Open / blocked** | No real app, input, activation, foreground/global input, or permission mutation was performed under the non-disruption rule. |

## Current integration-only repairs

- Added `list()` to the delayed `RequestJournal` test adapter because the core
  recovery lane made that method part of the shared interface.
- Preserved validated business-reply `error` fields in both result-bearing and
  result-less `decodeSessionReply` paths. This restored `session_busy`, stale
  generation, invalid-code, conflict, and unknown-delivery envelopes.
- Constructed the client `Socket`, installed all terminal listeners, and only
  then called `connect()`. Bun 1.3.14 can emit an immediate missing-socket
  error while the packaged host is booting; the client now makes that polling
  failure catchable. A missing-socket regression covers this seam.
- Classified cancellation during runtime/host final observation as
  `interrupted`, while preserving ordinary final-observation failures as
  completed-with-error evidence. Added runtime and real-socket host regressions.
- Added an operation-local observe signal/deadline context that survives the
  persistent driver worker boundary and is enforced before/through native
  observation setup; direct observations now have a finite host budget.
- Switched the exec worker's parent control channel to a private incrementally
  polled fd3 spool, drained accepted RPCs during same-poll worker exits, and
  made numeric-fd cleanup idempotent for Bun 1.3.14.

## Remaining precise plan gaps

1. Strict native A1 acceptance remains pending: prove successful Background
   `Coordinates` input against a never-activated owned fixture while proving
   the user's frontmost PID is unchanged; verify session-host TCC attribution.
2. The native UI matrix remains pending: AX search form, no-AX canvas, Retina,
   window movement/expired coordinates, and interrupted/unknown native delivery.
3. Real model/provider usage and a fixed-prompt A/B comparison remain pending;
   synthetic runtime timings and initialization counts must not be presented as
   native or token evidence.
4. The required native/model acceptance remains open; the two release
   workflows now also run `tests/computer-lane-release-packaging.test.ts` after
   `package:release`, and the final integration gate executes that same lane.

The implementation is mergeable as the current desktop-free/release-tested
code delta, subject to independent review. It is **not** fully accepted as a
native desktop/model performance delivery until the open items above are
performed under an explicitly safe test window.

## Historical checkpoint note

The previous version of this file described base `4989043`, unrun release
commands, and several open R/P2 items. Those statements were true for that
checkpoint only and are retained conceptually in the lane handoffs; they must
not be read as current results.
