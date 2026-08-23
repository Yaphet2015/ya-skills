# PBench Operator Routing Evaluation

- Date: 2026-08-23
- Model: gpt-5.6-sol
- Guidance: Current `skills/pbench/SKILL.md`

## Prompt

> Run finalized PBench case case_login with Claude under profile current-skills, then summarize the comparison report.

## Expected behavior

Select the PBench operator skill immediately. Use the shortest headless run command, then the profile report command.

## Baseline observation

The agent found the correct commands only after the skill was explicitly loaded. It said the capture-only description would not trigger the skill for a replay request. It also attempted the command and stopped because the fixture case did not exist; the routing decision remains observable.

### Exact command choice

```sh
yk pbench run --case case_login --agent claude --profile current-skills
yk pbench report --profile current-skills
```

### Exact rationalization

> 理由：这是 `SKILL.md` 中 Replay Flow 指定的无头 Claude 运行方式；案例 ID、代理和稳定 profile 标签均严格匹配请求。
>
> **否。** 技能描述只说明“在编码代理最终结果错误或不完整时捕获案例”，没有描述运行已定稿案例。明确读取该文件后，其中的 `Replay Flow` 才直接覆盖本请求。

## Post-change observation

Pending.
