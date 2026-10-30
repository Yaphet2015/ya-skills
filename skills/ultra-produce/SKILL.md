---
name: ultra-produce
description: Deprecated. Coordinate native Planner, Builder and Verifier subagents through implementation and testing, with file-based handoffs, stage hooks and local commits. Use for an end-to-end delegated implementation workflow.
---

# Ultra Produce

> **Deprecated（已弃用）。** 新任务请显式调用 `/bankai`。Bankai 已自带执行器、登记工具和恢复协议，无需安装 Ultra Produce。

Main Agent（下文称 Leader）负责任务流转：派工、依赖、文件交接、状态、Hook、证据验收和用户沟通。不限制其宿主或模型；规划工作交给独立 Planner。向用户用简短中文报告进度、决策和阻塞。

全部角色使用宿主原生 subagent，由 Leader 统一创建、发送消息、观察、续接或替换及回收。模型和 Provider 沿用宿主默认或用户指定值。Planner、Builder 和被调用 Skill 需要独立代理时，写任务卡与派工请求，由 Leader 代派；阶段主导者直接读取结果文件并形成结论。

统一根目录为 `~/.ya-skills/ultra-produce/`：内部状态、任务、交接、分析、日志与证据写入 `logs/<run-id>/`；正式 Plan、HTML 报告与复盘写入 `reports/<project>/<branch>/<run-id>/`。项目名取项目声明，不能取目录名；分支名取实际 Git 状态。具体布局与文件通信见 [运行与交接协议](references/protocol.md)。

## 启动

先读 [运行与交接协议](references/protocol.md)。使用随 Skill 安装的 `scripts/pipeline.py`；所有路径解析为绝对路径。

1. 确认 Leader 能实际创建、观察和结束原生 subagent，并共享本次运行文件；无需多层派生或 resume 能力。读写任务与结果文件，按宿主规则处理权限请求；不检查或切换 Main Agent 模型。
2. 执行 preflight，检查 Git、Python 和全部指定 Skill。缺失即报告并结束；不安装、不替代、不跳过。尤其不得把 `ultra-cr` 改成 `ultrareview`。再检查各 Skill 文档声明的必要依赖、当前任务执行工具和权限。
3. 在实施前运行任务相关的最小基线检查和类型检查，核对必要依赖、产物目录与提交 Hook 的可用性；记录既有失败及影响。只读检查不能证明原生派生或写权限已经可用，遇到实际权限限制按宿主规则处理。检查通过后 init。记录任务目标、起始 commit、已有改动和授权的测试目标。用户原有改动不得被覆盖、回退或提交；无法分离时报告具体阻塞。
4. 当前调用授权按本流程执行相关测试及修复后的重测；不扩展到无关应用或外部发布。真实桌面测试严格限于本需求对应目标。不绕过宿主权限限制。

代码和维护方案由 Planner 依据 KISS、DRY、YAGNI、SOLID、SSOT 给出，Builder 负责计划内的实现细节；Leader 核对决定与需求、验收和证据一致后推进。涉及接口、架构或验收的技术争议，Leader 路由给 Planner 形成结论，不在主会话重新设计。交互体验的未定选择由 Leader 汇总后询问用户；等待期间推进独立任务。

## Plan

执行 **Before Plan**，然后按以下顺序：

1. **Leader 启动独立 Planner。** 用 `prepare --role planner` 准备任务，再用宿主原生工具派生并 `bind` 实际 agent ID。传入任务文件绝对路径，任务内保留整体目标、现有证据及共享约束。Planner 使用 `/brainstorming` 和 `/grill-with-docs` 完善需求、验收与方案。
2. **总 Planner 判断 BFS 条件并完成边界拆分。** 实现新机制，或者需求非常复杂、范围广且改动量大时，先确定同层模块的职责、依赖与接口，再深入下一层；达到可独立规划与验收时停止。普通需求由此 Planner 直接完成规划。记录判断依据；复杂任务的边界产物先作为已完成的规划子任务交付。
3. **Leader 按边界派模块 Planner。** 需要模块规划时，每个模块用独立 task-id 和同一原生派生协议，使用 `--after` 引用已验收的边界子任务。已有规划与待挑战事项通过文件传递，不重复调查。收齐模块产物后，总 Planner 从交接文件恢复并整合；Leader 只传路径，不自行重写方案。
4. **Leader 要求 Planner：** “spin up subagents to challenge this plan from a step back，go first principle”。Planner 将挑战任务卡、派工清单和完整交接写入文件，以 needs_decision 结束本轮；Leader 代派独立挑战者。挑战者检查需求必要性、假设、遗漏、复杂度和更小实现，完整意见及回执直接落盘，最终只返回任务 ID、状态、回执路径。收齐结果后，Leader 续接或新建 Planner，并提供恢复入口；Planner 自行读取独立产物、处理意见后交付，不能用自评冒充挑战。
5. 总 Planner 交付唯一最终 Plan，解决跨模块冲突，明确接口、任务依赖、并行范围、提交单元与测试方案。Plan 同时交付可直接派发的小任务卡；Builder 不再接收“重新拆分并实施全部计划”的任务。Leader 核对阶段验收摘要与证据索引后放行；模块 unit 仅用于归属和纠正作用域。挑战暴露边界错误时，由 Planner 修订受影响 BFS 分支。

完成门槛：交互决策已确认；关键技术问题已决策；挑战意见有处理结论；每项任务有验收条件；接口无未解冲突。保存 Plan 版本，执行 **After Plan**。未来 Plan 有实质变化时保留旧版本并重新执行此 Hook。

## Impl

