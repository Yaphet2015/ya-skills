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

### R1 · <observable behavior> [<priority and reason>]

- 环境：<environment-card reference plus case-specific differences; verify running build identity>。
- 前置：<data, state and fixture setup, or precise blocker>。
- 步骤：
  1. <exact user entrypoint>。
  2. <action that reaches the changed path>。
  3. <action that exposes the result>。
- 观察与判定：<where to look and a decisive pass/fail condition>。
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
```

Group paths only when all members and their common reason remain explicit. With more than ten cases, use a small index linking every surface sheet and identify the first three cases across the set.

## Baseline note

Record repository root, branch, HEAD, date, selected files/behavior, dirty state, and comparison context. Preserve the relevant diff or file snapshot if dirty so later edits do not erase the evidence. Keep the snapshot limited to the behavior under review.

For each behavior, record entrypoint, prerequisites, before-change claim with `[E]`, `[R]`, or `[?]`, code evidence, and a pending manual observation step. Record an actual observation only when provided, with observer, build/environment, result, and artifact. Preparing a baseline note does not mean the baseline was run.

## Again / retest note

Link the previous sheet, its compared SHAs/dirty snapshot, user results, and the current comparison. If the prior head cannot represent the previous dirty contents, disclose that limit before claiming what changed since the sheet.

Keep stable IDs and original results as attributed history. List the selected retest IDs and why each is selected (failure, unblocked prerequisite, newly changed path, adjacent behavior). Current-build statuses start unchecked. If no results were supplied, report “上次结果未知”; do not call unchecked cases failed. Account for new files and newly introduced behavior even when they were not in the previous sheet.
