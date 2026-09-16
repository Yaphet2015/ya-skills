# 原生验收续测 — 2026-09-16

状态：后台坐标输入已取得 SDK 与打包产品路径的成功证据。原生取消发现的结果误分类已在 `b096bfd` 修复并通过无桌面/打包门禁；锁屏使修复后的实机复跑暂未完成。完整原生验收尚未通过。

基线是本地分支 `computer-use/takeover-20260916` 的 `0cbaffd`。本轮最初的打包二进制来自已通过前轮门禁的产品提交 `82b1f49`，Bun 1.3.14、SDK 0.27.0。下面的“修复前”证据不能当作最终修复版的验收结果。

## 运行边界

只操作自建 AppKit 测试窗口。未调用 activate、set frontmost、makeKeyAndOrderFront、SDK Foreground 或全局鼠标/键盘输入。没有在后台失败后使用前台重试。

前一版 nonactivating NSPanel 在画布点击后收到一个非测试脚本发出的 keyDown。前台 PID 没变仍不足以证明键盘焦点未被占用。发现后立即关闭窗口和 session，保留 [当时状态](evidence/2026-09-16-native/matrix/final-before-stop.json)。后续改用 `canBecomeKey == false`、`canBecomeMain == false` 的窗口，逐步记录这两个标志和键盘事件计数。

本轮用户正常切换前台应用，部分长生命周期 fixture 的 activationChanges 非空。仅将点击前后前台一致、fixture 始终未激活且不是 key/main window 的单步作为相应成功证据；不把它写成“整个长生命周期前台从未变化”。有前台变化的步骤单独标为受污染。

## 已取得的证据

| 项目 | 结果与证据 |
|---|---|
| 从未激活窗口的 SDK Background 坐标点击 | 成功。按钮 0→1，窗口创建至记录结束 frontmost 始终 1383、activationChanges 为空。[before](evidence/2026-09-16-native/raw-before.json)、[SDK result](evidence/2026-09-16-native/raw-click.json)、[after](evidence/2026-09-16-native/raw-after.json)。此早期 fixture 尚未记录 key-window 标志，因此不扩展为键盘焦点验收。 |
| 打包 session/exec 的无 AX canvas 坐标点击 | 成功。AX 中仅有窗口、按钮、文本框，画布没有 AX 元素。1040×664 原图缩至 520×332，图上 (410,180) 经产品映射后命中画布，计数 1→2。该步骤 frontmost 1383 不变，key/main window 均 false。[完整结果](evidence/2026-09-16-native/matrix-nonkey/canvas-exec-second.json)。 |
| 相同 requestId 不重复输入 | 成功。返回原有 completed/stateVersion=1，画布计数仍为 2。[重放请求结果](evidence/2026-09-16-native/matrix-nonkey/replay.json)。 |
| 成功 mutation 后旧 observation 失效 | 成功。旧 observation 返回 unknown_observation / invalidated，步骤为 not_delivered，画布计数不变。[结果](evidence/2026-09-16-native/matrix-nonkey/consumed.json)。 |
| 窗口移动后拒绝旧坐标 | 成功。仅由 fixture 自己从 (80,100) 移到 (140,140)，旧观察返回 stale_observation，计数不变。[结果](evidence/2026-09-16-native/matrix-nonkey/moved-stale.json)。 |
| 移动后重新观察并点击 | 成功。新观察对应新窗口位置，画布 2→3，frontmost 不变，key/main window 均 false。[结果](evidence/2026-09-16-native/matrix-nonkey/moved-fresh.json)。 |
| 60 秒 TTL | 成功。实际等待超过 60 秒后，旧观察在派发前返回 stale_observation / older than 60s，计数不变。[结果](evidence/2026-09-16-native/matrix-nonkey/ttl-expired.json)。 |
| 2x Retina 与非零窗口原点 | 成功。真实显示屏为 2x，1040×664 像素对应 520×332 点；原点移动前后都验证了产品输入。[观察](evidence/2026-09-16-native/matrix-nonkey/before-move.json)。 |
| 1x/2x 图像尺度 | 已测 2x 原图→1x 发送图的真实坐标点击。物理 1x 显示屏未测（当前两个屏幕均为 2x）；无桌面的 1x/2x/非整数映射用例由默认门禁覆盖，不把缩图冒充物理屏幕。 |
| AX 按钮点击 | 按钮计数 0→1，delivery 为 delivered；但该步骤前台发生外部变化，不能算前台不变验收。[受污染记录](evidence/2026-09-16-native/matrix-nonkey/ax-button.json)。 |
| AX 表单输入 | 未通过。禁止成为 key window 的 fixture 文本框点击被 SDK 拒绝，没有继续 typing。[结果](evidence/2026-09-16-native/matrix-nonkey/field-click.json)。 |
| Source / compiled 授权检查 | doctor 均报告 AX 与录屏权限为 true。[source](evidence/2026-09-16-native/source-doctor.json)、[compiled](evidence/2026-09-16-native/compiled-doctor.json)。真实打包 host/driver 已完成上述截图与输入；该证据只适用于本轮进程责任链，不推导其他安装路径或签名主体。 |
| 正常 session 清理 | closed、driverTerminated=true、leaseReleased=true、unresolvedRequests=[]。[结果](evidence/2026-09-16-native/matrix-nonkey/close-second.json)。 |

