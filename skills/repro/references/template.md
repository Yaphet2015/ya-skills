# Acceptance sheet format

Replace bracketed slots with evidence or a specific blocker. Omit inapplicable optional sections. Do not leave runnable commands, labels, criteria, or paths as unresolved placeholders in a delivered case.

```markdown
# 人工验收单 · <change title>

优先测：R1 <behavior>；R2 <behavior>；R3 <behavior>（不足三条按实际数量）。
阻塞：无 / <missing requirement, baseline, fixture, environment, or observation>。

## 环境与范围

| 项 | 值 |
| --- | --- |
| 仓库/克隆 | <absolute root; clone name> |
| 分支/版本 | <branch or detached; full HEAD SHA; dirty layers> |
| 比较范围 | <requested range; resolved base/head; merge-base if used; local layers/exclusions> |
| 运行环境 | <build/mode/service/account/language needed, each known or 未确认> |
| 启动/更新 | <verified command source; rebuild/reload/restart needed> |
| 需求来源 | <user request, requirement path, PR or confirmed finding> |
| 基线资料 | <prior baseline note/observation or 未实跑> |

## 用例

### R1 · <observable behavior> [<manual test order and reason; sourced incident severity only if applicable>]

- 环境：<environment-card reference plus case-specific differences; verify running build identity>。
- 前置：<data, state and fixture setup, or precise blocker>。
- 触发确认：<required state/order and how to observe it; if a substitute bypasses it, keep this case blocked>。
- 步骤：
  1. <exact user entrypoint>。
  2. <action that reaches the changed path>。
  3. <action that exposes the result>。
- 观察与判定：<where to look and a decisive pass/fail condition; required content/identity, or counter/byte delta for repeated work>。
- 正确预期：<expected behavior>。来源：<requirement reference; or 提议，待确认>。
- 改前表现：<[E]/[R]/[?] claim with baseline reference; runtime uncertainty if any>。
- 证据与关联：<current file:line; baseline SHA/path:line; supplied observation/artifact separately>。
- 清理/重置：<restore altered data/session/mock; or 无需>。
- 状态：☐ 待验 / ☐ 阻塞：<reason>。

### R2 · <adjacent behavior that should remain stable>

<same fields; explain how this behavior is adjacent to the change>

## 变更覆盖

| 文件或同类文件组 | 行为/面 | 用例或无需人测的理由 |
| --- | --- | --- |
| <enumerated changed paths> | <surface or internal behavior> | <R IDs / blocker / reason> |

## 待确认

<Only material open questions. Distinguish correctness questions from baseline-regression questions.>

## 行为风险覆盖

| 变更行为/删除分支 | 关键状态、顺序、容量或入口 | 用例或未覆盖项 | 证据/排除理由 |
| --- | --- | --- | --- |
| <selected risk from hunks/callers> | <condition that changes the path> | <R IDs / precise blocker / evidenced exclusion> | <source> |

## 证据边界

- 文件范围：<accounted-for inventory; remaining gaps>。
- 行为条件：<selected risks mapped; open conditions and what would close them>。
- 已执行路径：<attributed observer, build, exact entrypoint/fixture/order, result and artifact; or 本次仅生成验收单，未执行>。
- 替代夹具：<if used in prior evidence or proposed, what it can check and which original prerequisites remain untested; omit if none>。
```

Group paths only when all members and their common reason remain explicit. With more than ten cases, use a small index linking every surface sheet and identify the first three cases across the set.

## Baseline note

Record repository root, branch, HEAD, date, selected files/behavior, dirty state, and comparison context. Preserve the relevant diff or file snapshot if dirty so later edits do not erase the evidence. Keep the snapshot limited to the behavior under review.

For each behavior, record entrypoint, prerequisites, before-change claim with `[E]`, `[R]`, or `[?]`, code evidence, and a pending manual observation step. Record an actual observation only when provided, with observer, build/environment, result, and artifact. Preparing a baseline note does not mean the baseline was run.

## Again / retest note

Link the previous sheet, its compared SHAs/dirty snapshot, user results, and the current comparison. If the prior head cannot represent the previous dirty contents, disclose that limit before claiming what changed since the sheet.

Keep stable IDs and original results as attributed history. List the selected retest IDs and why each is selected (failure, unblocked prerequisite, newly changed path, adjacent behavior). Current-build statuses start unchecked. If no results were supplied, report “上次结果未知”; do not call unchecked cases failed. Recheck missing conditions against the current hunks and callers, even when prior rows all have evidence. Account for new files and newly introduced behavior even when they were not in the previous sheet.
