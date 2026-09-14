# OpenAI ChatGPT / Codex Computer Use 优化调研

日期：2026-09-14  
范围：OpenAI 官方 API 文档、ChatGPT/Codex 官方文档、官方博客、官方 GitHub 示例仓库。  
目标：确认 OpenAI 是否采用“高确定性动作先连续执行，之后再做视觉确认”，并找出 `ya-skills` 可借鉴的优化。

## 1. 结论先说

### 1.1 已证实：OpenAI 的 API 支持动作批处理

当前 Computer Use API 的 `computer_call` 可以携带有序的 `actions[]`。官方示例是：

1. 点击搜索框。
2. 输入 `penguin`。
3. 运行时按顺序执行。
4. 整批动作结束后，返回一张最新截图。
5. 模型再决定下一批动作。

官方原文：

> “A `computer_call` contains an ordered `actions` array.”

以及：

> “Execute permitted actions in order, then capture the updated screen.”

来源：

- [Computer use | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Computer use integration recipes | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)

这正是用户提出的主要方向：**减少“动作 → 模型 → 观察”的往返次数，把一小组确定动作合并，再统一观察。**

### 1.2 已证实：官方建议“短动作组 + 一次观察”，不是无限盲执行

OpenAI 的代码执行集成指南写明：

> “Give the model a current screenshot when the UI state is unknown. After a short group of actions, return another screenshot so it can check the result.”

这里有两个边界：

- 状态未知时，先观察。
- 状态明确时，可以执行一小组动作。
- 动作组结束后，再观察。
- 官方没有建议把整个任务无条件合并成一个超长宏。

来源：[Computer use | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use)

### 1.3 未发现公开证据：OpenAI 暴露了一个“置信度分数阈值”

公开文档能确认：

- 模型可以一次输出多个动作。
- 运行时可以按顺序执行这些动作。
- 运行时可以在动作组后返回截图。
- 安全检查可以在动作执行前阻止或要求确认。

公开文档没有确认：

- ChatGPT/Codex 内部是否生成数值置信度。
- 是否存在例如 `confidence >= 0.9` 才批处理的规则。
- 置信度是否由单独的模型、分类器或运行时计算。
- ChatGPT Desktop 的内部 Computer Use 插件是否与公开 API 使用完全相同的批处理实现。

所以，**可以借鉴“批处理协议和观察节奏”，不能声称 OpenAI 已公开了“按置信度阈值批处理”的内部实现。**

## 2. OpenAI 公开的相关优化

### 2.1 原生 Computer Use：`actions[]` 批处理

**官方事实**

当前 API 的一个 `computer_call` 可以包含多个有序动作。例如：

```json
{
  "type": "computer_call",
  "actions": [
    { "type": "click", "x": 405, "y": 157 },
    { "type": "type", "text": "penguin" }
  ]
}
```

官方要求运行时：

- 保持同一个浏览器或桌面会话。
- 按顺序执行动作。
- 动作执行后再截图。
- 用原始 `call_id` 返回结果。
- 继续使用 `previous_response_id` 让模型保留对话上下文。

**对本库的启发**

把当前的：

```text
一次 act 只能有一个动作
每个动作后立即 snapshot
```

扩展为：

```text
一次 batch 包含有限个有序动作
运行时连续执行
batch 结束后做一次观察
把结果返回给外部 LLM
```

**注意**：这不是让运行时盲执行全部动作。每个动作仍需要本地校验、权限校验、超时处理和可中止能力。

来源：

- [Computer use | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Computer use integration recipes | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)

### 2.2 代码执行模式：一轮工具调用可以组合动作、循环和条件

当前官方 API 文档对 GPT-6 Astra 推荐 **code execution**，并把原生 `computer` 工具作为替代方案。代码执行工具允许模型生成脚本，由运行时执行。

官方明确写道：

> “One call can combine actions, loops, or conditional logic.”

代码执行模式的优点：

- 一个工具调用可以包含多个 UI 动作。
- 可以在本地做条件判断。
- 可以使用 Playwright、PyAutoGUI 或类似库。
- 可以把结构化检查和截图放在同一个执行脚本中。
- 可以只在需要时调用截图。

