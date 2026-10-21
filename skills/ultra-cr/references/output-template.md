# Final Review and Evidence Rules

Write the final review in Chinese to the Phase 7 `final.md` path returned by the helper. Also write `decision.json` using `references/session-state.md`. The prose, machine decision, ledger and verification results must agree.

## What Belongs in the Main Findings

Publish confirmed defects with a concrete consequence: wrong behavior, security failure, data loss, regression, a traceable performance cost or a broken documented contract. Each needs an exact repository-relative file/line, trigger, impact, checked evidence and a minimal repair.

Pure naming/style preferences, optional cleanup, generic refactors, line-count objections and change descriptions do not belong in the main list. A repository rule violation qualifies when the report explains its practical consequence. Keep raw comments, excluded entries and reasons in the ledger/raw reports, with counts and links in the final report.

Preserve minority evidence without taking a vote. Independent agreement is useful for navigation, but neither a majority nor reviewer seniority proves a defect. A proposed blocker blocks only after independent batch verification returns CONFIRMED or REFINED with evidence. An unreturned verifier yields UNVERIFIED.

Pre-existing problems stay separate and do not affect the PR verdict unless the change introduces or exposes the failure path. A speculative high-severity claim belongs under "待验证" with its missing evidence, not under confirmed blockers.

## Verdict

| Evidence | Verdict |
|---|---|
| At least one independently confirmed blocker | `REQUEST_CHANGES` |
| No confirmed blocker, meaningful uncertainty remains | `INCOMPLETE` |
| Confirmed non-blocking issues, no meaningful uncertainty | `FINDINGS` |
| Full assigned coverage and no meaningful issues/uncertainty | `NO_FINDINGS` |

A review result is not a human approval. State missing coverage even when another verified issue already justifies REQUEST_CHANGES.

## Suggested Final Shape

```markdown
# 代码审查

已确认 {N} 条问题；待验证 {M} 条。结论：{verdict}。

审查范围：{scope}；目标：{target}；比较起点：{merge-base SHA}；审查提交：{head SHA}。

## 已确认的问题

### F1 · {标题} · {严重程度}

- 位置：`src/file.ts:42-48`
- 触发条件：{可到达的输入或调用顺序}
- 影响：{具体错误或损失}
- 依据：{代码/契约/测量位置；独立验证结果}
- 修复：{最小可行修复}

## 待验证

- F3：{疑点}；缺少：{事实或契约}。依据：{路径和原始报告}。

## 覆盖与记录

{已审查的风险和必要边界；未覆盖范围；推定的需求；失败或跳过的验证。}

已排除 {K} 条风格/清理/误报/重复项。原始报告、findings.json 和 verification-summary.md：{链接}。
```

Omit empty sections. If there are no confirmed findings, say "未发现已确认的问题" plainly. Keep requirements assessment when supplied requirements need a separate acceptance decision. Do not fill the report with positive confirmations or a full list of every reviewer comment.

For large reports, read source summaries first and retrieve details by stable finding ID. If outputs are partially lost, recover the affected files or write an explicitly incomplete report. Always preserve original evidence when revising a description.
