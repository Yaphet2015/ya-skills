# 原生验收续测 — 2026-09-16

状态：后台坐标矩阵及修复后的原生取消／控制面闭环已通过。完整原生验收仍未通过：禁止成为 key window 的表单中，SDK Background type 返回 unverifiable / delivery_failed，独立复查文本为空；未使用其建议的 Foreground 重试。

基线是本地分支 `computer-use/takeover-20260916` 的 `0cbaffd`。本轮最初的打包二进制来自已通过前轮门禁的产品提交 `82b1f49`，Bun 1.3.14、SDK 0.27.0。下面的“修复前”证据不能当作最终修复版的验收结果。

## 最后复测（产品提交 `1bface0`）

用户继续授权后确认解锁，使用已通过门禁的打包二进制完成测试。未修改产品代码，因此沿用下方完整门禁结果。

### 取消、查询、去重、关闭：通过

自有 NonKeyPanel PID 90121 / window 30827，session `b606a7af-4f8e-4f01-800f-8c0bf89e1fb5`，host PID 90128。

- 真实 AXPress 回调进入后取消，控制面约 26 ms 返回；首动作 unknown，第二动作 not_run。释放回调后实际按钮计数为 1。[完整记录](evidence/2026-09-16-native/final-cancel/cancel-run.json)。
- 宿主仍可查询 unusable；相同 requestId 返回原有 unknown 结果，新请求返回 session_closed。按钮始终为 1，没有重放。[查询与去重](evidence/2026-09-16-native/final-cancel/terminal-checks.json)。
- 显式 close 返回 unusable、leaseReleased=false，符合未知结果保留占用的合同；宿主与 fixture 随后退出。[close](evidence/2026-09-16-native/final-cancel/close.json)。清理字段 driverTerminated=false 是当前保守状态报告，不应解读为 ps 检查仍有宿主存活。
- 从窗口创建到最终记录，frontmost 始终 57145、activationChanges=[]，key/main 均 false、keyEvents=0。[最终窗口状态](evidence/2026-09-16-native/final-cancel/final-state.json)。

### 表单输入：SDK 背景路径未产生效果

另开新 NonKeyPanel PID 90189 / window 30903。新截图坐标点击输入框后，只调用一次 SDK typeText，并保存原始回执；没有重试此前窗口的输入。

[SDK 原始回执](evidence/2026-09-16-native/type-diagnostic/raw-type.json) 为 isError=false、effect=Unverifiable、route=SyntheticEvents、delivery=Background，escalation={target:Foreground, reason:DeliveryFailed}。调用前后 field value 为空，前台 PID 21897 不变，key/main 为 false。等待 500 ms 后读取状态，再独立 observe 一次：[复查](evidence/2026-09-16-native/type-diagnostic/verify.json)、[截图](evidence/2026-09-16-native/type-diagnostic/verify.png)仍为空。

这证明本次 SDK 后台路径没有可确认的表单效果，不证明所有应用均无法后台输入。SDK 建议 Foreground 重试，但本任务明确禁止抢前台，因此停止并将表单验收保留为未通过。产品的 delivered 合同仅描述投递，不保证业务效果；本次原始结果不支持把它改成 not_delivered。

全部自有测试进程已退出。[清理记录](evidence/2026-09-16-native/final-process-cleanup.json)。

## 解锁后续测（此前批次，以下保留当时结果）

使用 `b096bfd` 产品源码生成的本仓库打包二进制，仍只操作禁止成为 key/main window 的自有窗口。

| 项目 | 结果 |
|---|---|
| 原生 AX 阻塞后取消 | 首动作 unknown、第二动作 not_run；释放回调后实际计数为 1，符合未知结果分类。[实机记录](evidence/2026-09-16-native/unlocked/cancel/cancel-run.json)。 |
| unknown 后控制面 | 未通过：独立宿主退出，status 回退为 unusable 且保留 lease；重复请求和新请求连接失败。[记录](evidence/2026-09-16-native/unlocked/cancel/terminal-checks.json)。进程内 host 回归未覆盖此退出路径。新增真实 openSession 子进程回归先在 ENOENT 处失败；修复后保留控制面直到显式 close，19 个相关测试通过，完整门禁通过；最后一次原生复跑前再次锁屏，因此该项实机验收仍待补。 |
| 自定义 out-dir 跨命令 / 非整数缩图 | 通过目录读取与坐标请求：1040×664→400×255，点击命令返回成功，前台与 key/main 标志保持不变。此字段没有点击计数，不能单凭回执确认焦点变化；实际画布命中见尺寸变化后的记录。[点击](evidence/2026-09-16-native/unlocked/form/field-click.json)。 |
| 文本输入 | 未通过：坐标点击后 firstResponder 为 NSTextView，一次 type 返回成功，但独立 observe、fixture value 和截图均为空。停止输入，没有重试。[输入](evidence/2026-09-16-native/unlocked/form/field-type.json)、[复查](evidence/2026-09-16-native/unlocked/form/field-type-verify.json)、[截图](evidence/2026-09-16-native/unlocked/form/field-type-verify.png)。 |
| 内容变化拒绝旧图 | 通过：自有画布变色后旧图被拒绝，计数不变。[记录](evidence/2026-09-16-native/unlocked/form/changed-content-reject.json)。 |
| 尺寸变化拒绝旧图 | 通过：520×332→600×372 后旧图被拒绝，计数不变。[记录](evidence/2026-09-16-native/unlocked/form/resized-reject.json)。 |
| 尺寸变化后新图点击 | 通过：1200×744→400×248，新图 (273,150) 命中无 AX 画布，计数 0→1；前台不变、key/main 为 false。[记录](evidence/2026-09-16-native/unlocked/form/after-resize-click.json)、[截图](evidence/2026-09-16-native/unlocked/form/after-resize.png)。 |
| 越界坐标 | 通过：400×248 图像的 x=401 在派发前被拒绝，计数不变。[记录](evidence/2026-09-16-native/unlocked/form/bounds-reject.json)。 |
| 窗口不匹配 | 通过：将同一观察用于不同窗口号时返回 belongs to a different target，计数不变。[记录](evidence/2026-09-16-native/unlocked/form/wrong-window-reject.json)。 |