**对本库的启发**

暂时不建议直接引入任意代码执行。它会扩大权限边界，也会增加安全和审计复杂度。

更小的第一步是做一个**受限动作批次**：

- 只允许现有的 `click`、`type`、`key`、`scroll`。
- 不允许任意 shell、脚本或网络访问。
- 批次由 JSON 动作数组表达。
- 每一步仍由 runtime 执行和记录。
- 必要时允许中途由本地规则打断。

来源：

- [Computer use | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Computer use integration recipes | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)

### 2.3 结构化工具优先于视觉操作

ChatGPT/Codex 的 Computer Use 文档建议：

> 如果目标应用已经有专用插件或 MCP server，优先使用结构化集成；只有需要视觉检查或视觉操作时，才使用 Computer Use。

ChatGPT agent 的官方介绍也描述了多种路径：

- 视觉浏览器。
- 文本浏览器。
- Terminal。
- Connectors 或直接 API。

模型可以选择更适合当前任务的路径，而不是所有事情都通过截图和鼠标完成。

**对本库的启发**

本库已经有一项正确方向：默认返回 AX 元素，而不是默认截图。

AX 元素相当于本地的结构化 UI 状态：

- role
- label
- value
- frame
- enabled

建议保持以下优先级：

```text
本地 AX 状态 / 专用接口
    ↓ 不够时
截图
    ↓ 仍然不确定时
暂停并交给 LLM 或用户判断
```

不要为了模仿“视觉 Computer Use”而每个动作都强制截图。

来源：

