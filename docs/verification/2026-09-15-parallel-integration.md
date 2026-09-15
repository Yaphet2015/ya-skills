# Parallel computer-use integration verification — 2026-09-15

## Verdict

- **Current code mergeability:** **mergeable as an uncommitted, desktop-free/release-tested delta from `e7c172f57b2bdb846ad388ba4961757d969bd59a`**, subject to the required reviewer gate. The exact Bun 1.3.14 sequence passed after the integration fixes below.
- **Full native acceptance:** **not complete**. No real app was activated, foreground/global input was used, screenshot/input was sent, or permission state was changed. Native Background `Coordinates` success on a never-activated fixture, session-host TCC attribution, native UI coverage, and real model/performance evidence remain open.
- **Repository safety:** the original ya-skills checkout was not touched. No commit, merge, push, release publication, or staged file was created.

This document is the current cumulative record. Lane ledgers and the earlier
`2026-09-14-computer-use-agentic.md` checkpoint text are historical/lane-local
records; their older base refs, counts, and “not run” statements are not
current cumulative evidence.

## Runtime identity and preparation

- Current branch: `pi-subagents/integrate-and-verify-b781cdb-1c00-s0-t0`
- Current HEAD remains: `e7c172f57b2bdb846ad388ba4961757d969bd59a`
- Root package version: `0.19.0`
- Host: macOS arm64 (`uname -m` = `arm64`)
- Node observed: `v24.18.0`
- Exact gate runtime: `/tmp/ya-skills-bun-1.3.14/bun-darwin-aarch64/bun`, `1.3.14`
- The preinstalled `/Users/phaethon/.bun/bin/bun` was `1.4.0`. It was not
  used as a fallback for the required gates. The exact host-arch Bun 1.3.14
  release was downloaded/extracted under `/tmp` only.
- Exact dependency repair: `/tmp/computer-use-integrated-repair-install.log`
  records `bun install --frozen-lockfile` with Bun 1.3.14; it changed only
  ignored dependency material and restored `node_modules/.bin/tsc`.

## Lane patch application

All five managed lane artifacts were deltas from the same checkpoint. Before
any patch was applied, `git apply --check` passed for each path. Each patch was
then applied exactly once, in this order, with no overlap or conflict:

| Lane | Managed patch artifact | Apply result |
|---|---|---|
| core-lifecycle | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/c2bf330f-ad0a-44f6-baf2-72718bbea5c0/task-0-worker.patch` | PASS, once |
| runtime-cli | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/4dfb440a-0a56-44f1-add5-2cc5dde6e600/task-0-worker.patch` | PASS, once |
| wire-protocol | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/a5e5ffb6-2d6d-4316-a7ba-1684854a2700/task-0-worker.patch` | PASS, once |
| e2e-control | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/f94f354d-fa3b-4a10-9ee7-aa6ef6c9521d/task-0-worker.patch` | PASS, once |
| release-benchmark | `/Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/2cc81d99-7385-4226-8ec4-313bdd2c2bab/task-0-worker.patch` | PASS, once |

The apply transcript is `/tmp/computer-use-integrated-apply.log`. The lane
handoff files read before application were `core-lifecycle-handoff.md`,
`runtime-cli-handoff.md`, `wire-protocol-handoff.md`, `e2e-control-handoff.md`,
and `release-benchmark-handoff.md` in the managed `outputs/c9ccc7bd-f979-4094-85dd-b27c000bbda0/` directory.

## Post-apply API regeneration

After all five lane deltas were applied, both generators were run again:

- `bun scripts/generate-computer-use-api.ts`
- `bun scripts/generate-computer-e2e-api.ts`

The final package gate reran both generators after the subsequent integration
fixes. Generation output reported 24 computer-use declarations and 30 E2E
declarations. The generated references are:

- `skills/computer-use/references/api.d.ts`
- `skills/computer-e2e/references/api.d.ts`

The generation transcript/checksums are in
`/tmp/computer-use-integrated-regenerate-final.log`; the final package
regeneration is in the final package gate log below. Generation tests passed in
the default suite.

## Exact gate sequence (final run, Bun 1.3.14)

