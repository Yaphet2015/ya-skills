# Cua Driver 升级评估：0.38.0 → 0.47.24

核对日期：2026-11-13。范围：ya-skills 的 macOS arm64 本地驱动、AX、输入、截图和持久 session。

后续实施：依赖已升级，并接入多步等待优化、原生搜索字段和 AX 正向条件判断。
下面保留调研时的结论和候选验证；实际实施结果见
[执行器升级验证](../verification/2026-11-13-cua-driver-executor-upgrade.md)。

## 结论

建议将 **0.47.24** 作为升级目标。相比当前固定的 0.38.0，最有价值的变化是 AX 属性批量读取、打字事件批量发送、减少固定等待，以及 macOS 窗口、sheet 和输入结果的修复。它们与当前 yk 的原生路径直接相关。可选的 `post_action_wait: "none"` 值得随后接入；它与 yk 自己读取后续状态的方式相符。[上游变更记录](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/CHANGELOG.md)、[嵌入指南](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md)

截至查询时，npm `latest` 是 0.47.24，npm 发布时间为 **2026-11-12 21:58:55 UTC**；GitHub 同版发布于 21:52:35 UTC。GitHub 标为 prerelease，但发布正文明确说明：该标记用于管理 monorepo 的 Latest 指针，普通 SemVer 版本走 npm/PyPI 的稳定通道。[npm 元数据](https://registry.npmjs.org/@trycua%2fcua-driver)、[0.47.24 发布说明](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.47.24)

依赖升级不能自动改变 Agent 的操作策略。刚修改的 Skill 负责减少模型往返；驱动升级负责减少每次原生调用的工作和等待。下面的性能数据来自上游测试，尚不是 yk 的前后对照结果。

## 升级后可直接获得的改善

| 变化 | 首次包含版本 | 对 yk 的影响与证据 |
| --- | --- | --- |
| 一个 AX 节点的属性合并为一次 `AXUIElementCopyMultipleAttributeValues` 调用；不支持批量读取的应用保留逐项回退 | 0.42.4 | 当前 `getWindowState` 路径可受益。上游在负载下测得 Calculator 的遍历从 117–145 ms 降到 56–61 ms，TextEdit 从 128–144 ms 降到 69–85 ms；机器、窗口规模和遍历阶段均有限定。[PR #6878](https://github.com/trycua/cua/pull/6878) |
| Chromium AX 唤醒等待改为检查 AXWebArea 稳定；Web 焦点等待改为检查实际焦点 | 0.42.4 | 上游替换了固定 500 ms 和 800 ms 等待。只在实际经过对应原生路径时有收益；正常 DOM/CDP 页面流程仍走 CDP。[变更记录](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/CHANGELOG.md) |
| 按窗口 ID 查一个窗口；应用识别减少进程扫描和子进程；安装应用扫描有缓存 | 0.42.4 | 减少查询准备工作。不会消除 yk 自己的目标选择或持久 session 管理。[变更记录](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/CHANGELOG.md) |
| macOS `type_text` 默认延迟从逐字符 30 ms 改为 0，并将最多 16 个 UTF-16 单元合并发送；读回不变的字段在 500 ms 后停止轮询 | 0.43.2 | 主要改善 AX 写入不可用而回退到按键的情况。上游负载机器的 103 字符发信阶段测得 7967 ms → 313 ms；不能将该比例外推到所有应用。原生字段部分接收时可补发尾部；Web 内容不盲目补发。[PR #6884](https://github.com/trycua/cua/pull/6884) |
| Node runtime 不再为每次 future poll 泄漏 libuv handle | 0.39.0 | 与长期存活的 session/driver 相关。[修复 #5691](https://github.com/trycua/cua/pull/5691) |
| macOS 后台窗口枚举、sheet 身份与焦点恢复仲裁修复；禁用控件被索引并报告 `enabled:false`，写入时拒绝禁用控件 | 0.39.0–0.41.3 | 与后台原生操作直接相关。当前 yk 已保留 `enabled`；需要真实窗口验收具体应用行为。[变更记录](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/CHANGELOG.md) |
| `ax_window_unresolved` 加入 AXWindows 读取失败原因 | 0.47.0 | 改善原生窗口读失败的诊断。[修复 #7192](https://github.com/trycua/cua/pull/7192) |
| 为所有原生输入工具的 ActionResult 输出契约增加跨平台检查 | 0.47.24 | 防止后续工具绕过输入结果归一化。该版主要增加契约测试和文档，不能描述为“这次才给所有输入增加结果”。yk 仍需保留 `unverifiable`、`refused`、未知投递等语义。[PR #7507](https://github.com/trycua/cua/pull/7507) |

0.44.0 还修复了键盘布局相关的按键位置和 macOS Text Input Sources 线程使用，0.47.15 修复了后台 `type_text` 向单行字段提交 Return 的行为。这些是升级验收时应覆盖的输入场景。[变更记录](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/CHANGELOG.md)

## 值得显式接入的能力

### 1. 优先评估 `post_action_wait: "none"`

0.39.0 起，macOS 的 click、type、key、scroll、set_value 等原生输入可以跳过结果对窗口变化报告的等待。默认直接调用最多先等 300 ms；`none` 在输入送达后返回，后台窗口监测仍运行到完整期限，并继续持有防止抢焦点的 lease。结果会明确说明未等待窗口变化，随后仍须检查实际状态。[源码与适用工具列表](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/crates/cua-driver-core/src/post_action_wait.rs)

这适合 yk 的多步 `exec`：代码中已有条件等待和后续观察，无需每个输入再支付相同的报告等待。上游在 macOS 26 的 Calculator 后台 AXPress 测试中报告中位耗时约 570–750 ms → 250–350 ms。这是上游样本，需在 yk 中重测。[嵌入指南](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md)

当前 [cua-backend.ts](../../packages/computer-runtime/src/cua-backend.ts) 没有传该参数。最新 npm 包的 `ClickInput` 等强类型结构也没有该字段，不能只把字段塞进 `.new()`；应核对并通过 generic `callTool` 接入，同时保留窗口 bigint、后台 delivery 和结果分类。Linux/Windows 不接受该参数；当前 yk 的运行平台虽为 macOS，仍应在适配层限定它。

不要以 `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0` 代替：这个环境变量缩短整个监测及焦点保护期限；`post_action_wait:none` 只取消调用方等待。二者的行为不同。[嵌入指南](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md)

### 2. 保留搜索字段的独立身份

0.43.0 的原生元素新增可选 `title`、`description`、`placeholder`、`subrole`。它们可以区分 `AXSearchField` 与“内容恰好像搜索提示”的输入框，减少错误选中搜索框或消息输入框的情况。身份属性与节点其他属性一起批量读取。[PR #6893](https://github.com/trycua/cua/pull/6893)

当前 [normalizeElements](../../packages/computer-runtime/src/observe.ts) 和 [AxElement](../../packages/computer-runtime/src/types.ts) 未保留这些字段；最新强类型 `WindowElement` 也没有这四个成员。因此只改投影不足，需要用 generic `get_window_state` 读取原始结构化 JSON 并规范化，或由上游补充 typed contract。接入还需同步公开类型和生成的 API 声明，并继续过滤敏感字段的内容。

### 3. 分清 yk 的 exec 与上游批量执行

最新驱动对自己的 `run_steps` / `run_script` 内步骤缩短等待：光标到达最多等 120 ms，窗口变化报告最多等 100 ms；`run_steps` 最后一步和直接调用保留完整等待。该行为由驱动内部 task-local 标记控制，不能靠每个调用多传一个普通参数启用。[step_pacing.rs](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/crates/cua-driver-core/src/step_pacing.rs)

yk 的 [exec worker](../../packages/computer-session/src/exec-worker.ts) 和 [batch sequence](../../packages/computer-runtime/src/batch-sequence.ts) 自己编排步骤，最终调用适配层的独立输入方法。因此不能假设升级后这些调用就能获得上游的批量 pacing。先接入 `post_action_wait:none` 更容易保持现有 receipts、超时、未知投递和清理契约；直接换成上游 `run_steps/run_script` 需要单独设计与验证。

0.45.0 还将“改用 run_steps”的提示提前到第二次直接输入后，并附现成调用。该提示属于模型看到的上游文本；yk 主要提取结构化结果，不能依靠它改善 Agent 的批量策略。上游 PR 的调用数降低估算不是已验证的 yk 耗时或 token 改善。[PR #6921](https://github.com/trycua/cua/pull/6921)

### 4. `fast_path` 先做 shadow 验证

0.39.0 加入默认关闭的 `fast_path`。`shadow` 只报告守卫结论；`guard` 在目标变化时拒绝；`on` 还带小范围 delta，并减少不必要的截图重读。它使用缓存目标并在动作发生时核验目标状态。[fast_path 源码](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/crates/cua-driver-core/src/fast_path/mod.rs)

当前 yk 已有自己的 PNG、窗口身份、epoch/revision 和 token 校验，[parseActionResult](../../packages/computer-runtime/src/driver-result.ts) 也没有保留新增的 `fastPath`。应先测它是否减少重复工作、是否改变拒绝原因，再决定是否引入；不能把打开 `on` 等同于可直接删除现有证据校验。

## 暂不作为默认设置的选项

- **JPEG**：0.39.0 加入 `screenshot_format` / `screenshot_quality`，默认仍为 PNG；JPEG 不生成驱动的 `capture_id`，上游要求绑定捕获的工具重新读取 PNG。当前 yk 的 [image-evidence.ts](../../packages/computer-runtime/src/image-evidence.ts) 也只接受 PNG，并执行严格像素比较。JPEG 适合日后独立的浏览/展示通道，不适合直接替换动作证据。[官方截图参数](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/docs/content/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen.mdx)
- **更短按键间隔**：`CUA_DRIVER_KEY_GAP_MS` 可将默认 8 ms 降到最低 2 ms。上游明确要求检查应用是否合并或丢失输入；应在完整读回测试后按目标应用评估。它和默认 `type_text` 分批发送的改善是两项设置。[嵌入指南](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md)
- **光标效果、上游应用安装/浏览器配置、Linux/Windows 新适配器**：不解决当前 yk 的 macOS 多步执行问题，不应随依赖升级扩大接入范围。

## 兼容性核对

主任务已在实际 npm 包中核对：SDK 与 darwin-arm64 原生包均有 0.47.24，`@ubjs/core` / `@ubjs/node` 仍为 0.31.0-3；`dist/index.d.ts` 与 0.38.0 一致，生成的 native contract 增加了可选 `ActionResult.fastPath` 和 `InvokeMenuInput.deliveryMode`。原生 `.dylib` / `.node` 布局保持不变，两版 macOS dylib 的最低系统版本均为 13.0。它们支持“可以进行兼容升级”的判断，不能代替真实桌面验收。[npm 0.47.24 元数据](https://registry.npmjs.org/@trycua%2fcua-driver/0.47.24)、[原生包元数据](https://registry.npmjs.org/@trycua%2fcua-driver-darwin-arm64/0.47.24)

升级涉及两处维护入口：[computer-runtime/package.json](../../packages/computer-runtime/package.json) 的 SDK/native pin，以及 [package-release.ts](../../scripts/package-release.ts) 的同名 `PINNED` 项；还要更新 public-registry 可用的 `bun.lock`。`@ubjs` 版本不需要为了本次升级一起更改。

有两项现有行为需避免误判：

1. 上游通用 `get_window_state` 默认返回 Markdown 的行为在 0.38.0 已存在。最新 typed SDK 的 `get_window_state` 在调用方未选格式时设 `full_output:true`，仍为程序返回 elements；当前 yk 的 typed 方法不会仅因该默认值而丢掉 elements。[SDK 实现](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/crates/cua-driver-sdk/src/lib.rs)
2. macOS 原生读取在两个版本中均保守地设置 `elements_complete:false`，因为 elements 只含部分节点，不能证明全域不存在。当前 yk 将此投影为 truncated。这是已有的完整性语义问题，需要独立处理“可使用已观察到的正向匹配”与“可以证明不存在”的边界，不应为了通过升级验收而伪造 complete。[0.38.0 源码](https://github.com/trycua/cua/blob/cua-driver-rs-v0.38.0/libs/cua-driver/rust/crates/platform-macos/src/tools/get_window_state.rs)、[0.47.24 源码](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/crates/platform-macos/src/tools/get_window_state.rs)

0.47.9 增加了对 macOS 安全/同意提示输入的拒绝。应将其作为预期拒绝保留；普通原生文件选择器需照常验收。0.47.20 弃用的上游 Computer History 与 yk 自己的 events.jsonl 历史不是同一存储机制。[变更记录](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/CHANGELOG.md)

## 本地验证状态

本次评估只在主工作区新增本报告；依赖升级发生在隔离副本中。候选副本从当前 HEAD 导出，只将 `computer-runtime/package.json` 的两个 Cua pin 和 `package-release.ts` 的同名 pin 改为 0.47.24，再使用公共 npm registry 安装并生成 lockfile。验证环境是 macOS arm64、Bun 1.4.0；仓库声明的 packageManager 为 Bun 1.3.14，尚未在该精确版本下复测。

| 检查 | 结果 |
| --- | --- |
| npm SDK/native 包 SHA512 integrity | 两个 0.47.24 包均匹配 registry 元数据。 |
| SDK/native bindings 加载、输入结构工厂 | 实际 import 成功；未创建 driver。窗口 ID 保持 bigint，ActionRoute/ActionEffect 数字枚举与当前 parser 一致。 |
| `bun run typecheck` | 通过。 |
| `bun test --timeout 30000` | 首轮运行全部 102 个文件：785 pass、18 skip、14 fail。13 项失败由同时继承 NO_COLOR/FORCE_COLOR 导致 stderr 警告，另 1 项因 macOS 临时路径包含 `/private/` 触发 pbench 的路径断言。移至用户 cache 路径并移除冲突颜色变量后，复跑受影响的 5 个完整文件：83 pass、0 fail；首轮的 14 个失败均通过。未修改测试或产品代码以通过检查。 |
| `bun run package:release --version 2.3.0` | 通过；正式脚本产出二进制、skills、0.47.24 runtime sidecar 和 tarball/checksum。版本号仅供本地候选打包，未发布资产。 |
| `YK_RELEASE_TESTS=1 bun test --timeout 30000 tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-use-packaging.test.ts tests/computer-lane-release-packaging.test.ts` | 18 pass、0 fail；涵盖签名、sidecar 布局、编译后 worker、去重和无桌面运行闭环。 |
| `bun run build` / `bun run smoke` | 均通过。 |

验证副本和完整日志位于 `/Users/phaethon/.cache/cua-driver-0.47.24-f7__2d15/`。上述测试采用 fake driver 或纯文件/进程路径；本次未启动真实 driver、读取或操控桌面，未测量 yk 的前后延迟、输入质量或前台焦点变化。结果支持进行依赖升级；真实应用中的行为和性能仍需验收。

建议顺序：先完成纯依赖兼容升级；再单独接入并测量 `post_action_wait:none`；随后保留搜索字段身份。`fast_path`、JPEG 和上游批量工具接入各自作为独立变更评估。
