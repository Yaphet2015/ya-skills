# Cua Driver 与 yk 执行器升级验证

日期：2026-11-13。环境：macOS arm64、Bun 1.3.14。

## 实现结果

SDK 和 darwin-arm64 原生包从 0.38.0 固定升级至 0.47.24，发布脚本的 pin 和公共 registry lockfile 同步更新。`@ubjs/core` / `@ubjs/node` 继续使用 SDK 要求的 0.31.0-3。

| 场景 | 原行为 | 本次行为 |
| --- | --- | --- |
| batch/exec 中的原生输入 | 每步保留驱动的窗口变化报告等待 | 每步请求 `post_action_wait:"none"`，由代码中的条件等待和最终观察验证后续状态。直接单步调用保留默认等待。 |
| 原生搜索控件 | typed SDK 和 yk 投影丢失独立身份字段 | generic `get_window_state` 保留 title、description、placeholder、subrole、selected，并传递到脚本和 session 协议。 |
| 搜索字段选择 | 只能按文本和 role 匹配 | batch/exec 选择器支持可选 subrole；文本也匹配 title、description 和 placeholder。 |
| 非完整 AX 的正向检查 | `elements_complete:false` 一律视为截断，auto 额外截图，条件无法满足 | 在索引总数/返回数相等且无降级、截断时允许使用已观察到的匹配，仍报告 `complete:false`。缺失元数据、不等计数、真实截断/降级和重复匹配不作为就绪条件。 |

新驱动本身提供 AX 属性批量读取、输入事件批量发送和条件等待改进。yk 继续使用自己的执行、事件、状态提交和清理流程；本次通过 per-call 参数接入等待优化，没有切换到上游 `run_steps/run_script`。

generic 读取保留原 typed SDK 的 `full_output:true` 范围，避免改变已有菜单和控件覆盖。窗口 ID 在请求中保持整数原文，响应解码保留 bigint；对身份不匹配、格式无效和类型不正确的结果拒绝发布。截图继续请求 PNG。

快速点击的 generic 错误若缺少投递元数据，只有已知的派发前拒绝可以判为未送达；其余按 unknown 处理并停止 session。顺序派发、请求预算、后台输入、PNG 证据校验、最终观察和清理边界继续生效。

上游参数依据：[post_action_wait.rs](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/crates/cua-driver-core/src/post_action_wait.rs)、[原生元素输出](https://github.com/trycua/cua/blob/cua-driver-rs-v0.47.24/libs/cua-driver/rust/crates/platform-macos/src/tools/get_window_state.rs)。此前的能力调查见[升级评估](../research/cua-driver-upgrade-2026-11-13.md)。

## 自动化检查

新增测试先复现了四项缺失行为：多步没有请求跳过报告等待、拒绝后上下文未携带优化选项、非完整 AX 正向检查失败、搜索身份字段丢失。实现后，测试覆盖真实格式的 generic 结果解码、exec 调度、协议传输、条件等待、无截图回退、未知投递停止、严格字段校验和敏感值过滤。

最终检查均使用仓库指定的 Bun 1.3.14。移除继承的 FORCE_COLOR/NO_COLOR 冲突以免子进程产生与产品无关的 stderr 警告。

| 检查 | 最终结果 |
| --- | --- |
| `bun run typecheck` | 通过。 |
| `bun test --timeout 30000` | **818 pass、11 skip、0 fail**；103 个文件、829 项。跳过项是显式原生/发布门控，发布闭环在下一阶段单独运行。 |
| 本次新增回归 | 12 项，包含在默认套件中，全部通过。 |
| `bun run package:release --version 2.3.0` | 通过；二进制、catalog、0.47.24 runtime、tarball 和 SHA256 均由正式脚本生成。 |
| `YK_RELEASE_TESTS=1 bun test --timeout 30000 tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-use-packaging.test.ts tests/computer-lane-release-packaging.test.ts` | **18 pass、0 fail**。 |
| `bun run build` / `bun run smoke` | 均通过。 |
| Skill validator、文档相对链接/锚点、`git diff --check` | 均通过。 |

首轮默认套件发现 catalog 测试要求 Skill 必须包含逐步 `act --pid` 示例。这是文档措辞断言，命令注册本身已有独立检查；删除该过时断言后，catalog 18 项和上述完整默认套件均通过。

最终检查日志存放在 `/Users/phaethon/.cache/ya-skills-cua-upgrade-czma_vw2/` 的 `final-*.log`。这些检查在 GitHub/Homebrew 发布前完成。

## 原生验证的边界

source CLI 与打包后的 `dist/release/ya-skills/yk computer-use doctor` 均实际加载 0.47.24，确认同进程 driver 和 Accessibility / Screen Recording 权限可用。

另通过 source CLI 打开真实 session，在一次 `exec` 中计划执行 AX 表单填写、搜索字段值检查、AXPress 提交和最终观察。测试 fixture 使用 nonactivating panel，禁止成为 key/main window，忽略物理鼠标事件；本次为它增加了带 `Search notes` placeholder 的 NSSearchField。

首次 AX 观察收到驱动的 **`screen_locked`** 降级结果，流程在输入之前停止：`actions:[]`、`stateCommitted:false`。真实响应已通过新的窗口结果解码和 PNG 观察路径。`session close` 确认 `driverTerminated:true`、`leaseReleased:true`、`unresolvedRequests:[]`，fixture 通过控制文件退出。

没有绕过锁屏，也没有尝试前台激活或全局输入。原生表单的实际写入、提交、前台所有权变化以及前后耗时对照尚未完成，不能把上游 benchmark 当作 yk 的实测提速比例。

原生尝试的脚本和日志位于上述目录的 `native-check.py` 和 `native/`。解锁后，可在新的输出目录和新 session 中按同一流程验收：

1. `observe({mode:"auto"})` 应返回 usable AX，image unavailable，complete false。
2. 搜索字段应带 subrole `AXSearchField` 和 placeholder `Search notes`。
3. 在一次 exec 中写入三个表单值和搜索值，再用 `element_value` 等待正向匹配。
4. 用 AX selector 提交一次，等待 result 为 submitted；保留 action receipts 和最终观察。
5. 检查 fixture 状态、前台 PID、清理回执；分别记录调用耗时与模型往返时间。
