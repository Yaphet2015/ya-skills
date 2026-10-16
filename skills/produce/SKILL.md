---
name: produce
description: "Lightweight implementation workflow: subagent planning with brainstorming and grill-with-docs, independent first-principles challenges, implementation with simplify after each part, then testing. Use to deliver a requirement with simple architecture and user consultation on interaction changes."
---

# Produce

由主 Agent 推进：**Plan（subagents）→ Subagents Challenge → Impl（每部分完成后 simplify）→ Test**。所有 subagents 由 Main Agent 使用宿主原生工具启动，模型沿用宿主或用户配置。

本流程使用宿主已安装的 `brainstorming`、`grill-with-docs` 和 `simplify`。进入相应阶段前读取实际 `SKILL.md`，确认其声明的必要依赖；缺失时说明所缺 Skill，暂停依赖它的步骤。

## 决策边界

- 技术架构以 **SOLID、DRY、KISS、YAGNI、SSOT** 为原则，力求简单、干净：复用已有边界和单一事实来源，减少独立状态、同步责任及无必要的抽象与依赖。技术待决问题由规划 subagents 提供选项、依据和建议，与 Main Agent 讨论后确定；执行者在已定方案内自主处理实现细节。
- 用户体验行为的选择由 Main Agent 咨询用户。涉及尚未确认的操作流程、界面响应、默认行为或错误提示，先说明前后差异、影响和推荐方案，获得结论后实施该部分。沿用用户已经明确的要求和决定，等待时推进独立工作。

## 1. Plan

Main Agent 启动规划 subagents，提供用户目标、约束、已确认的决定和必要代码位置。规划代理读取项目规则与相关实现，使用 `brainstorming` 和 `grill-with-docs` 完善需求、方案及文档；本阶段只规划，不修改产品代码。

规划代理将待决问题、选项、依据和推荐方案交 Main Agent 讨论。技术选择按上述原则共同确定；用户体验行为问题由 Main Agent 汇总后咨询用户，再将结论交回规划代理。

规划代理交付足够实施的计划：目标、范围、现有行为、验收条件、修改边界、关键技术选择、实现步骤和验证方法。Main Agent 与规划代理解决关键分歧后，形成唯一计划，详细程度与任务规模相称。

规划 Skill 的问答和交接遵循本流程的决策边界；Plan 完成后进入下方独立挑战阶段。

## 2. Subagents Challenge

Main Agent 启动独立于规划代理的挑战 subagents，将用户目标、约束、计划和必要代码位置交给挑战者。使用以下任务意图：

> Challenge this plan from a step back. Go first principles.

让挑战者检查：需求和假设是否成立；是否存在更小的实现；状态归属与接口是否清楚；是否遗漏用户行为、失败场景或验收用例。各自独立分析后再汇总，给出具体依据和可执行建议；没有发现问题时如实说明。

Main Agent 将挑战意见交规划代理共同讨论，简短记录采纳或拒绝的理由，由规划代理修订计划。涉及未定体验行为时，由 Main Agent 咨询用户。关键问题解决后进入实现。宿主无法启动子代理时，如实说明能力限制并暂停需要子代理的阶段，不能把主 Agent 自行规划或自审算作已完成相应阶段。

## 3. Impl

按修订后的计划实现，保持边界清楚、改动集中，保护用户已有工作。主 Agent 可直接实施；确有独立工作时按依赖派工，共享文件指定唯一写入者。

每个部分实现完成后，由负责该部分的 Agent 使用 `simplify` Skill 简化本次新增或修改的代码，保持功能和用户行为不变；完成该部分的简化后，再继续下一部分或进入 Test。派工时将这一步写入子任务要求。

把挑战中确认的关键行为纳入实现与测试，不随实现降低验收标准。新证据推翻关键方案时，由规划代理与 Main Agent 讨论并更新计划；出现未确认的交互变化时先咨询用户。完成后检查 diff。

## 4. Test

对照目标、验收条件和挑战发现，运行项目要求及本次改动相关的检查。测试应验证行为，覆盖适用的正常路径、边界和失败场景。

失败时先定位原因，修复产生的新改动同样先执行 `simplify`，再重跑受影响的检查，并复用仍有效的结果。环境缺失、中断或未执行的检查须明确说明，不能记为通过。

交付简短说明：完成内容、实际运行的检查及结果、剩余问题。
