# software-factory PR #1316：内容与 ya-skills 参考

核查日期：2026-10-23。本文区分上游事实和本仓建议。只做资料调查，没有修改实现。

## 核查范围

[PR #1316](https://github.com/mattpocock/skills/pull/1316) 当前为 open、Draft，尚未合并。通过 GitHub API 核对：12 个提交，8 个文件，新增 522 行，无删除；head 为 `b59cab42bf1206e1363eafc37f71b21c3bcaa12f`。以下源码链接固定到此版本。[元数据 API](https://api.github.com/repos/mattpocock/skills/pulls/1316)、[文件 API](https://api.github.com/repos/mattpocock/skills/pulls/1316/files)。

实际变更：`SKILL.md`、`EXAMPLE-TASKS.md`、四份服务选型资料、in-progress README 和 changeset，全部是 Markdown。正文的行数估计已有变化，当前 `SKILL.md` 为 98 行。[完整变更](https://github.com/mattpocock/skills/pull/1316/files)。

## 上游提出什么

该 Skill 给远程 agent 工厂提供共同术语，供用户主动调用，并与 grilling 配合。它区分“工作种类” Task、“启动事件” Trigger、“一次执行” Run 和“一次执行所用的可丢弃环境” Runner。Run 可以包含多个 agent 会话；人工介入前结束，人的后续操作启动新 Run。持久记忆放在 tracker、git host 和 orchestrator。

服务按职责分槽：Ticket tracker、Ticket source、Git host、Orchestrator、Runner、Observability platform。同一产品可占多个槽；独立观测平台可明确留空。tracker 是人的交互入口；source 创建 ticket；orchestrator 接收触发、安排执行并记录状态。观测数据需要先转成 ticket 或 git host 上的记录，才进入自动工作链。

设计从用户的问题出发。先有检查、独立自动审查和人工审查，再逐个增加自动触发，并设置节流和循环上限。每个 Task 回答：谁触发；做什么及读写哪些服务；接着触发谁；人在哪里重新进入；如何避免两次执行做同一件事。每个 Ticket source 另答如何防止重复建票。资料：[固定版本 SKILL.md](https://github.com/mattpocock/skills/blob/b59cab42bf1206e1363eafc37f71b21c3bcaa12f/skills/in-progress/software-factory/SKILL.md)。

## 用一条链理解

```text
用户反馈 → 建票 → Explore → Implement → 独立 Review
                                      ├─ 通过 → 人工审查 → 合并
                                      └─ 失败 → Rework → Review
                                                次数到限 → 人工处理
```

实现任务通过检查后开 draft PR；审查任务读代码规范和原始需求；返工只修审查指出的问题。任务间用事件连接。大需求先拆分并记录依赖，实施时选择依赖已完成的任务。

三个可复用的维护例子：Ratchet 每天移除一个检查例外并开小 PR；Architecture 只列候选，交人选；Retro 抽样已合并 PR，提出工厂指令修改。Fix 处理工厂自身失败，但 Fix 自己失败时不再触发 Fix，避免自修复递归。资料：[EXAMPLE-TASKS.md](https://github.com/mattpocock/skills/blob/b59cab42bf1206e1363eafc37f71b21c3bcaa12f/skills/in-progress/software-factory/EXAMPLE-TASKS.md)。

## 四份选型资料怎么用

| 资料 | 分类重点 | 选型问题 |
| --- | --- | --- |
| [Ticket trackers](https://github.com/mattpocock/skills/blob/b59cab42bf1206e1363eafc37f71b21c3bcaa12f/skills/in-progress/software-factory/TICKET-TRACKERS.md) | git host 内置、agent 开发工具、开源、自用工作工具、repo 文件、自建 | 事件、路由、评论交互、身份、外部建票、托管方式 |
| [Git hosts](https://github.com/mattpocock/skills/blob/b59cab42bf1206e1363eafc37f71b21c3bcaa12f/skills/in-progress/software-factory/GIT-HOSTS.md) | 一体平台、套件、自托管、特殊审查模型、agent 原生、临时 git 存储 | webhook、身份、合并门槛、限流，以及还覆盖哪些服务 |
| [Runners](https://github.com/mattpocock/skills/blob/b59cab42bf1206e1363eafc37f71b21c3bcaa12f/skills/in-progress/software-factory/RUNNERS.md) | CI、microVM API、托管 agent、自带 worker、自管机器 | 谁管理 agent 循环和机器；启动、超时、并发、费用和清理 |
| [Observability](https://github.com/mattpocock/skills/blob/b59cab42bf1206e1363eafc37f71b21c3bcaa12f/skills/in-progress/software-factory/OBSERVABILITY-PLATFORMS.md) | 不另设平台、agent tracing、APM、模型网关 | 人需要看什么、如何导出、工具调用是否可见、费用与保留期 |

四份资料都标明调查时间为 2026-10，并要求实际选择时重新查官方资料。它们用于提出问题和辨认产品类型。本文没有独立核验其中全部产品、价格、beta 状态和数值，不将它们作为当前采购结论。

## 已确认的安装问题

[唯一的行内审查评论](https://github.com/mattpocock/skills/pull/1316#discussion_r4346725871) 指出 description 中的额外冒号会使 `npx skills install` 失败。当前 head 的 description 仍包含未加引号的 `: `。本地用 Ruby Psych 单独解析该 frontmatter，得到 `mapping values are not allowed in this context`，因此语法问题仍在。评论显示 Outdated 只说明评论对应的旧 diff 已变化。本文未运行完整 npx 安装流程。

PR 自述该 Skill 位于 `in-progress/`，按需调用，未进入正式插件分发；这限制了影响范围。采用其词汇与直接安装这份草稿，是不同的工程动作。[PR 说明](https://github.com/mattpocock/skills/pull/1316)。

## ya-skills 已有什么

| 现有能力 | 本仓证据 | 对上游模型的关系 |
| --- | --- | --- |
| Leader 派工、依赖、验收与文件交接 | [ultra-produce](../../skills/ultra-produce/SKILL.md) | 已承担单次流程中的编排职责 |
| state、task、result、handoff、checkpoint、recovery | [协议](../../skills/ultra-produce/references/protocol.md)、[恢复规则](../../skills/ultra-produce/references/execution.md) | 已支持新 agent 从文件恢复；当前持久状态依赖本机共享文件与绝对路径 |
| 有限返工 | [停止条件](../../skills/ultra-produce/SKILL.md) | 已有最多 3 轮修复、连续 2 轮无进展提前停止 |
| 并发互斥 | [prepare](../../skills/ultra-produce/scripts/pipeline.py)、[bind](../../skills/ultra-produce/scripts/pipeline.py) | 已阻止同一 run 内重复活跃 task、同 unit 的并行 Builder，以及同 agent 同时绑定多个活跃 attempt |
| 独立审查与证据核验 | [ultra-cr](../../skills/ultra-cr/SKILL.md) | 可以承担 Review Task 的内容 |
| 失败捕获、重放、比较 | [pbench](../../skills/pbench/SKILL.md) | 是评估能力；捕获先经用户批准，私有材料不进入重放输入 |
| 单一事件写入与结果归约 | [supervisor](../../packages/functions-computer-e2e/src/supervisor.ts)、[reducer](../../packages/functions-computer-e2e/src/result-reducer.ts) | 已有可审计运行证据；领域是桌面测试 |

这里的对应是分析结论。ya-skills 的 `task-id` 表示具体派工记录，上游 Task 表示可反复执行的工作种类；不能因名称相同就当作相同对象。

## 建议，尚未实施

1. 先写一页共同术语与服务映射，明确 ya-skills 目前的执行范围。保留已有领域名称，通过映射说明关系。
2. 为常用流程补上五个 Task 问题。重点查“不同顶层 run 同时处理同一 ticket 或同一 PR”时的认领边界；现有锁已覆盖 run 内部分重复执行，不能说项目没有去重。
3. 保留现有返工上限、独立审查和证据验收。若以后加自动入口，逐个开通并节流，再依据真实失败记录调整。
4. 若以后支持远程 Runner，先验证另一台机器能恢复同一工作；需要处理状态存放、产物寻址和绝对路径。当前能换 agent 恢复，尚不能据此断言能换机器恢复。
5. 可把 Ratchet 作为后续维护候选：每次消除一个明确例外，开小 PR，检查防止重新引入。先确定真实例外清单与验收，再决定是否需要定时触发。

6. 可用 PBench 为流程改进提供回放证据：在获得捕获授权并完成案例整理后，对同一组案例比较改进前后的结果。案例验收标准与输入边界保持稳定。

这些建议用于评估后续设计。本次未要求建设 ticket 服务、远程执行平台或自动发布链。