- [Computer Use | ChatGPT Learn](https://developers.openai.com/codex/computer-use)
- [Introducing ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/)
- [Browser | ChatGPT Learn](https://developers.openai.com/codex/browser)

### 2.4 浏览器侧：CDP 和 DOM snapshot 减少往返

官方 Changelog 记录了一项明确的性能优化：

> “Made Browser use up to 2x faster through CDP and DOM snapshot optimizations that reduce browser round trips.”

这条记录说的是 Browser Use，不是通用桌面 Computer Use。但设计方向很有参考价值：

- 不要仅依赖截图。
- 能通过 DOM、AX 或其他结构化树拿到状态时，优先使用结构化状态。
- 把多次低成本状态读取合并到一次工具调用。
- 只在结构化信息不足时调用视觉模型。

**对本库的启发**

AX 树可以承担类似 DOM snapshot 的职责。未来可以增加一个“动作批次结束后的摘要观察”，只返回：

- 目标窗口是否仍然存在。
- 当前焦点控件。
- 关键元素的 role/label/value 变化。
- 是否发生 degraded/truncated。
- 是否需要截图。

来源：[ChatGPT & Codex changelog](https://developers.openai.com/codex/changelog)

同一 Changelog 只说“Made Computer Use faster with GPT-5.6”，没有公开具体的运行时优化细节。因此不能把这句话解释成“GPT-5.6 内置了动作置信度批处理”。

### 2.5 截图策略：按需、短批次后、保持坐标一致

OpenAI 集成指南给出以下规则：

- UI 状态未知时给模型当前截图。
- 短动作组结束后再给截图。
- Computer Use 优先使用 `detail: "original"`。
- 不建议在 Computer Use 中使用 `high` 或 `low` image detail。
- 截图过大时先缩小，再把模型输出的坐标映射回原始桌面坐标。
- 文档观察到 1440×900 和 1600×900 桌面尺寸有较好表现。

**对本库的启发**

本库当前 `--shot` 是可选的，这一点是对的。可以进一步明确三种观察等级：

```text
AX-only       默认，最低成本
AX + screenshot 视觉状态需要确认时
screenshot-only AX 不可用或视觉内容是关键时
```

如果以后支持截图缩放，必须同时返回：

```text
imageWidth / imageHeight
screenWidth / screenHeight
scaleX / scaleY
```

否则模型的点击坐标可能落在错误位置。

来源：[Computer use integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)

### 2.6 长连接和持久状态

官方集成指南要求：

> “Keep the same browser or desktop session available throughout the task.”

代码执行示例还要求：

- 保持浏览器或桌面环境存活。
- 需要时保持脚本变量在多轮之间存在。
- API 对话状态和执行环境状态是两套状态，必须分别保存。

ChatGPT agent 的官方介绍也强调，它使用自己的虚拟电脑，并在多个工具之间保持任务上下文。

**对本库的启发**

当前 `yk computer-use act` 每次命令都：

1. 创建 Computer session。
2. 执行动作。
3. 做一次观察。
4. `finally` 关闭 session。

这会带来额外的驱动启动和关闭成本，也无法由 CLI 本身保存跨命令的桌面执行状态。

可以考虑增加一个长期运行的 session runner，但它应是第二阶段工作，不能和 batch 一起无边界扩大范围。优先级低于批处理，因为单个 batch 已经能直接减少模型往返。

来源：

- [Computer use | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Computer use integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)
- [Introducing ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/)

### 2.7 安全控制：在风险动作前停止，而不是批次结束后才处理

OpenAI 的集成指南要求：

- 批次中遇到需要确认的动作，要在该动作前停止。
- 先执行安全动作，再在真正有风险的下一步询问用户。
- 敏感数据输入本身就算传输，需要在输入前确认。
- 删除、发送、提交、购买、权限变更等动作要在动作时确认。
- 页面上的指令属于不可信内容，不能自动获得用户授权。
- 设置步骤、时间、费用限制，并支持取消。
- 检查实际结果，不能只相信模型的最终回答。

**对本库的启发**

动作批次不能简单地定义成“全部执行，最后截图”。正确模型是：

```text
动作 1：本地检查，通过，执行
动作 2：本地检查，通过，执行
动作 3：发现需要确认，停止
→ 请求用户确认
→ 只继续未执行的剩余动作
```

这也兼容本库现有的安全语义：

- `actionDelivered: true` 后不得重放。
- `command_timeout` 时投递结果未知，必须先 perceive。
- session 超时后进入不可继续使用状态。
- 点击目标必须唯一匹配。

来源：[Computer use integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)

## 3. 与当前 `ya-skills` 的差异

| 能力 | 当前实现 | OpenAI 公开方案 | 结论 |
|---|---|---|---|
| 动作数量 | `act` 每次只能一个动作 | 一个 `computer_call` 有序 `actions[]` | **缺失，最值得先做** |
| 观察节奏 | 每个动作后强制 snapshot | 短动作组后再观察 | **当前过于频繁** |
| 视觉输入 | `--shot` 可选；默认 AX | 状态未知或动作组结束时返回 screenshot | 已有低成本基础，可增加批次级策略 |
| 结构化状态 | AX 元素 | Browser 场景使用 DOM/CDP；插件/MCP 优先 | **方向正确，应继续保留** |
| 点击安全 | 唯一匹配；fresh snapshot；一次 stale-token retry | action handler 自己负责校验 | 当前更严格，保留 |
| 会话生命周期 | 单命令创建并关闭 driver | 任务期间保持同一环境 | 缺失，后续优化 |
| 风险动作 | 当前 skill 要求破坏性动作先说明并获 OK | 在具体风险动作前确认，可批次中断 | 思路一致，batch 需继承 |
| 超时和投递不确定 | 有 deadline、poison、`actionDelivered` 语义 | 官方要求 step/time/cost limit 和取消 | 当前基础较好 |
| 置信度 | 没有数值置信度 | 官方公开资料未说明内部阈值 | 不要先造一个未经验证的分数 |

当前代码位置：

- 单动作限制：`packages/functions-computer-use/src/args.ts:187-194`
- 单动作执行和 post-action snapshot：`packages/functions-computer-use/src/commands.ts:153-178`
- session 每条命令结束时关闭：`packages/functions-computer-use/src/commands.ts:186-191`
- AX 优先、截图可选：`packages/computer-runtime/src/cua-backend.ts:89-108`
- 点击前 fresh snapshot、唯一匹配和 stale-token 重试：`packages/computer-runtime/src/session.ts:97-110`、`packages/computer-runtime/src/actions.ts:11-37`

## 4. 对本库的建议优先级

### P0：受限动作批次 + 批次级观察

这是最直接、最小的借鉴。

建议新增一个 batch 请求，表达如下信息：

```ts
interface ActionBatch {
  actions: ActSpec[];
  observation: "ax" | "ax+shot" | "shot";
}
```

建议的执行规则：

1. 批次为空则拒绝。
2. 动作数量设置上限，例如先从 3–5 个开始；具体数值需要 benchmark，不应伪装成 OpenAI 的规则。
3. 每个动作按顺序执行。
4. 点击动作仍然在执行时从新 AX snapshot 解析目标，不保存跨动作的 element token。
5. `type` 和 `key` 只允许在已有焦点或批次内已明确建立焦点后执行；无法判断时停止。
6. 任何动作失败、超时、degraded snapshot 或投递未知，立即停止后续动作。
7. 任一动作需要用户确认时，在该动作前停止。
8. 批次成功完成后，只做一次 AX snapshot；需要视觉时再带截图。
9. 返回每个已执行动作的状态，以及第一个未执行动作的索引。
10. 保留原始 batch id，避免超时后整个 batch 被重放。

示例：

```text
click 搜索框
→ type "penguin"
→ key Return
→ 一次 AX 观察
```

但以下情况不能放进同一个无确认批次：

```text
click 删除
→ key Return
```

除非用户已经明确授权这个具体删除动作，并且运行时仍通过本地策略检查。

### P1：动作批次内的本地状态检查

不要先引入模型生成的数值置信度。先做运行时可验证的条件：

- 点击目标是否唯一。
- 元素是否 enabled。
- 窗口 pid/windowId 是否仍然存在。
- AX 树是否 degraded/truncated。
- 目标窗口是否发生切换。
- 当前焦点是否仍在预期控件。
- 上一个动作是否明确 delivered。

这比让模型说“我有 0.95 置信度”更可靠，因为模型自报分数不是运行时证据。

可以把结果分成三类：

```text
safe_to_continue：本地条件满足，可执行下一个动作
needs_observation：需要重新拿 AX 或截图
must_stop：投递未知、风险动作、权限问题或目标不唯一
```

### P1：结构化观察摘要

批次结束时，不必默认把完整截图交给 LLM。先返回低成本 AX 摘要：

- 窗口标题。
- 当前焦点。
- 与批次相关的元素。
- 元素值变化。
- 可见错误、弹窗或权限请求。
- degraded/truncated 状态。

以下情况再附截图：

- AX 信息不足。
- 视觉布局是任务结果的一部分。
- 元素值和预期不一致。
- 出现新窗口、弹窗或未知状态。
- 用户要求视觉证据。

### P1：持久 session runner

单命令模型会重复加载和关闭 driver。可以增加一个显式的长期 session：

```text
open session
→ 多个 batch
→ perceive / verify
→ close session
```

但需要解决：

- session id 和所有权。
- 并发禁止：同一 app/window 不允许两个 driver 同时操作。
- 空闲超时。
- driver 崩溃后的重建。
- session 恢复时不能自动重放未确认投递的动作。
- 跨请求的权限和敏感数据处理。

### P2：截图尺寸和坐标映射

如果以后发送截图给视觉模型：

- 默认保留当前 AX-only 路径。
- 视觉路径使用原始 detail，或明确下采样。
- 下采样时记录原图尺寸、发送尺寸、缩放比例。
- 执行点击前把模型坐标映射回实际窗口坐标。
- 不要使用高/低 detail 作为 Computer Use 的默认方案。

### P2：代码执行模式

OpenAI 当前把代码执行作为更推荐的高性能接口，但对本库而言它会扩大能力边界。除非后续任务明确要求：

- 先实现受限 batch。
- 先实现本地 AX 条件检查。
- 先实现可审计的动作日志和取消。
- 再评估是否需要 Playwright/PyAutoGUI 式脚本执行。

## 5. 不建议现在照搬的做法

### 5.1 不建议先实现“置信度阈值”

原因：

- OpenAI 公开资料没有说明这个内部机制。
- 模型自报的置信度不等于 UI 状态已验证。
- 真正要判断的是动作之间是否会改变上下文、焦点或目标窗口。
- 本地 AX 状态和动作投递结果是更强的证据。

### 5.2 不建议取消所有 post-action 观察

OpenAI 的优化不是“永远不观察”，而是“短动作组后观察”。

如果每次都不观察，会掩盖：

- 点击打开了不同页面。
- 输入没有进入目标字段。
- 弹窗抢走焦点。
- 动作只部分投递。
- 窗口已经被遮挡或 AX 树降级。

### 5.3 不建议把所有动作都批处理

批处理适合：

- 已经定位的输入框：click → type。
- 已经确认焦点稳定的键盘序列。
- 连续滚动或连续导航，且中间不会改变目标语义。
- 本地规则可以验证的低风险重复动作。

批处理不适合：

- 删除、发送、提交、购买、权限变更。
- 登录、密码、验证码或敏感数据输入。
- 页面内容可能包含提示注入的场景。
- 每一步都依赖上一步新出现的 UI 状态。
- 投递结果未知的动作之后。

## 6. 建议的验证指标

实现前后都要测同一批桌面流程，不要只测单元测试。

### 效率

- 每个任务的 LLM turn 数。
- 每个任务的 `act` / batch 次数。
- AX snapshot 次数。
- 截图次数。
- 输入图像 token 数。
- 输入、输出和 reasoning token 数（如果平台能提供）。
- driver 初始化次数。
- p50/p95 总耗时。
- 每个动作组的本地执行耗时。

### 正确性

- 任务成功率。
- 批次中途停止率。
- 需要重新观察的比例。
- `actionDelivered: true` 后重复执行率，目标必须为 0。
- timeout 后误重放率，目标必须为 0。
- 元素不唯一时的误点击率，目标必须为 0。
- 焦点错误率。
- 最终状态与预期状态的差异率。

### 安全性

- 风险动作前确认覆盖率。
- 未经确认的敏感数据输入次数，目标必须为 0。
- prompt injection 触发后继续执行的次数，目标必须为 0。
- 同一 app/window 并发驱动次数，目标必须为 0。

## 7. 最终判断

**值得借鉴，而且 OpenAI 的公开 API 已经明确支持这个方向。**

最值得先做的不是“猜一个置信度分数”，而是：

```text
受限有序动作 batch
→ 每个动作做本地可验证检查
→ 遇风险或不确定立即停止
→ batch 结束后只做一次 AX / 视觉观察
→ 把下一轮决策交还 LLM
```

这会直接解决当前实现中最明显的浪费：

```text
每个动作都单独调用 CLI
每个动作后都重新观察
每个命令都重新创建并关闭 driver
```

其中第一项（动作 batch）是最小、最确定的收益点；第二项（AX 优先、按需视觉）已经部分存在；第三项（持久 session）可能进一步减少耗时，但需要单独设计生命周期和崩溃恢复。

## 8. 资料边界

- 本报告只把官方明确写出的 API 行为当作事实。
- “动作数组执行后再截图”有官方 API 和集成示例支持。
- “OpenAI 内部按高置信度数值决定批处理”没有公开证据，本报告不作断言。
- “Computer Use faster with GPT-5.6”出现在官方 Changelog，但没有公开具体实现，因此只记录为产品事实，不推导其内部机制。
- 官方 GitHub sample app 展示了 `native` 与 `code` 两种模式，以及批量动作执行后的单次截图循环；它是公开参考实现，不等于 ChatGPT Desktop 的私有实现。

## 主要来源

1. [Computer use | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use)
2. [Computer use integration recipes | OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)
3. [Computer Use | ChatGPT Learn](https://developers.openai.com/codex/computer-use)
4. [Browser | ChatGPT Learn](https://developers.openai.com/codex/browser)
5. [ChatGPT & Codex changelog](https://developers.openai.com/codex/changelog)
6. [Introducing ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/)
7. [New tools for building agents](https://openai.com/index/new-tools-for-building-agents/)
8. [OpenAI CUA sample app](https://github.com/openai/openai-cua-sample-app)
9. [OpenAI Agents SDK computer-use example](https://github.com/openai/openai-agents-python/blob/main/examples/tools/computer_use.py)
10. [Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/)
