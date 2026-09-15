# Computer-use review-fix checkpoint ledger (2026-09-15)

**状态：CHECKPOINT，不是完成声明。** 本轮按父级要求在安全完成当前工具/测试后停止领取新修复项；没有运行全量发布门禁、没有启动真实桌面测试。工作树为 recovery clone，基线 `4989043`，当前分支 `pi-subagents/correct-r1-r17-96452ea-47c4-s0-t0`。累计补丁先通过 `git apply --check` 后应用；全部改动保持 unstaged/uncommitted。

## 本检查点新增/验证的修复

| 项 | 状态 | 代码/证据 |
|---|---|---|
| R1 host admission | 已完成（代码+回归） | `host.ts` 在首个 post-check await 前同步占用 `inFlight`；同一 socket chunk 双业务帧测试确认仅一个 batch dispatch、第二帧 `session_busy`。|
| R2 hosted batch cancellation | 已完成（代码+回归） | driver call 传播 request signal；host batch 按动作 dispatch；cancel 关闭后续准入；多动作取消测试确认只开始第一步。|
| R3 stale reclamation lock | 已完成（保守 fail-closed） | `target-lease.ts` 不再对已读死锁 owner 做 unchecked unlink；死锁 owner 需要外部清理证明；stale-lock 回归保留锁并返回 `owner_identity_unknown`。|
| R4 journal recovery loser | 已完成（代码+回归） | `request-journal.ts` recovery loser 只限时重读，绝不追加 terminal；锁持有回归确认 events 没有 `request_finished`。|
| R5 durable per-action receipts | 进行中/部分完成 | hosted batch 与 standalone batch 已改为每动作 `start → dispatch → finished`，exec batch 已改为逐动作调用并使用 run-level index；已有 durable-boundary 测试通过。仍缺独立 crash/hang-after-first-result 的真实 worker 回归和最终完整验证。|
| R6 unknown mutation delivery | 已完成（已测路径） | driver-worker 退出错误标记 unknown；exec 对 plain transport error 及 terminal 后迟到 unknown 做 run-level reconciliation；caught loss 与 late-unawaited 回归通过。|
| R7 failed exec-group cleanup | 进行中/部分完成 | exec 仅在 `stopProcessGroup().exited` 后调用 worker unregister；失败保留 PID/lease并将结果 unknown。尚未注入可验证的 survivor/failure fixture 做端到端回归。|
| R8 state commit truth/linkage | 进行中/部分完成 | state file 增加 hash 校验；exec 先写 `state_commit_intent` journal event，再 commit；final observation timeout 不再把已提交状态改报为 false；persisted-state + intent 回归通过。尚未完成独立 crash recovery consistency 回归。|
| R9 final observation capacity | 已完成（回归） | 20 个 observation 后发生 mutation 时显式 `observation_limit`，不静默丢 fresh final frame。|
| R10 aggregate exec result budget | 已完成（exec 路径回归） | terminal result 使用 envelope-aware aggregate byte budget；超限保留 bounded action receipts、`observationsDropped` 和 `result_limit`，不会 commit；多份 individually-valid 大 observation 回归通过。|
| R11 late dispatch/budget routing | 进行中/部分完成 | runtime 在 lease/invalidation/setup waits 后、native dispatch 前重检 deadline/cancel；session CLI batch 分支应用 timeout/max-actions override。runtime delayed-lease 回归通过；尚缺真实 session CLI override integration 回归。|
| R12 standalone opener lifecycle | 未开始 | 尚未修正 `openSession` 的 detached stdio/unref，也未做 opener-exits/host-usable 回归。|
| R13 dead unusable listener metadata recovery | 未开始 | 尚未修正 public status/close 对 retained dead socket 的 fallback。|
| R14 schema-local windowId restoration | 未开始 | 当前 broad decoder 行为尚未改；任意 exec return `{windowId: ...}` 的 wire 回归尚未加入。|
| R15 E2E lock bounded/abortable | 未开始 | supervisor lock 仍需 bounded、abortable、missing/corrupt owner 的显式错误及回归。|
| R16 screenshot permissions | 未开始 | copied/derived screenshot 尚未统一 chmod+stat verify 0600；existing path failure regression 尚未加入。|
| R17 packaged loop fd3 gate | 未开始 | release loop 测试仍需显式 fd3 `exec_started` acknowledgement、达到 loop 后再 TERM/KILL，并严格 `YK_RELEASE_TESTS=1` gate。|

## P2 / remaining acceptance status

| 项 | 状态 | 说明 |
|---|---|---|
| benchmark equivalent operations/reused sessions/observed init counts | 未开始 | 尚未改 benchmark；当前 patch 中的静态计数/单请求 session variant 不作为证据。|
| deep wire validation | 未开始 | `decodeSessionReply` 仍需 schema-local deep validation；当前 shallow checks 不作为完成证据。|
| unique run-level receipt indexes | 进行中/部分完成 | exec batch mapping 已改为 `base + stepIndex`，single receipt remap 已改；尚未加 mixed single/batch public regression。|
| bounded incremental E2E spool | 未开始 | supervisor 仍使用 growing-file whole read；尚未改为 bounded `readSync` offset polling。|
| consistent verification counts/docs | 未开始 | 本检查点仅改 ledger；初始累计 patch 的乐观 release/verification claims 不可信，待后续按实际 gates重写。|
| natural same-epoch freshness | 进行中/测试修正未完成 | 当前 same-epoch test 仍需改成 session 内自然 `observe → clickPoint`，不使用伪造不同 epoch seed。|
| E2E observe → point-click fake backend | 未开始 | 尚未新增真实 runtime fake-backend + `runSuite` closed-loop regression。|
| actual Node unsupported_runtime CLI | 未开始 | 尚未运行 Node child through production internal-worker entrypoint。|
| live packaged dedup | 未开始 | release dedup 当前是 unknown-session refusal，不是 live packaged host request dedup。|
| packaged symlink executable | 未开始 | 尚未加入 symlink executable release case。|
| native Background/TCC/frontmost matrix | 明确阻塞/未运行 | 依用户绝对 non-disruption 规则，本 checkpoint 不启动桌面、不 activate、不使用 Foreground/global input；仅保留已有污染披露。|
| Bun 1.3.14 full release gates | 未运行 | 用户明确要求本 checkpoint 不启动全量发布门禁。|

