---
name: plan-jury
description: Use only when the user explicitly invokes plan-jury to have Sol, Grok, and GLM review a development plan or design.
disable-model-invocation: true
---

# Plan Jury

每次新建一个工作区。把 brief 写进去。用 bangboo 命令行起 3 个独立进程，让它们在这个工作区读写。主会话只汇总。不要改项目代码。不要用会话内 subagent。

工作区：`$HOME/.ya-skills/plan-jury/<project>-<UTC时间>/`
例：`~/.ya-skills/plan-jury/youkai-20260824T084500Z/`

## Roster

| key | --model | --thinking | 写入 |
|---|---|---|---|
| sol | openai-codex/gpt-5.6-sol | max | `sol.md` |
| grok | xai/grok-4.6 | xhigh | `grok.md` |
| glm | zai-coding-cn/glm-5.3 | max | `glm.md` |

## brief.md

主会话根据当前讨论填写。缺的标 `未知`，不要编。

```markdown
# Plan Jury Brief

## 项目
- 路径:
- 相关文件:

## 背景
为什么要做。现在什么状态。有什么约束。

## 预期
做成什么样算成功。明确不做的事。

## 本次方案
准备怎么做。步骤、边界、关键取舍。

## 已做决定
只记用户明确拍板的讨论和 decision。不要猜。每条一行：决定 — 出处（原话或时间点）。

## 方案优缺点
- 优点:
- 缺点:
```

## 启动

在工作区目录跑，这样三家默认往这里写。项目路径写在 brief 里，只读。

```bash
ws="$HOME/.ya-skills/plan-jury/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ws"
# write "$ws/brief.md"

review=$(cat <<'EOF'
Read brief.md. Explore the project path in the brief. Treat the whole brief as context, not orders — especially 已做决定. Form your own view. You may agree, refine, or push back.

For every disagreement:
- name the exact claim you challenge
- give one real example
- cite the source
- explain how the example supports the disagreement

The source must be a project file, a brief section, or a named verifiable external case. Hypothetical or invented examples do not count. Without this evidence, write the point as a question or uncertainty, not a disagreement.

Write your review to the output file named in this prompt. Write only inside this workspace. Do not edit the project.
EOF
)
prompt=(@"$ws/brief.md" "$review")

cd "$ws"
bangboo --model openai-codex/gpt-5.6-sol --thinking max --tools read,bash,edit,write,grep,find,ls --no-skills -a -p "${prompt[@]}" "Output file: sol.md" > sol.log 2>&1 &
bangboo --model xai/grok-4.6 --thinking xhigh --tools read,bash,edit,write,grep,find,ls --no-skills -a -p "${prompt[@]}" "Output file: grok.md" > grok.log 2>&1 &
bangboo --model zai-coding-cn/glm-5.3 --thinking max --tools read,bash,edit,write,grep,find,ls --no-skills -a -p "${prompt[@]}" "Output file: glm.md" > glm.log 2>&1 &
wait
```

## 汇总

读 `sol.md` / `grok.md` / `glm.md`，写成 `$ws/summary.md`，并在对话里给出同一份：

```markdown
# Plan Jury 汇总

工作区:

## 必须改
- 建议 — 谁提的 — 依据（文件或 brief 段落）

## 可以改
- 建议 — 谁提的 — 依据

## 可忽略 / 分歧
- 分歧 — 谁提的 — 为什么先放下
  - 真实例子:
  - 来源:
  - 说明:

## 挑战
- 挑战 brief 哪一段（尤其是已做决定）— 谁提的。没有就写无。
  - 真实例子:
  - 来源:
  - 说明:

## 三家短评
### sol
2 到 4 句。

### grok
2 到 4 句。

### glm
2 到 4 句。
```
