# AX 表单真实验收 — 2026-09-17

**本地 AppKit 表单的完整填写与提交已通过。** 用户明确允许暂时占用当前电脑，本轮在该桌面运行，没有使用独立登录会话。

## 实跑结果

| 检查 | 结果 |
| --- | --- |
| Name | 产品 `Computer.setValue` 写入 `Ada Lovelace`；AX 回读一致 |
| Email | 产品 `Computer.setValue` 写入 `ada@example.test`；AX 回读一致 |
| Message | 产品 `Computer.setValue` 写入 `AX form submission`；AX 回读一致 |
| 三次写入回执 | 均为 `route=accessibility`、`effect=confirmed`，SDK 附有 `value_readback` 证据 |
| 提交 | 产品 `Computer.click` 定位提交按钮；SDK 返回 `route=Accessibility`、`effect=Unverifiable` |
| 提交后验证 | 新鲜 AX 观察读取到 `AX form result=submitted`；fixture 的 `submitCount=1`，三个字段值正确 |
| 窗口与鼠标 | 前台 PID 始终记录为 Ghostty 4610，fixture 非 key/non-main，鼠标穿透开启；50ms 状态采样未发现鼠标位置变化 |
| 清理 | session 正常关闭，fixture exit 0，没有强制终止；结束后已知测试程序名称无进程匹配 |

因此，本次可以确认**这张表单的业务闭环成功，四个动作的实际 SDK 路由均为 AX**。SDK 对提交点击本身没有确认效果；成功结论来自随后实际 AX 值与提交次数，不能把 SDK 的 `Unverifiable` 改写为 `Confirmed`。

本轮没有调用 SDK `typeText`、`pressKey` 或 `scroll`。通用 background 输入仍可能使用合成事件；一次空闲桌面上的 AX 成功不能证明所有应用、所有输入路径或用户同时操作时都无干扰。鼠标状态采样也不是全局事件审计。现有点击接口仍缺少派发前严格禁止 fallback 的能力。

## 运行中发现并修复的问题

首次运行在任何字段写入前失败：产品 AX channel 返回 `truncated`，reason 为 `elements_incomplete`。默认观察、等待 1.5 秒、提高 maxElements/maxDepth 的三个只读对照结果均相同。

原始 SDK Markdown 包含静态标签和结果，但 structured elements 只包含带编号的可索引元素。旧结果标签没有编号，因此 runner 无法用 structured elements 读取提交状态。fixture 现在使用标准的只读、可选择文本控件；实测 SDK 将其作为带 token 和 value 的 `AXStaticText` 返回。

runner 仅针对这个自有 fixture 接受 `elements_incomplete` 且返回计数一致的投影，并逐项检查实际返回的命名控件、token 和值。明确截断、降级或计数不一致仍会拒绝。原始 observation 保留 `complete=false`、`status=truncated`，全局 runtime 的观察判定没有更改。这里验证的是明确存在的字段值，不是整棵 AX 树的完整性。

初始 observation 现在在校验前保存，失败也能留证。输入一旦开始尝试，报告不会在异常路径中误写成 `not_attempted`。

## 回执审计与证据

产品 `Computer.click` 没有公开 SDK 的 route/effect。此次用独立的透明记录脚本包装 SDK 方法，转发原参数、返回原结果，不增加重试，不替换产品 adapter。调用序列只有三个 `callTool(set_value)` 和一个 `click`。

产品 runner 原报告保留 `submit.route=unavailable`、`inputIsolation=unverified`；下列独立原始回执补充了本次实际 AX 路由证据，没有篡改 runner 报告。

- [完整运行报告](evidence/2026-09-17-ax-form/report.json)
- [SDK 原始调用与枚举](evidence/2026-09-17-ax-form/native-calls.json)
- [提交后 AX 观察](evidence/2026-09-17-ax-form/observation-final.json)
- [提交后 fixture 状态](evidence/2026-09-17-ax-form/state-final.json)
- [运行版本、授权、文件摘要与命令](evidence/2026-09-17-ax-form/provenance.json)
- [实际使用的透明记录脚本](evidence/2026-09-17-ax-form/audit-harness.ts)
- [首次失败](evidence/2026-09-17-ax-form/initial-failure.json)
- [默认观察](evidence/2026-09-17-ax-form/raw-initial.json)、[延迟观察](evidence/2026-09-17-ax-form/raw-delayed.json)、[显式限制观察](evidence/2026-09-17-ax-form/raw-explicit-limits.json)

## 代码验证

- 定向测试：13 pass、0 fail、46 assertions。
- `bun run typecheck` 通过。
- Swift fixture 使用 `-warnings-as-errors` 编译通过。
- `git diff --check` 通过。

上轮安装矩阵及持久 host 责任归属结论仍见 [权限与安装报告](2026-09-16-permissions-install.md)，本轮没有重复安装或修改系统权限。
