# Parallel computer-use integration verification — 2026-09-15

## Current disposition

- **Source integration:** the four current lane deltas are applied once to
  checkpoint `82722ea5e9ab4021b521def8dcae4cf703fe493f`; the worktree remains
  uncommitted and unstaged.
- **Desktop-free/release gates:** pass in the final sequence recorded below
  under Bun 1.3.14.
- **Native/model acceptance:** **not verified**. No application was activated,
  no screenshot or input was sent, no Foreground/global route was used, and no
  permission state was changed. Native Background `Coordinates` behavior,
  TCC attribution, the real UI matrix, and model/token performance remain
  separate open acceptance work.
- **Repository safety:** the original ya-skills checkout was not touched. No
  commit, merge, push, release publication, or staged file was created.

This document is the cumulative SSOT for the current worktree. Lane ledgers and
older verification files retain lane-local or historical statements and must
not override this record.

## Runtime and preparation

- Branch: `pi-subagents/integrate-and-verify-74e900d-c4df-s0-t0`
- HEAD: `82722ea5e9ab4021b521def8dcae4cf703fe493f`
- Root version: `0.19.0`
- Host: macOS arm64 (`uname -m` = `arm64`)
- Node observed: `v24.18.0` (used only for the existing Node-target smoke
  checks; not a fallback for Bun gates)
- Required gate runtime:
  `/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64/bun`, Bun `1.3.14`
- `bun install --frozen-lockfile` restored already-declared ignored tooling
  (`typescript@5.9.3`, `@types/bun@1.3.14`); manifests and `bun.lock` stayed
  unchanged. Log: `/tmp/computer-use-integration-install.log`.

## Exact current lane deltas

Before application, all four paths passed `git apply --check` while HEAD was
exactly `82722ea5e9ab4021b521def8dcae4cf703fe493f`. Each was then applied once,
in this order; no historical patch was used:

| Lane | Exact patch artifact | Apply |
|---|---|---|
| state/codec | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/5a52ec59-347e-48a0-be4d-092c58738cd9/task-0-worker.patch` | pass, once |
| CLI boundaries | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/faf92a63-3a31-4d26-a83f-13f250f35db4/task-0-worker.patch` | pass, once |
| E2E tail/cancel | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/962674d7-6963-49f0-86a0-05768a1fa2fc/task-0-worker.patch` | pass, once |
| release proof | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/18f9ce2a-2a06-4364-b7fc-d78f652d40f5/task-0-worker.patch` | pass, once |

## Cross-lane fixes made after application

### I1 — real codec CLI paths: fixed

`runOnSession` now builds a strict `SessionOperation` instead of forwarding
CLI-only `file`/request metadata into the wire operation. Session `act` uses
the configured real transport. The integration regression uses a real Unix
socket and production `encodeRequest`/`decodeSessionReply` for session batch
and act.

### I2 — E2E EOF drain: fixed

`IncrementalE2ESpoolReader` drains after process-group reaping in bounded
64 KiB polls, requires two stable empty polls, and only then finalizes/deletes
the spool. Newline-aligned and frame-crossing bursts retain all case,
cleanup, `afterAll`, and `run_finished` events. Numeric-fd cleanup tolerates an
already-closed Bun descriptor without hiding unrelated close errors.

### I3 — E2E caller signal: fixed

The case guard accepts the optional caller signal, combines it with the
case-owned signal for that invocation, and removes both listeners in `finally`.
Pre-aborted and mid-first-action cancellation tests use `runSuite` with the
production runtime session and a private fake backend; later actions and
`afterAll` dispatch are blocked.

### I4 — abandoned versus unknown intent recovery: fixed

The host records `stateCommitDisposition` in durable `request_finished` events.
Only the runner's post-intent cancellation result (`interrupted`,
`request_cancelled`, `stateCommitted:false`) is an explicit abandoned commit;
failed/unknown/missing/malformed outcomes remain crash-uncertain. Recovery
verifies the proposed history version did not land before admitting the next
request. The real-socket same-host sequence and an unknown-intent fail-closed
case pass.

### I5 — producer/decoder constraints before commit: fixed