表单 fixture 已关闭。前台应用在步骤之间有用户切换；上述通过步骤的前后快照一致，fixture 没有成为前台或 key/main window。文本输入结果不证明普通应用的输入能力，也不能作为表单完成证据。代码审计确认产品没有透传 SDK action effect，但 delivered 的合同仅指投递，不保证业务效果；此次未采集原始 SDK effect，不能据此断言投递误分类。

### 宿主修复的最终门禁

产品提交：`1bface0`。

- 两个 API 生成无漂移，typecheck 通过。
- 默认测试：644 pass / 10 skip / 0 fail，654 tests，2345 assertions。与前轮相比新增两个跨进程测试；已有打包产物使五个装配用例在默认测试中直接运行。
- package:release、build、smoke 通过；三文件打包验收 12 pass / 72 assertions；runtime 装配 4 pass / 23 assertions。
- [门禁日志](evidence/2026-09-16-native/unlocked/gates)。
- 独立只读复审：无阻塞缺陷。复审者确认 unknown 保留查询与 lease，显式 close 退出；新增 self-spawn 测试重复 25 次通过，idle / close / standalone / unusable finalize 相关测试通过。未执行 UI 操作。

重新打包后启动了新 fixture 与 session，但 [observe](evidence/2026-09-16-native/unlocked/final-cancel-locked/observe.json) 返回 image unavailable / AX unresolved；[只读检查](evidence/2026-09-16-native/unlocked/final-cancel-locked/lock-state.json) 确认再次锁屏。没有执行输入，session [正常关闭](evidence/2026-09-16-native/unlocked/final-cancel-locked/close.json)，driverTerminated 与 leaseReleased 均 true，fixture 也已退出。

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

根因位于 runtime `isKnownDriverRefusal()`：仅凭 Tool 异常类名，就把所有此类错误认定为输入前拒绝。修复只将明确的结构化派发前拒绝代码记为 not_delivered；无分类 Tool 错误和派发后的 AbortError 记为 unknown，并阻止会话后续派发。探针现在保留 errorCode，不再仅因捕获异常就宣称 driver-refused。实机修复后分类已通过，后续宿主生命周期缺陷见上方续测。

## 跨命令观察目录缺陷

真实 `observe --out-dir <dir>` 保存成功后，`act --out-dir <same-dir>` 仍从默认缓存路径寻找 observation，报 ENOENT。修复让一次性会话使用请求指定的 artifactsDir。回归使用真实磁盘 ObservationStore 和两个独立命令实例，验证保存后可读取并执行坐标映射。此回归修复前 0 pass / 1 fail，失败路径为默认 observation 目录；修复后通过。解锁后的自定义目录原生复跑已通过，见上方续测。

[取消请求的持久日志](evidence/2026-09-16-native/journals/7b45f071-8599-417a-a96d-a2e0eba20522/native-cancel-ax-1/events.jsonl)也保留了修复前错误的 not_delivered 结果，供复查。

## 历史锁屏阻塞（用户已解锁）

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

断言首个动作 unknown、第二个 not_run、实际调用次数为 type=1/key=0；相同请求返回既有结果，新请求被拒绝；host 为 unusable、lease 仍存在，journal 只有一个 unknown 终态。[独立复现输出](evidence/2026-09-16-native/ipc-structured-tool-result.json)。这证明修复跨 IPC 保持结果分类。解锁后的真实 AX 取消分类也已通过，但独立宿主退出暴露了此进程内 host 测试未覆盖的生命周期问题。
