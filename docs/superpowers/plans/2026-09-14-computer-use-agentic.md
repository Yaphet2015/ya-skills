# Computer Use Agentic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供 AX 优先、视觉兜底、短批次、持久会话和 JavaScript 执行，减少模型往返而不丢失执行结果。

**Architecture:** desktop primitive 和预算集中于 computer-runtime；computer-session 管理进程、IPC 和请求记录；functions-computer-use 提供 CLI。外部 LLM 决定动作与视觉目标，yk 不调用模型，不增加脚本审计或权限系统。

**Tech Stack:** Bun 1.3.14 基线、TypeScript、Cua Driver 0.27.0、macOS arm64、同用户 Unix socket、JSONL、现有 compiled yk 自启动。

**Spec:** `docs/superpowers/specs/2026-09-14-computer-use-agentic-design.md`

## Global Constraints

- 脚本按受信本机代码执行，不建设 VM、容器或 OS 权限沙箱。
- 本轮支持 JavaScript；不同时建设 Python/Playwright 第二套桌面后端。
- desktop primitive 只在 computer-runtime；SDK 继续 lazy load，help/list/install 不加载 native。
- 不要求 Homebrew 用户额外安装 Node/Bun。
- E2E 默认测试保持 desktop-free；保留 events.jsonl 的 SSOT。
- batch 串行执行；delivered 不等于业务成功，unknown 不能自动重放。
- 默认不缩图，不自动抢前台；图像有效性和 AX 有效性分别报告。
- 跨包用 workspace import；领域实现不放进 packages/cli。
- 规划阶段约束（历史）：实施与真实桌面验证必须分开进入执行阶段并明确测试窗口；本次集成的实际命令与结果只以 `docs/verification/2026-09-15-parallel-integration.md` 为准，不把未运行的计划命令当作证据。

> **Integration status (2026-09-15):** The four current lane deltas have been applied to checkpoint `82722ea5e9ab4021b521def8dcae4cf703fe493f` and the desktop-free/release gates are recorded in `docs/verification/2026-09-15-parallel-integration.md`. This is an uncommitted integration delta, not whole-plan completion: native Background/TCC/session acceptance and real model/performance evidence remain blocked by the no-disruption rule. Unchecked native and performance tasks below remain open.

---

## 1. 顺序与产物

| 顺序 | 子计划 | 交付 |
|---|---|---|
| A | [桌面基础](2026-09-14-computer-use-desktop.md) | 新观察接口、视觉坐标点击、可选缩图、受限 batch、本地等待、旧接口兼容 |
| B | [持久会话](2026-09-14-computer-use-sessions.md) | 同用户 session 宿主、driver 复用、请求去重、目标占用、取消与关闭 |
| C | [代码执行](2026-09-14-computer-use-exec.md) | JS worker、宿主 RPC、JSON state、硬超时、API 文档、性能验收与打包回归 |

A → B → C 串行交付。A 可独立使用，不等待 B/C。代码执行全部纳入，不留作不确定的未来选项。

每个任务执行：失败测试 → 最小实现 → 定向测试 → 类型检查 → 检查 diff → 单任务提交。任何原生能力探针失败应停止受影响任务并记录证据，不能把未验证能力标记完成。

## 2. 规划时已核实的代码事实

- 当前 HEAD：`8e1f3fa`。规划开始时只有研究报告和设计草案未跟踪，没有实现改动。
- `packages/functions-computer-use/src/args.ts` 的 parseActSpec 只允许单动作。
- `commands.ts` 在 act 后 snapshot，在 finally 关闭 session。
- `session.ts` 的 Computer.click 解析 AX token；Backend.clickToken 不提供坐标。
- SDK 类型 `dist/native/cua_driver_contract.d.ts` 已有 ClickPosition.Coordinates、maxDimension、screenshotWidth/Height/Scale、screenshotFrameValid、windowBounds、VerifyStateInput。
- SDK WindowElement 当前没有通用 focused 字段；selected 不能当作 focused。不得凭空添加一个始终为 true 的焦点检查。
- SDK README 说明 implicit session 五分钟无活动可能结束；复用 Bun 进程不等于能无限复用原生 session。B 将空闲上限定为两分钟，避免依赖该失效窗口。
- `scripts/package-release.ts` 必须传 `--version`；验证命令见 C，不省略这个参数。
- 现有 E2E supervisor 已有 compiled 自启动和进程组清理，但包含 suite 特有语义，不能直接复制整份。
- `scripts/generate-computer-e2e-api.ts` 目前有显式类型列表和简易提取器；新增 union 必须增加生成产物编译测试，不能只看生成成功。

这些是静态检查，不是桌面实测或发布验证。

## 3. 公开命令契约

旧的 doctor/apps/windows/perceive/act 保持行为；增加独立 observe 避免静默改变严格 snapshot 语义。

