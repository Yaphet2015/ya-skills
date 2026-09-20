# Computer execution architecture

This change keeps the public computer-use and computer-e2e commands and suite
interfaces. It consolidates the owners of action execution, request completion,
worker resources, and test results.

## Ownership

| Module | Owns |
| --- | --- |
| Runtime step executor | One action, its precondition, native delivery classification |
| Runtime request executor | Ordered steps, durable receipts, remaining steps, final observation |
| Runtime execution scope | Absolute deadline, cancellation propagation, timer/listener disposal |
| Runtime request ledger | Request claim, event sequence, live outcome cache, unresolved requests |
| Session ledger | Atomic hosted exec result and JSON state commit, historical verification |
| Worker lifecycle | Internal invocation, process groups, spool reads and cleanup |
| E2E result reducer | Case and step results derived from events |

The host retains session admission, target ownership and its responsive control
socket. The native driver stays in a separate process. E2E keeps its local
predicate-based Computer interface; script exec keeps its serializable RPC
interface. Both use shared execution and worker implementations where their
contracts agree.

## Ordering constraints

- Persist an action start before dispatch. Persist its result before starting
  the next action. Recheck the absolute budget after persistence.
- Select a legacy-driver adapter before dispatch. An error or missing reply
  never triggers another attempt through a different mutation interface.
- Cancellation closes admission. It does not prove native work stopped.
  Outstanding native work and surviving process groups keep the session unusable.
- Check final evidence and result size before committing script state. Unknown
  delivery and cancellation prevent a commit. A failed final observation can
  still leave verified script state committed; `stateCommitted` is independent
  of the presentation status.
- Reap the worker group before the final spool drain. A leader exit alone is
  insufficient because a descendant can still write to fd3.
- The E2E supervisor remains the sole writer of public `events.jsonl`. Reports
  continue to come from those events, using the same case/step rules as live
  suite results.

## Hosted exec storage

New state commits install a versioned immutable transaction under the session's
`state/transactions/` directory. One record contains the request identity/hash,
terminal result, and next JSON state version. This is the commit point.

`state.json` and historical state snapshots are compatibility projections.
Recovery can use the committed record when a process stopped before writing a
projection. Transaction lookup precedes legacy journal claims and live caches,
including when the entire legacy request directory is missing. A failed journal
projection cannot replace a verified committed result with an unknown outcome.
Existing corrupt snapshots are rejected rather than silently
replaced. Legacy state files and request journals remain readable.

The transaction does not make native input atomic with local storage. A crash
after native dispatch but before a durable outcome can still be `unknown`; that
request must not be replayed.

## Baseline and verification

The baseline is the working tree at the start of this implementation, including
its pre-existing uncommitted changes. The four implementation directories had
14,219 lines. The baseline gates passed: typecheck, 718 tests passed / 17 skipped,
and build.

Source measurement, excluding tests, declarations and generated artifacts:

```sh
rg --files packages/computer-runtime/src packages/computer-session/src \
  packages/functions-computer-use/src packages/functions-computer-e2e/src \
  -g '*.ts' -g '!*.d.ts' | xargs wc -l
```

The baseline file snapshot for local comparison is
`/tmp/yk-architecture-baseline.ABPTrE/packages`.

The final implementation has 15,304 lines: 1,085 more than the baseline (+7.6%).
The shared execution paths remove duplicate owners, but the new transaction
format, compatibility recovery, and validation add code. This implementation
does not meet the earlier 40% source-reduction target.

Verification includes typecheck, the complete desktop-free test suite, build,
smoke, and the official release packaging script. The final full run passed
750 tests, skipped 11, and failed none. The separate required packaged gate
passed all 13 tests. The packaged tests cover
compiled self-spawn, pure E2E suites, exec RPC, duplicate requests, and symlinked
executables without Node or Bun on PATH. No native desktop acceptance run or
publication was performed.

The packaged check caught a process cleanup race: an already-exited worker could
settle before its grace timer was created, keeping the E2E parent alive for
15 seconds. Cleanup now returns before arming a timer after settlement. The
original packaged tests pass with their unchanged five-second test timeout.