## 本检查点改动文件

除累计 patch 原有文件外，本轮实际继续写入/修改：

- `packages/computer-session/src/host.ts`
- `packages/computer-session/src/driver-worker.ts`
- `packages/computer-session/src/exec-runner.ts`
- `packages/computer-session/src/exec-state.ts`
- `packages/computer-session/src/exec-types.ts`
- `packages/computer-session/src/index.ts`
- `packages/computer-runtime/src/types.ts`
- `packages/computer-runtime/src/session.ts`
- `packages/computer-runtime/src/target-lease.ts`
- `packages/computer-runtime/src/request-journal.ts`
- `packages/functions-computer-use/src/batch-command.ts`
- `packages/functions-computer-use/src/commands.ts`
- `tests/helpers/session-worker.ts`
- `tests/computer-use-batch-cli.test.ts`
- `tests/computer-session-host.test.ts`
- `tests/computer-use-review-fixes.test.ts`（新增）
- `docs/verification/2026-09-15-computer-use-review-fixes.md`

累计 patch 的其余 modified/untracked 文件仍全部保留，未 reset、未 stash、未 commit。

## 精确已运行命令与结果

- `git apply --check /Users/phaethon/.bangboo/agent/sessions/--Users-phaethon-workspace-personal-ya-skills--/subagent-artifacts/worktree-diffs/75094b9d-3a9c-4b2a-954b-e26db847ef48/task-0-worker.patch` — PASS。
- `git apply <task-0-worker.patch` — PASS；仅报告 patch EOF whitespace warning。
- `bun install --frozen-lockfile` — PASS（Bun 1.4.0，安装 workspace TypeScript/Bun types）。
- `bun run typecheck` — PASS（最近一次 checkpoint 前运行）。
- `bun test tests/computer-use-review-fixes.test.ts --test-name-pattern 'two business|cancelling|stale reclamation|recovery-lock loser'` — PASS，4 tests / 0 failures。
- `bun test tests/computer-use-review-fixes.test.ts --test-name-pattern 'exec state, output, and delivery'` — PASS，5 tests / 0 failures。
- `bun test tests/computer-use-review-fixes.test.ts --test-name-pattern 'lease wait'` — PASS，1 test / 0 failures。
- `bun test tests/computer-use-review-fixes.test.ts --test-name-pattern 'durably'` — PASS，1 test / 0 failures。
- `bun test tests/computer-use-batch-cli.test.ts` — PASS，16 tests / 0 failures。
- `bun test tests/computer-exec-state.test.ts tests/computer-batch.test.ts tests/computer-runtime-budget.test.ts` — PASS，52 tests / 0 failures。
- `bun test tests/computer-session-host.test.ts --test-name-pattern 'cancel closes|batch replies|unknown-delivery'` — PASS，3 tests / 0 failures。
- `git diff --check` — PASS。
- process cleanup probe `ps -axo ... | grep ...` — no matching leftover worker processes。

曾在修复前运行的 `bun test` 基线为 521 pass / 13 skip / 0 fail；它不是本 checkpoint 的 final gate。没有运行 `bun test` 全量、`package:release`、release tests、build、smoke 或任何 desktop/native command。

## 强耦合边界（供父级后续按文件所有权分批）

- `packages/computer-session/src/host.ts` 同时持有 admission state (`inFlight`/`activeRequestId`)、target lease、journal sequence/terminal persistence、driver process handle、exec state directory 和 socket protocol；R1/R2/R5/R6/R7/R8/R13 修改都可能互相影响。host 的 hosted-batch per-action loop 与 `exec-runner.ts` 的 `driverCall`/journal callbacks 是关键 seam。
- `packages/computer-session/src/exec-runner.ts` 同时负责 worker lifecycle、RPC serialization、action receipts、unknown-delivery reconciliation、final observation、aggregate wire budget、state commit ordering；R5/R6/R7/R8/R9/R10/P2 receipt index 强耦合，不能按独立函数盲改。
- `packages/computer-runtime/src/session.ts` 同时负责 lazy native initialization、native promise tracking/poisoning、lease admission、observation invalidation、batch deadline/cancellation、action outcome classification 和 cleanup lease release；R2/R6/R11/R16 依赖此边界。
- `packages/computer-session/src/driver-worker.ts` 与 runtime `Computer.batch(..., signal?)`、host subprocess driver protocol 共同定义 cancellation semantics；修改 worker wire 必须同步 fake driver fixtures、compiled release fd protocol。
- `request-journal.ts` event union、host journal callback、recovery reader和文档/事件 reducers 共享 sequence SSOT；R4/R5/R8/P2 verification 依赖同一 event schema。

## Hygiene / handoff

- 当前 worktree 无 staged files；所有 `M`/`??` 均是累计 unstaged patch。
- 未创建 commit、未 merge、未 push、未发布；未触碰原始 ya-skills main checkout。
- 后续父级可按上述耦合边界拆分 R12–R17/P2；本 worker 在该 checkpoint 停止领取新修复项。
