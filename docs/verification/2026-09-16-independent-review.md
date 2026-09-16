# Computer-use 独立复审

最终审查基线：`/tmp/ya-computer-takeover`，HEAD `82b1f497189185c5e3d113d75204c6c41e9cd7aa`。包含 J1–J6、真实 host→driver-worker IPC 回归，以及本轮独立审查发现的 R1 清理修复。

## 结论

**本轮已确认的代码阻塞已消除；当前没有未解决的具体代码缺陷。** J1–J6 和 R1 均已核对源码与窄回归。该结论覆盖本报告审查范围，不代替整合者的全量发布门禁，也不代表完整 A/B/C 原生与模型性能验收完成。

审查者未操作桌面、未加载原生 SDK、未修改产品。下方原生证据来自整合者提交，已查阅其记录，明确与独立执行区分。

## J1–J6 结果

- J1：多块终态排空后才推断 worker exit；晚到终态不能创建新的 pending commit。240000 字节 state/value、合法终态截断前缀和 spool 缩短回归通过。
- J2：终态关闭准入；队列动作形成 not_run，已派发动作保留结果。observe 不再伪装成非法 action receipt。
- J3：持久 requestId 区分相同 JSON 内容的不同提交；取消 A、同值提交 B、再入场 C 和 no-op 回归通过。不确定所有权仍拒绝。
- J4：释放 stdio fd 后不再重复关闭；测试实际复用三个 fd，并验证替代文件仍可写。
- J5：用 own data property 克隆 JSON；worker→commit→load→下一次 exec 保留 `__proto__`。
- J6：read、projection、persist、resize、store 之后检查控制状态；host 拒绝取消后迟到成功。新增回归穿过真实 host、Unix socket、独立 driver-worker、生产 runtime 和延迟 store，确认只记录一个 interrupted 终态。派生任务保持跟踪直至回收完成，详见 R1。
- SDK 参数：对照本地 `@ubjs/core 0.31.0-3/src/async-rust-call.ts`，传入 async options 时必须有 signal。适配层仅传 `{signal}` 或 undefined，与依赖源码一致。

## R1 / P1：已修复并独立复验

初始缺陷在 `observation-store.ts` 默认 runner：超时只发 TERM 然后立即 reject，没有等待退出或升级 KILL；外层派生 Promise 超时也会丢失任务跟踪。

原始独立复现 `/tmp/ya-review-resize-child.ts` 调用生产 `resizeScreenshot` 和默认 runner，仅将 sips spawn 替换成真实合成 Bun 子进程，该进程忽略 TERM。修复前，200 ms deadline 返回后再等 100 ms，进程仍存活。复现 finally 已负责 SIGKILL/等待，无遗留进程。

`82b1f49` 改为有界 TERM→KILL，并等待退出。Node 分支等待 close；session 跟踪派生 Promise，清理失败保持 poisoned 并让 close 失败，不能释放其 target lease。

独立复验原始 Bun 脚本：

```json
{"result":"screenshot resize timed out: request deadline expired","elapsedMs":408,"childAliveAfterResult":false,"exitCode":null}
```

独立 Node 复验：先用 Bun 将当前 observation-store.ts 构建成 `/tmp/ya-review-observation-store-final.mjs`（target=node），再用 Node 执行 `/tmp/ya-review-node-resize.mjs`：

```json
{"result":"screenshot resize timed out: request deadline expired","spawned":true,"closedBeforeReturn":true,"childAliveAfterResult":false}
```

两条复现均通过。当前新增回归也确认取消会回收子进程，以及 session close 等待超时的派生任务退出。

## 独立执行证据

使用 Bun `1.3.14`；仅 desktop-free。需要 Unix socket 的命令使用已授权的 sandbox escalation。

| 阶段 / 测试组 | 结果 |
|---|---|
| 第一阶段：state-codec、host-regressions、supervisor-fd-ownership | 10 pass，0 fail，63 assertions |
| 第一阶段：exec-terminal、lane-core-lifecycle、exec-state | 36 pass，0 fail，110 assertions |
| J6 集成：observation-budget、native-observation（合成 backend）、lane-runtime-artifacts、runtime-budget | 27 pass，0 fail，63 assertions |
| 最终 82b1f49：resize-cleanup、observation-budget、host-regressions、exec-terminal、state-codec、supervisor-fd-ownership | **29 pass，0 fail，136 assertions** |

这些轮次有重复测试，不将其相加为不同测试数量。最终轮包含真实 host→IPC→独立 driver-worker 的 delayed-store 取消回归。另执行上述 Bun/Node 两条独立进程存活检查。

整合者在正常路径 clone、HEAD 82b1f49 执行最终门禁。审查者已读取 `/tmp/ya-takeover-gates/00-*.log` 至 `06-smoke.log`：Bun 1.3.14；API 24/31 declarations；typecheck；默认测试 630 pass / 15 skip / 0 fail，2225 assertions，645 tests；package:release 0.22.0；三文件 packaged tests 12 pass / 0 fail，72 assertions；build/smoke 均有成功日志。以上是整合者执行、审查者核对日志，不计入独立运行数量。

## 原生证据与验收边界

已查阅整合者 `b589560` 和当前 verification 中的记录：

- 非激活 NSPanel 的 source CLI session open→observe both→纯 JS `state.n++` exec→同 requestId 返回旧结果→close 成功；持久状态 version 仍为 1。
- close 记录 driverTerminated=true、leaseReleased=true、unresolvedRequests=[]。
- 该只读闭环记录 frontmost PID 始终 20223、activationChanges=[]、clicks=0。
- 独立只读 observe+400 缩图记录成功，并记录 frontmost PID 保持 1383。

这些支持当前运行环境下的原生只读观察、缩图、会话复用、纯 JS 状态去重和关闭。审查者没有亲自运行这些原生操作。

仍未完成：从未激活窗口的 Background Coordinates 成功；签名/TCC 归属的完整验证；真实原生输入和取消；AX 表单/无 AX canvas、Retina、移动窗口、过期坐标、unknown/中断矩阵；固定模型/prompt 的真实调用和 token usage 对比；上述真实矩阵中的无重放、无过期派发、无窗口混用和无跨请求派发验收。

**代码修复复审通过；完整 A/B/C 验收仍未完成。**