The final run was restarted after every production/test fix and executed in the
required order. The `BUN` variable pointed to the exact binary above; each row's
log includes the observed Bun version and exit status.

| Order | Exact command | Result | Log |
|---:|---|---|---|
| 1 | `bun run typecheck` | **PASS**, exit 0 | `/tmp/computer-use-integrated-final2-gate-01-typecheck.log` |
| 2 | `bun run test` | **PASS**, 586 pass / 10 explicit skip / 0 fail; 596 tests, 2002 expects | `/tmp/computer-use-integrated-final2-gate-02-default-tests.log` |
| 3 | `bun run package:release --version 0.19.0` | **PASS**, both APIs regenerated; macOS arm64 package created | `/tmp/computer-use-integrated-final2-gate-03-package-release.log` |
| 4 | `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts` | **PASS**, 10 pass / 0 fail | `/tmp/computer-use-integrated-final2-gate-04-release-tests.log` |
| 5 | `bun run build` | **PASS**, `packages/cli/dist/cli.js` built | `/tmp/computer-use-integrated-final2-gate-05-build.log` |
| 6 | `bun run smoke` | **PASS**, source + Node-target help/version/list/demo checks | `/tmp/computer-use-integrated-final2-gate-06-smoke.log` |

The 10 default-test skips were explicit and not relabelled as passes: one
`YK_CU_NATIVE_TESTS=1` real-SDK/native test, seven `YK_RELEASE_TESTS=1`
computer-session release tests, and two opt-in packaged-live lane tests.
The required release command in order 4 ran its ten cases; the two additional
packaged-live tests were independently run afterward with the exact opt-in
variable (see below).

### Stopped failures and repairs

The first exact typecheck attempt failed with exit 127 because this managed
checkout had no installed `tsc`; no later gate was started. The exact Bun
`install --frozen-lockfile` repair restored declared tooling, and typecheck was
rerun successfully.

The first default-test attempt then found a real cross-lane defect: the new
schema-aware `decodeSessionReply` dropped validated `error` fields, and the
runtime lane's delayed journal test double lacked the core lane's new `list()`
method. This caused seven host assertions plus one connection cleanup error.
The fixes were:

1. retain `error` in both result-less and result-bearing business replies;
2. delegate `list()` in the delayed `RequestJournal` adapter; and
3. add a protocol regression for the error envelope.

The relevant protocol, host, and exec regressions passed, then the full default
suite was rerun successfully.

An additional opt-in packaged-live run exposed a Bun 1.3.14 startup polling
race: the client attempted a Unix-socket connection before the packaged host
had created its socket, and listeners were installed too late for Bun's
immediate `ENOENT` event. The client now constructs the `Socket`, installs all
terminal listeners, and calls `connect()` last; a missing-socket regression
covers this. The packaged live lane was rerun successfully.

A final-observation cancellation seam was also tightened during cross-boundary
review: runtime and hosted batch final evidence now returns `interrupted` on
cancellation/deadline rather than claiming completed-with-error. Runtime and
real-socket host regressions pass. Because these changes postdated an earlier
successful sequence, the six final gates above were rerun from typecheck.

## Release artifact evidence

The final package gate produced:

- `dist/release/ya-skills/yk`
- `dist/release/ya-skills/skills/`
- `dist/release/ya-skills/runtime/`
- `ya-skills-v0.19.0-macos-arm64.tar.gz`
- `ya-skills-v0.19.0-macos-arm64.tar.gz.sha256`

The tarball contains the compiled `yk`, `skills/`, and `runtime/` sidecar.
The artifact inspection transcript is
`/tmp/computer-use-integrated-artifact-inspection.log`; the package gate log is
`/tmp/computer-use-integrated-final2-gate-03-package-release.log`.

The required release files proved the packaged E2E install/run/history/report
flow and packaged session/exec pure-JS/fd3 cleanup flow. The additional live
packaged lane was run with:

`YK_RELEASE_TESTS=1 bun test tests/computer-lane-release-packaging.test.ts tests/computer-lane-release-benchmark.test.ts`