`packages/computer-session/src/json-value.ts` is the shared producer/consumer
validator for finite plain JSON, cycles, sparse arrays, byte budget, and depth
256. The worker, host precommit path, durable state commit, and protocol result
decoder use compatible validation. State shape is also required to be a plain
JSON object before a commit. Depth-130 encoded results survive commitment;
depth-257 values fail before commit with a decodable failure.

### I6 — observation deadline propagation and standalone classification: fixed

Standalone final observation now returns `interrupted` for timeout/cancellation
and rechecks the absolute deadline after a successful native result. Persistent
host observe calls carry an operation-local `ObserveCallOptions` signal and
absolute deadline through host → driver worker → `Computer.observe` → backend;
setup/native observation waits are bounded and cancellation reaches the runtime
seam without rebuilding the driver. The Cua SDK surface itself has no documented
per-call cancellation parameter, so physical interruption inside an already
executing native FFI call remains unverified and is not claimed as native
success. The desktop-free signal/deadline regression passes.

The exec runner also uses a private incrementally polled fd3 control spool to
avoid Bun 1.3.14's concurrent fourth-pipe setup race. Accepted RPCs are drained
when an `exec_unawaited` terminal frame shares a poll with the worker exit;
queued/in-flight calls settle before terminal publication, while later inner
batch actions remain `not_run`.

### I7 — packaged inside-body descendant readiness: fixed

The opt-in compiled loop test requires an `exec_body_ready` fd3 frame emitted
from the actual script body after an owned TERM-ignoring descendant reports its
PID. Worker and descendant process groups are checked, TERM is sent only to
the owned group, survival is asserted, and production `stopProcessGroup` must
escalate to SIGKILL with no runnable descendant and no `exec_done`.

### I8 — verification counts/pointers: fixed

The historical 2026-09-14 verification file and all current plan headers point
to this SSOT without duplicating mutable current counts. Current source and
plan references use checkpoint `82722ea5e9ab4021b521def8dcae4cf703fe493f` and
four current deltas.

### I9 — both release-CI commands: fixed

Both `.github/workflows/release.yml` and
`.github/workflows/release-please.yml` run
`tests/computer-lane-release-packaging.test.ts` in the strict post-package
`YK_RELEASE_TESTS=1` command, after the existing `package:release` step. The
workflow regression checks both file contents and ordering.

## Final required gate sequence

The final sequence was rerun after source, test, plan, and verification edits.
Every command used the pinned Bun directory via `PATH`; the sequence stopped
on failures during earlier attempts, fixes were applied, and the sequence was
restarted from typecheck. Final logs:

| Order | Exact command | Result | Log |
|---:|---|---|---|
| 1 | `PATH=/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64:$PATH bun run typecheck` | **PASS**, exit 0 | `/tmp/computer-use-integration-final10-gate-01-typecheck.log` |
| 2 | `PATH=/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64:$PATH bun run test` | **PASS**, 608 pass / 10 explicit skip / 0 fail; 618 tests, 2,136 expects | `/tmp/computer-use-integration-final10-gate-02-default-tests.log` |
| 3 | `PATH=/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64:$PATH bun run package:release --version 0.19.0` | **PASS**, both APIs regenerated and macOS arm64 release assembled | `/tmp/computer-use-integration-final10-gate-03-package-release.log` |
| 4 | `PATH=/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64:$PATH YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts` | **PASS**, 12 pass / 0 fail | `/tmp/computer-use-integration-final10-gate-04-release-tests.log` |
| 5 | `PATH=/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64:$PATH bun run build` | **PASS**, `packages/cli/dist/cli.js` built | `/tmp/computer-use-integration-final10-gate-05-build.log` |
| 6 | `PATH=/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64:$PATH bun run smoke` | **PASS**, source and Node-target help/version/list/demo checks | `/tmp/computer-use-integration-final10-gate-06-smoke.log` |

The 10 default-test skips were explicit, not relabelled as passes: one
real-SDK/native `YK_CU_NATIVE_TESTS=1` test, seven packaged computer-session
tests, and two opt-in packaged-live lane tests. The packaged E2E and package
assembly tests were runnable because the prior package artifact was present;
the required release command in order 4 independently ran all 12 cases,
including the packaged-live lane.