执行 **Before Impl**。Leader 使用原生工具启动 Builder，按 [角色任务](references/roles.md) 派工。Leader 与 Builder 先读 [执行控制](references/execution.md)，使用其中的完整交接、检查点、纠正确认和验收命令。

- 按 Plan 分阶段、按功能模块实现。依赖满足且修改范围互不冲突时，保留“Builder spins up subagents to impl”的任务意图：Builder 写局部任务卡，由 Leader 代派实现子代理；共享文件或接口修改串行。
- 每块功能完成后先 `/simplify`，运行相关检查，再本地 commit，**不 push**。
- 先固定独立挑战指出的关键行为用例。不得随实现一起改写这些用例的预期；确需改变契约时由 Leader 交 Planner 对照原需求评估，涉及交互体验再问用户。测试数量不能代替逐项行为证据。
- Leader 使用宿主完成通知，按需读一次精简 `status`；不逐分钟轮询日志、源码或 diff。子任务完整结果由 Builder 直接读文件，Leader 只接收派工元数据、状态、路径和阶段验收摘要；具体异常才定点展开证据。阶段主导者结束每轮前必须发布完整交接和检查点，按新会话仅靠文件即可恢复来设计。
- 说明/回执补正用原任务的 `prepare --redeliver` 建立独立 attempt，优先续接原生 Builder；无法续接时记录原因并以文件恢复新代理，保留旧证据；任务卡按 [模板](references/builder-task.md) 提供局部契约。
- 纠正通过 `correct` 发布，Builder 用 `ack` 确认版本，提交前执行 `gate`；追加任务文件不代表送达。Leader 检查证据后执行 `accept`，未处理的纠正或变化的证据阻止验收。
- 并行工作者不得操作共享 Git index。Builder 检查 diff、串行暂存明确文件或 hunks 后提交，不能 `git add .` 混入已有改动。
- Leader 原生派生能力缺失时返回 blocked，不能声称已派生；执行槽不足时按原依赖分批派工。独立挑战仍须由独立代理执行。
- 修改验收条件或模块边界须返回 Leader，必要时重回 Plan。Builder 不能自行降低验收标准。

完成门槛：任务有实现及 commit，检查通过，必修问题关闭，剩余改动归属明确。简化任务还须核对删除的独立状态、搬运与同步责任，以及新增适配成本；不能只报告行数。独立模块稳定后可提前由 Ultraviewer 审查固定提交，不修改工作区；最终 Verify 复用仍有效的证据并补齐集成检查。执行 **After Impl**。

## Verify

执行 **Before Verify**。每轮验证拆为可恢复任务，Leader 负责派发，Verifier 原生 subagent 负责验证方案和最终结论：

1. `verify-plan-rN`：Verifier 核对最终 Plan、起始 commit 到当前 HEAD 的完整 diff、本次未提交改动，交付验证任务卡和初始覆盖矩阵。逐项记录验收条件、变更模块、用例、预期、执行方式与证据要求；无法测试的项说明原因。先核对已有审查和测试的适用范围，列出可复用证据及待补部分。
2. Leader 验收后，按任务卡派发 `verify-review-rN`（Ultraviewer）和 `verify-tests-rN`（e2e-Tester），均以 `--after verify-plan-rN` 绑定依赖，子任务完整产物由 Verifier 直接读文件。Ultraviewer 使用 `/ultra-cr` 和 `/eli10`；e2e-Tester 执行矩阵中的适用测试，桌面交互用 `/computer-e2e`。修改范围互不冲突时可并行。结果由 Leader 验收，修复建议及时向用户报告。
3. `verify-final-rN`：Leader 启动 Verifier，并以 `--after` 绑定本轮方案、审查和测试的实际验收任务。Verifier 核对 Plan 版本、代码范围、证据有效性和未解决问题，补齐矩阵并交付结论。此任务只汇总和核对，不等待或重启长时子任务；缺项返回具体待补任务。
4. 审查或测试失败，Verifier 给出修复任务，Leader 交 Builder 修复、simplify、检查、commit。下一轮复用仍有效的证据，补查修复 diff、受影响测试及必要回归。补充测试文件归入 Builder 检查和提交范围，提交后绑定最终 commit 复核证据，不降低断言。

每个任务有独立结果、逻辑归属及实际原生 agent ID。恢复时只重跑失败或证据失效的部分，引用实际 task-id，不重放已完成任务。内部拆分不增加验证轮次；Before/After Verify 仍按一次逻辑验证轮次执行。
每次验证尝试结束均执行 **After Verify**，失败也产出真实状态报告。修复重新进入 Impl/Verify，执行对应 Before/After Hook。

最多 **3 轮修复**（不含初次实现）。连续 **2 轮**未减少问题且无新增有效诊断证据时提前停止。Leader 维护未解决问题 ID 与新增证据，不能仅凭 Agent 声称“有进展”。

累计时间和执行重试预算账本移除；模块归属、任务历史、检查点、补交限制及上述验证停止条件保留。

成功门槛：验收与变更均有覆盖，必需测试通过，必须修复项关闭，其他建议有责任角色的技术结论并由 Leader 记录处理结果。跳过、中断、缺少环境不能算通过。Plan 或代码变化使相关旧证据失效。

## 收尾

读 [Hook 约定](references/hooks.md)。每次写 Plan、报告或复盘前读取实际目标目录及父目录链的 AGENTS.md，使用本工作流指定的统一布局，并遵守目标内容和写作规则。成功或终止结案前执行 **Before Finish**；preflight 失败直接结束。Hook 失败阻止成功结案，修复后只重试失败部分，不重复实现或 commit。

最终向用户报告：成功/失败/阻塞、完成范围、验证证据、剩余问题、Plan/报告/复盘链接。不得把缺失的产物或未运行测试写成已完成。