It passed **3/3** in `/tmp/computer-use-integrated-final2-packaged-lane.log`:
packaged same-request dedup through a separate injected driver process,
symlinked executable self-spawn, and the synthetic benchmark regression.
The injected driver is a test module and never loads the native SDK or touches
a desktop.

## F1–F17 disposition and cross-boundary evidence

The labels below follow the specified independent review. “Verified” means the
current code and desktop-free regression evidence are integrated; native
acceptance is separately listed as open.

| Finding | Current disposition | Current evidence |
|---|---|---|
| F1 admitted exec batch after timeout/terminal | **Verified desktop-free** | Exec inner dispatch rechecks request admission, cancellation, and absolute deadlines; delayed-first-step and unawaited inner-batch tests retain later `not_run` receipts. |
| F2 aggregate limit downgrading unknown/cleanup severity | **Verified desktop-free** | Bounded results retain `unknown`/`interrupted`, receipts, dropped-observation count, and unusable-session state; overflow plus unknown-delivery regression passes. |
| F3 failed process-group cleanup reclaimability | **Verified desktop-free** | Lease records retain worker pids/groups and `cleanupUnproven`; dead leader plus live group remains `target_busy`. |
| F4 E2E case cancellation not reaching batch | **Verified desktop-free** | `runSuite` forwards the case signal to `computer.batch`; runtime-backed fake-backend test proves later actions are not dispatched during `afterAll`. |
| F5 state recovery linkage | **Verified desktop-free** | Versioned state history, hash/intent checks, older-result recovery after later state advancement, and state-rename-before-terminal recovery pass. |
| F6 cancellation during final observation | **Verified desktop-free** | Exec keeps cancellation active through final evidence/precommit; runtime and host final-observation cancellation regressions return interrupted and do not commit. |
| F7 batch observations bypassing exec cap | **Verified desktop-free** | Explicit, batch, and final observations share one registration cap; 21 batch observations fail at 20 without silent truncation. |
| F8 split/relative deadlines | **Verified desktop-free** | Host, runtime, standalone CLI, and exec paths use one absolute deadline through journal/setup/actions/final observation; delayed persistence test proves zero late dispatch. |
| F9 incomplete exec receipts | **Verified desktop-free** | Every dispatched action gets one run-level receipt; remaining inner actions become `not_run`; mixed single/batch indices are `[0,1,2]`; separate-driver crash preserves delivered/unknown/not_run. |
| F10 close racing lease/setup | **Verified desktop-free** | Runtime reserves admission before async setup, close drains reservations, and final dispatch checks lifecycle state; lease-wait/setup-close tests pass. |
| F11 persistent opener attachment | **Verified desktop-free** | `openSession` uses ignored stdio and `unref()` after handshake; opener exits while detached host remains usable. |
| F12 dead retained listener | **Verified desktop-free** | Closed hosts remove sockets; unusable hosts remain queryable until explicit finalization; validated CLI status/close fallback handles dead listeners and malformed metadata conservatively. |
| F13 broad window-id restoration | **Verified** | Protocol decodes only declared observation targets; arbitrary exec JSON values such as `windowId:"draft"` remain unchanged; Chinese real-socket roundtrip passes. |
| F14 supervisor lock/spool unboundedness | **Verified desktop-free** | Lock acquisition is bounded/abortable and uncertain owners are preserved; incremental fd3 spool reads bounded chunks and rejects rotation, malformed UTF-8, oversized frames, and incomplete tails. |
| F15 screenshot permission enforcement | **Verified desktop-free** | Copied, pre-existing, and derived artifacts are chmod/stat verified `0600`; failure remains loud. |
| F16 packaged loop false-positive | **Verified desktop-free** | Opt-in release loop requires fd3 `exec_started`, drains the TERM-ignoring descendant, and passes only after real group cleanup; required release gate passes. |
| F17 generated API drift | **Verified** | Both generators rerun after all lane changes and package release; generation/compile tests pass and references include `stateHash`, `observationsDropped`, and the optional batch signal. |

## P2 disposition