## API references and release artifacts

After the final source changes, both generators were run and package:release ran
them again:

- `bun scripts/generate-computer-use-api.ts` → 24 declarations
- `bun scripts/generate-computer-e2e-api.ts` → 31 declarations
- `skills/computer-use/references/api.d.ts`
- `skills/computer-e2e/references/api.d.ts`

Generation log: `/tmp/computer-use-integration-final-regenerate.log`.
The package gate produced and inspected:

- `dist/release/ya-skills/yk`
- `dist/release/ya-skills/skills/`
- `dist/release/ya-skills/runtime/`
- `ya-skills-v0.19.0-macos-arm64.tar.gz`
- `ya-skills-v0.19.0-macos-arm64.tar.gz.sha256`

The tarball contains the compiled binary, `skills/`, and `runtime/` sidecar.

## Stopped failures and red/green evidence

The following failures were observed and fixed rather than hidden:

- Initial local typecheck lacked `tsc`; frozen install restored declared ignored
  tooling. Install log: `/tmp/computer-use-integration-install.log`.
- First full default run exposed the request deadline timer incorrectly
  overriding exec's `execution_timeout`; the timer was limited to direct
  observe requests, then the failed exec lifecycle/review tests passed.
- Bun 1.3.14 E2E numeric-fd cleanup exposed `EBADF` after spool close; parent
  stdio copies are closed before reader creation and cleanup is idempotent.
- Concurrent exec-worker pipe setup produced `ENOENT`; the private fd3 spool,
  serialized setup, same-poll RPC drain, and bounded queue settling fixed the
  race. Earlier logs are `/tmp/computer-use-integration-final2-gate-02-default-tests.log`,
  `/tmp/computer-use-integration-final3-gate-02-default-tests.log`, and
  `/tmp/computer-use-integration-final7-gate-02-default-tests.log`.
- The red tests for all four current lane findings passed after their
  production fixes; the final default/release runs are the authoritative green
  evidence above.

## Disposition summary

| Finding/area | Current disposition | Boundary |
|---|---|---|
| I1–I5, I7–I9 | **fixed and desktop-free verified** | Native UI behavior is separate. |
| I6 signal/deadline seam | **fixed at host/runtime/backend interface and desktop-free verified** | SDK physical in-flight cancellation and native timing are unverified. |
| JSON/state recovery | **fixed and encoded precommit paths verified** | Power-loss/fsync windows remain outside tests. |
| E2E SSOT/spool | **fixed and process-backed desktop-free verified** | Malformed/uncertain workers remain fail-closed. |
| Release packaging/CI | **fixed; package and 12-case command pass** | Native session/driver use is not exercised by fake packaged fixtures. |
| Benchmark | **synthetic-only** | No model/provider was invoked; token/usage fields remain unknown/null. |

## Remaining precise acceptance work

1. Under an explicitly safe, user-approved test window, prove Background
   `Coordinates` input against a never-activated owned fixture while recording
   unchanged frontmost PID and session-host TCC attribution. Do not substitute
   activation, Foreground, or global input.
2. Run the native UI matrix: AX form, no-AX canvas, Retina/scale, window
   movement and stale-coordinate rejection, interrupted native batch, and
   unknown native delivery.
3. Run equivalent fixed-task single-step, one-shot batch, persistent batch, and
   exec measurements with a fixed prompt/model. Record real model usage when
   available or retain explicit null/unknown values; synthetic figures above
   are not acceptance.
4. Native power-loss/fsync boundaries and arbitrary scripts that intentionally
   escape their process group remain outside the trusted local JS guarantee.

## Final hygiene

The final hygiene check must report `git diff --check` clean, HEAD unchanged at
`82722ea5e9ab4021b521def8dcae4cf703fe493f`, no staged files, no native apps or
input, and no surviving scoped session/driver/exec/E2E children. Ignored
`node_modules/`, `dist/`, and release tarball output are validation material,
not source changes.
