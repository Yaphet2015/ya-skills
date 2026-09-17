# 输入隔离验收 — 2026-09-16

> 2026-09-17 续验：用户允许临时占用当前桌面后，AX 表单填写与提交已实跑通过。最新结果和边界见 [真实验收报告](2026-09-17-ax-form-native.md)。以下保留此前检查记录。

状态：当前产品不能证明“用户鼠标键盘不受干扰”。本文件对应的 probe 只读 SDK 0.27 本地声明、README、产品 adapter 源码、fixture 源码和此前保存的原始 type 回执。它不导入 SDK，不启动 driver 或 fixture，不打开桌面窗口，不点击、不 typing、不发送 key/scroll，不激活窗口，也不监听或记录全局输入。

## 结论

SDK 0.27 的能力边界不支持 AX-only 断言：

- `ClickInput` 有 `deliveryMode`，产品对 AX token 和坐标点击都传 `InputDeliveryMode.Background`。
- `TypeTextInput` 与 `PressKeyInput` 没有 `deliveryMode` 字段。保存的工具契约中，`type_text` 允许先走 `AXSetAttribute(kAXSelectedText)`，失败后自动用 CGEvent 合成字符；`press_key` 的 background 也会向目标 pid 注入输入。
- 工具结果可以同时是 `effect: "unverifiable"`、`route: "synthetic_events"`、`delivery.mode: "background"`，并建议 `escalation.target: "foreground"`。Background 表示不把窗口置前，不表示没有合成事件，也不表示隔离了用户输入。

本地原始证据 [raw-type.json](evidence/2026-09-16-native/type-diagnostic/raw-type.json) 正是这个组合：`Unverifiable`、`SyntheticEvents`、`Background`、`DeliveryFailed → Foreground`。输入框值没有变化。前后台 PID、key/main window 和 fixture 自身事件计数没有变化，只能说明该次记录没有观察到这些变化，不能证明用户桌面的输入没有被影响。

fixture 也有独立的覆盖边界：

- 历史 [NonKeyFixture.swift](evidence/2026-09-16-native/NonKeyFixture.swift) 仍保留当时的缺口：它将 `canBecomeKey`、`canBecomeMain` 设为 `false`，却调用 `orderFrontRegardless()`，没有设置 `panel.ignoresMouseEvents = true`。这份归档只用于解释旧证据，不能把它的状态当作当前 fixture 状态。
- 当前坐标验收 fixture [computer-use-native.swift](../../scripts/probes/fixtures/computer-use-native.swift) 默认设置 `panel.ignoresMouseEvents = true` 并使用 `orderBack(nil)`。只有同时传入 `--allow-pointer` 和 `YK_INPUT_TEST_DESKTOP=1` 时，它才会打开指针接收并调用 `orderFrontRegardless()`；这两个条件表示坐标测试必须在独立测试桌面执行。它仍不能证明通用 SDK 输入不会发送合成事件。
- [computer-use-ax-form.swift](../../scripts/probes/fixtures/computer-use-ax-form.swift) 已设置 `ignoresMouseEvents = true` 并使用 `orderBack(nil)`。它可以作为 AX-only fixture 候选，但当前没有在用户桌面启动或输入验收。坐标输入仍需要独立测试桌面。
- 保存的候选契约 [input-isolation-candidates.json](evidence/2026-09-16-native/type-diagnostic/input-isolation-candidates.json) 显示 generic `set_value` + token AXPress 是可研究的纯 AX 候选；产品 adapter 没有暴露 generic `set_value`，因此这不是现有 `Computer.type` 的通过证据。

产品 adapter 还有两个可审计缺口：

1. `packages/computer-runtime/src/cua-backend.ts` 只能为 click 构造显式 Background。SDK 的 type/key 输入没有 route 选择字段，因此 adapter 无法请求 AX-only。
2. `Backend` 的 `ToolResultLike` 只保留 `isError/text`，`Computer.type/key/scroll` 返回 `Promise<void>`。session action 只处理 `isError`，不会在 native result 的 route/effect/delivery 表明合成输入时阻止或报告它。

因此，最小修复方向是增加派发前的输入策略：

- 使用支持 strict AX-only/no-fallback 的 SDK/driver，并在派发前确认该策略。
- 如果能力不存在，在跨过 native input seam 之前拒绝请求。只有这种派发前拒绝才能报告 `not_delivered`。
- 一旦输入已经跨过 seam，不能把事后观察到的非 Accessibility route 改成 `not_delivered`。应按实际 delivery contract 保留 `delivered` 或 `unknown`，并停止任何自动 fallback 或 Foreground 重试。
- 保留结构化 route/effect/delivery，供诊断和审计使用。仅改名 route 或检查 frontmost PID 不能提供派发前保证。

## 显式只读 probe

运行：

```sh
bun scripts/probes/computer-input-isolation.ts
```

该脚本输出 JSON report，并固定报告 `driverStarted: false`、`desktopInputSent: false`。它读取：

- SDK `cua_driver_contract.d.ts` 和 README；
- 保存的 `listToolsJson` 精简证据；
- adapter、runtime facade、session action 源码；
- 已保存的 native type 回执；
- 历史／当前 fixture 源码。

report 使用三种状态：

- `observed`：证据中直接观察到的事实，例如原始回执的 `synthetic_events` route。
- `unsupported`：当前 contract 或 fixture 缺少输入隔离所需能力，例如 SDK 没有 type/key 的 AX-only/no-fallback 选择。
- `unknown`：没有对应的桌面观察或本地输入材料，例如用户桌面的实际不干扰结果。

当前报告应显示：SDK input policy `unsupported`、product adapter `unsupported`、native route `observed`、fixture surface `observed`，而 user desktop noninterference 是 `unknown`。历史 fixture 的 `unsupported` 只在 `historicalFixtures` 中保留，不影响当前 fixture surface；报告同时记录当前坐标 fixture 的 `--allow-pointer` + `YK_INPUT_TEST_DESKTOP=1` 门禁和 AX-only fixture 的 `ignoresMouseEvents` 状态。

该 probe 不加入默认 CI，也不替代真实输入验收。`bun run typecheck` 可单独验证仓库源码；probe 位于 `scripts/probes/`，不导入 native SDK。

若要复查 SDK 工具级完整契约，可在已经保存的只读快照上运行：

```sh
jq '.tools[] | select(.name == "type_text" or .name == "press_key") |
  {name, description, inputSchema, outputSchema}' \
  /tmp/ya-input-contract/tools.json
```

这个快照来自此前的 `listToolsJson` 读取；不要为此重新启动 native fixture。重点字段是 `type_text` 描述中的 automatic CGEvent fallback，以及 `delivery_mode` 只有 `background|foreground` 两档。

## 验收边界

上述 probe 证明了当前 contract、route、adapter 和 fixture 源码之间的缺口，并复述已有原始回执的分类。它不能证明真实桌面上的“无干扰”：没有在用户桌面发送输入，就无法观测所有目标应用、输入法、辅助功能代理或系统事件消费者的实际结果。即使某次测试中 frontmost PID 不变、fixture 不是 key/main window、fixture 没有收到 key event，也不能把它升级为用户输入隔离证明。

在没有独立测试桌面、派发前 AX-only driver 路由或系统级输入隔离能力前，用户正在使用的桌面只能做只读 observe/doctor 检查。需要真实输入的验收必须在独立桌面执行；坐标 fixture 还必须显式设置 `YK_INPUT_TEST_DESKTOP=1` 并传 `--allow-pointer`，任何 synthetic/global/foreground route 都标为未通过或未验证。