| P2 item | Current disposition | Evidence / boundary |
|---|---|---|
| Equivalent benchmark/reused sessions/observed init counts | **Verified synthetic-only** | `bun scripts/bench/computer-use.ts --samples 10 --warmup 2` passed in `/tmp/computer-use-integrated-final2-benchmark.log`; four-action task, 10 measured + 2 warmup per variant, persistent batch/exec reuse one host/driver. Native/model/token values remain `null`/unavailable. |
| Deep wire validation | **Verified** | Full declared request/control/observation/geometry/batch/receipt/exec/JSON/budget/enums validation plus fatal UTF-8 and 1 MiB frame limits; default and protocol suites pass. |
| Unique run-level receipts | **Verified** | Mixed single/batch exec regression asserts unique `[0,1,2]` and complete statuses; release/default suites pass. |
| Incremental E2E spool | **Verified desktop-free** | `IncrementalE2ESpoolReader` retains offsets, performs bounded reads, and has rotation/truncation/partial-tail/UTF-8/size tests. |
| Consistent verification counts | **Verified for current record** | Current gates/counts/log paths are recorded here; old checkpoint documents are labelled historical and updated with current pointers. |
| Natural same-epoch freshness | **Verified desktop-free** | Same-session observation → point-click path uses production store, fresh frame, geometry, and mapping regression. |
| E2E observation → point-click | **Verified desktop-free** | Production `runSuite` and runtime fake backend exercise observation persistence, fresh lookup, and coordinate mapping. |
| Node unsupported runtime | **Verified desktop-free** | Production internal worker selector returns `unsupported_runtime` before spawning under Node. |
| Live packaged dedup | **Verified opt-in desktop-free** | Current packaged binary plus separate injected driver process pass dedup and lease/PID assertions. |
| Packaged symlink execution | **Verified opt-in desktop-free** | Current packaged symlink binary self-spawns its driver and completes a request. |

## Benchmark output (current run)

The final synthetic benchmark emitted four successful JSON rows (10 measured,
2 warmup each):

| Variant | p50 / p95 ms | observed driver initializations | observations | failures |
|---|---:|---:|---:|---:|
| single-step | 0 / 1 | 40 | 10 | 0 |
| batch | 0 / 0 | 10 | 10 | 0 |
| persistent-batch | 5 / 6 | 1 | 10 | 0 |
| exec | 64 / 186 | 1 | 10 | 0 |

These are synthetic desktop-free runtime measurements. They do not establish
native speed, model turns, token reduction, or native driver behavior. The
exec p95 outlier is retained rather than hidden.

## Remaining acceptance and plan gaps

1. **Native A1:** under an explicitly safe, user-approved test window, prove
   successful Background `Coordinates` input against a never-activated owned
   fixture while recording that the user's frontmost PID is unchanged; verify
   session-host TCC attribution. Do not use activation, Foreground, or global
   input as a substitute.
2. **Native UI matrix:** AX form, no-AX canvas, Retina/scale, window movement
   and stale coordinate rejection, interrupted native batch, and unknown native
   delivery remain unrun.
3. **Native/model performance:** run equivalent fixed-task single-step,
   one-shot batch, persistent batch, and exec samples with a fixed prompt/model;
   collect real model usage when available or retain null, and report failures
   and recovery events. Synthetic counts above are not acceptance.
4. **Release CI coverage:** the two workflows still invoke the contract-required
   `tests/computer-e2e-release.test.ts` and `tests/computer-session-release.test.ts`.
   The new packaged-live lane test is currently a manual opt-in integration
   check, not part of those workflow command lines. This is an explicit CI
   coverage gap, not a hidden completion claim.
5. **Durability boundary:** native power-loss/fsync windows and arbitrary
   scripts that intentionally escape their process group remain outside the
   tested guarantee. The product continues to document trusted local JS
   execution, not a security sandbox.

## Hygiene

The final hygiene command passed at 2026-09-15T14:35:15Z:
`/tmp/computer-use-integrated-final-hygiene-2.log` records clean
`git diff --check`, no staged files, the current branch/HEAD, and no scoped
session/driver/exec/E2E child processes. Ignored build/package output (`dist/`,
`node_modules/`, tarball) is local validation material, not a source change.
- No desktop app was activated, no input was sent, no Foreground/global route
  was used, and no user/global permission or account state was modified.