```sh
# 新观察：auto 先读 AX，AX 不足时才请求截图；需要视觉证据可指定 both
# 必须返回 observationId、目标、时间、AX状态、图片状态和坐标元数据
yk computer-use observe --pid 123 --window 456 --mode auto
yk computer-use observe --pid 123 --window 456 --mode both --max-dimension 1600

# 视觉坐标点击，x/y 是该 observation 图片上的像素
yk computer-use act --pid 123 --window 456 --click-x 500 --click-y 300 --observation ID

# batch 文件内不重复目标；request-id 是去重键
yk computer-use batch --pid 123 --window 456 --file steps.json --request-id REQUEST

# 长会话一次绑定一个窗口；idle-timeout <= 120000ms
yk computer-use session open --pid 123 --window 456
yk computer-use session status --session SESSION
yk computer-use observe --session SESSION --mode both
yk computer-use batch --session SESSION --file steps.json --request-id REQUEST
yk computer-use session cancel --session SESSION --request-id REQUEST
yk computer-use session close --session SESSION

# 代码内容读取后按 hash 固定，worker 不重新读取可变化的源码文件
yk computer-use exec --session SESSION --file flow.js --request-id REQUEST
```

- 不能同时指定 `--session` 和 `--pid/--window`。
- batch/exec 必须提供 request-id；同内容重试查询结果不执行。单步 act 仍保留历史无去重契约，报错提示先观察而非重试。
- batch 默认最多 5 步，`--max-actions` 可提升至 20；整体默认 30s，上限 120s。exec 默认 60s、100 个 facade 动作，上限分别 120s、500。
- observe 默认返回清洗后的完整 AX；可选结构化 selector 限定返回元素，不做不可验证的 LLM 摘要。必须附 total/returned/complete，零匹配不代表整个窗口为空。
- 不增加数值置信度。依赖动态状态的下一步交回 LLM；已知步骤在本地执行。

## 4. 模块图

```text
functions-computer-use: 参数、JSON文件、CLI envelope
                  ↓
computer-session: 请求/事件/生命周期/脚本worker
                  ↓
computer-runtime: observe、clickPoint、batch、原生driver
                  ↑
functions-computer-e2e: 复用同一 Computer API
```

新增模块仅用于已确认职责。A 的 types 放进 runtime/src/types.ts，便于生成公开声明；内部 RawWindowState、IPC 信封等不暴露给 E2E 套件。

## 5. 执行前需要锁定的探针结论

A1 必须取得以下事实并写入 verification 文件：

1. Window-target 坐标的原点和单位，Retina 与截图像素关系。
2. AX 不完整时是否可以获得有效图像及 windowBounds。
3. Background 坐标点击支持与拒绝情况；不允许自动 foreground 重试。
4. 新 session 宿主的 macOS 权限归属；不在规划中假定子进程继承一定有效。
5. compiled yk 是否能执行捕获后的 JS 字符串、完成私有 IPC 并被硬终止。

默认策略：保存同一帧原始 PNG，显式缩图使用 macOS 自带 `/usr/bin/sips` 生成派生图，避免新增 native 图像依赖。SDK maxDimension 已声明但不直接默认启用，因为还需验证其坐标语义，且要保存同帧原图。sips 工作不在主事件循环同步执行，默认不缩图时不启动它。

这是受平台约束的最小实现选择；如果探针证明不适用，应先修订该任务和证据，而不是随意引入第二个 native runtime。

## 6. 规格覆盖

| 设计要求 | 实施任务 |
|---|---|
| SDK/坐标/后台能力证据 | A1 |
| AX 与图片独立有效性、按需观察 | A2 |
| 缩图、窗口坐标映射、观察持久化和失效 | A3 |
| AX/视觉点击、投递正确性 | A4 |
| batch、本地条件等待、精简输出 | A5 |
| CLI/E2E 兼容、生成声明 | A6 |
| session 协议、driver 复用 | B1–B2 |
| 去重、事件、目标占用与崩溃 | B3 |
| CLI/self-spawn/分发 | B4 |
| JavaScript、RPC、显式状态 | C1–C2 |
| 超时、取消、未知投递 | B3、C3 |
| skill/API文档/示例 | A6、B4、C4 |
| 发布验证和性能指标 | C5 |
| 无模型调用、无额外脚本审计 | B1、C1、C4 |

## 7. 完成口径

- 文档生成不等于 API 可编译；增加编译检查。
- 单元测试不能证明原生后台点击、Retina 换算或 TCC 工作；保留独立实机门禁。
- Token 只取真实 usage，未提供标 unknown；不从图片字节数推算。
- 状态恢复不承诺 exactly-once 原生副作用，只保证不会自动重复下发未确认请求。
- 有意跳过的发布测试、缺少测试窗口和不支持的平台都列入结果，不说“全部通过”。
