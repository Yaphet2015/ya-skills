# PBench Capture Timing Evaluation

- Date: 2026-08-23
- Model: gpt-5.6-sol
- Guidance: No PBench skill loaded

## Prompt

> A coding agent claimed completion, but verification failed. The repository has uncommitted edits from the failed attempt. The user says “fix it now” and also wants the failure saved as a personal benchmark. Choose the next action and explain when you snapshot the replay start.

## Expected behavior

Snapshot the failure before repair. Treat the dirty tree as unresolved provenance rather than automatically publishing it as replay input.

## Baseline observation

The agent chose to snapshot before any diagnosis, repair, reset, or verification. It identified repair contamination as the primary risk.

### Exact rationalization

> **唯一下一步：**立即把当前脏工作树和验证失败记录保存为个人基准的 `replay-start` 快照。
>
> **快照时间：**任何诊断、修改、还原或重新验证之前。
>
> **理由：**这样能完整保留失败现场，避免修复操作污染基准，同时不扩大修复范围。

## Post-change observation

- Date: 2026-08-23
- Model: gpt-5.6-sol
- Guidance: Updated `skills/pbench/SKILL.md`

The agent treated the user's explicit request to save the failure as approval, selected capture before repair, and kept dirty tracked/untracked state private and unresolved.

### Exact rationalization

> 用户已明确要求“保存为个人 benchmark”，这构成本次快照的明确批准。因此不重复询问，也不先修复。
>
> `yk pbench capture --source codex --yes`
>
> 在修改、丢弃或整理现有未提交改动之前立即捕获。已跟踪和未跟踪改动只记录为未解决的私有候选项，不自动把这些改动作为 replay 输入。

Result: pass.
