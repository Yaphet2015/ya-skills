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

Pending.