图像证据：[1040×664 原图](evidence/2026-09-16-native/canvas-original.png)、[实际使用的 520×332 缩图](evidence/2026-09-16-native/canvas-sent.png)。

## 原生取消发现的缺陷

自有 `BlockingButton.accessibilityPerformPress()` 写入握手文件后阻塞；这证明 SDK 已进入真实 AX 动作回调。测试在握手后取消请求，第二个动作仍排队。

[修复前完整记录](evidence/2026-09-16-native/matrix-cancel/cancel-run.json)：

1. AXPress 进入：1789530765.7576。
2. cancel 控制面约 27 ms 返回。
3. 约 6.1 秒后 SDK 抛 DriverError.Tool；产品错误地将首个动作记为 not_delivered，第二个记为 not_run。
4. [session 返回 idle](evidence/2026-09-16-native/matrix-cancel/status-after.json)。
5. 放开 fixture 后按钮完成，计数变为 1。动作实际进入过应用，not_delivered 分类不成立。

根因位于 runtime `isKnownDriverRefusal()`：仅凭 Tool 异常类名，就把所有此类错误认定为输入前拒绝。修复只将明确的结构化派发前拒绝代码记为 not_delivered；无分类 Tool 错误和派发后的 AbortError 记为 unknown，并阻止会话后续派发。探针现在保留 errorCode，不再仅因捕获异常就宣称 driver-refused。实机同场景的修复后复跑仍待解锁。

## 跨命令观察目录缺陷

真实 `observe --out-dir <dir>` 保存成功后，`act --out-dir <same-dir>` 仍从默认缓存路径寻找 observation，报 ENOENT。修复让一次性会话使用请求指定的 artifactsDir。回归使用真实磁盘 ObservationStore 和两个独立命令实例，验证保存后可读取并执行坐标映射。此回归修复前 0 pass / 1 fail，失败路径为默认 observation 目录；修复后通过。自定义目录的最终原生复跑仍待解锁。

[取消请求的持久日志](evidence/2026-09-16-native/journals/7b45f071-8599-417a-a96d-a2e0eba20522/native-cancel-ax-1/events.jsonl)也保留了修复前错误的 not_delivered 结果，供复查。

## 当前外部阻塞

只读 CGSession 检查确认 `CGSSessionScreenIsLocked=1`。[锁屏记录](evidence/2026-09-16-native/lock-state.json)。SDK 同时返回 `px_capture_unavailable`，说明当前截图不可用并明确拒绝派发：[结构化错误](evidence/2026-09-16-native/matrix-cancel-allspaces/unresolved-detail.json)。未修改权限、解锁或尝试前台输入。

## 历史复现材料

本目录的 Swift/Python/TypeScript 文件记录本轮实际使用的临时 fixture 和调用方式，包含当时的绝对临时路径。它们不接入默认测试。`NativeFixture.swift` 是已发现键盘焦点问题的历史版本；不要用于新测试。新测试必须保留 NonKeyPanel 约束、显式目标、单步观察和退出清理。

## 修复门禁

产品修复提交：`b096bfd`。源码与打包测试均使用 Bun 1.3.14，版本保持 0.22.0。

| 检查 | 结果 |
|---|---|
| 两个 API reference 生成 | 24 / 31 declarations，无生成漂移 |
| typecheck | 通过 |
| 默认无桌面测试 | 637 pass / 15 skip / 0 fail，652 tests，2283 assertions |
| package:release | 通过 |
| 三文件 packaged release | 12 pass / 0 fail，72 assertions |
| build / smoke | 通过 |
| 打包后 runtime 装配 | 4 pass / 0 fail，23 assertions |
| Swift 非键盘窗口 fixture | 编译通过，无警告 |
| 后续新增 host→driver-worker→runtime 回归 | 1 pass / 15 assertions；typecheck 再次通过 |

[完整门禁日志](evidence/2026-09-16-native/gates)。默认跳过项与前轮相同，打包相关跳过项已在后续门禁补跑；未执行通用应用枚举的 native opt-in 测试。

重建后的原生 fixture 位于 [computer-use-native.swift](../../scripts/probes/fixtures/computer-use-native.swift)。它要求显式输出目录，支持 `--block-press` 的真实 AX 阻塞握手，并保持 canBecomeKey/canBecomeMain 为 false；不接入默认测试。

## 清理

本轮自有窗口和 host 已全部关闭。[精确 PID 检查](evidence/2026-09-16-native/process-cleanup.json)。用户原有交接文档保持未跟踪；main 未合入，未推送或发布。

## 修复后的跨进程回归

[computer-integration-native-action-outcome.test.ts](../../tests/computer-integration-native-action-outcome.test.ts) 使用真实 Unix socket、进程内 host、真实 driver-worker 子进程、action 通知和 worker 内的 runtime；只有 backend 是无桌面测试替身，它抛出结构化 Tool 错误。该测试没有手写 unknown 回执。

断言首个动作 unknown、第二个 not_run、实际调用次数为 type=1/key=0；相同请求返回既有结果，新请求被拒绝；host 为 unusable、lease 仍存在，journal 只有一个 unknown 终态。[独立复现输出](evidence/2026-09-16-native/ipc-structured-tool-result.json)。这证明修复跨 IPC 保持结果分类，不替代解锁后的真实 AX 取消复跑。
