---
name: eli18
description: Use when explaining a diagnosis, root cause, bug mechanism, architecture, or any "why does this happen" answer to the user — especially after they say they don't understand (看不懂 / 太费劲 / 再详细解释). Not for quick status updates, confirmations, or one-line answers.
---

# ELI18

## Core Principle

The user's limit is GRANULARITY, not format, not tone, not layout. Their own
words: "这之前你的解释我就完全看不懂，非常费劲，而这个解释我看的非常清楚，
是详细度、颗粒度的问题，而不是格式、排版、布局的问题。"

Every sentence must bottom out at primitives the user already owns — database
rows, "step A happens, then step B", addresses, couriers. A sentence that
references a project-internal concept they haven't been shown (function name,
module, mechanism) is a defect in the explanation, not a reading failure.

This skill stacks ON TOP of the tone rules below, quoted verbatim:

- Use a tone that follows ASD-STE100 Simplified Technical English, but expressed in Chinese.
- Always talk to me like I have ADHD.

Those rules did not prevent the failures; granularity does.

## The Contract — what a mechanism explanation IS, in order

Full form for bug / root-cause / architecture explanations:

1. **Background from zero.** Name the raw data and actors first (fields,
   roles, states) in plain words. Assume nothing about prior knowledge —
   not even "you know what a status field is".
2. **The mechanism as a numbered story.** What the code intended, as small
   steps in causal/temporal order. One plain sentence per step.
3. **Where it breaks.** Exactly which step fails, stated plainly FIRST,
   then anchored with ONE physical-world analogy (courier, wrong building).
   The analogy comes after the plain statement, never instead of it.
4. **Why nobody noticed until now.** Which view shows what (memory vs DB,
   UI vs fallback path). Invisibility is part of the mechanism.
5. **Evidence as receipts.** One-liners verifiable without knowing the
   codebase ("the author logged '-> Succeed' right after").
6. **The fix in one sentence.** Plain statement of what changed.
7. **Safety walk-through.** Every consumer of the changed thing, each with
   a plain verdict (无影响 / 这正是修复目标 / 行为恢复).
8. **Honest leftovers.** What stays broken, and the condition for self-heal.

For simpler questions, apply only the Granularity Rules below.

## Granularity Rules

- **Expand every term inline.** no-op → "什么都不改，也不报错". Composite
  key → "数据库按 role+id 一起找行". If it can't be expanded in one clause,
  it doesn't belong in the explanation.
- **Mechanism before verdict.** Never write "服务层无罪" before the reader
  has seen the steps that lead there. Conclusions are earned.
- **file:line is a footnote, never the vehicle.** Paths and identifiers may
  appear only as supporting citation after the plain-language claim.
- **Numbers before adjectives.** "等了近 4 个月（05-13 → 09-09）" beats
  "很久以来".

## One Example (same fact, two granularities)

BAD (unreadable to this user — real excerpt):
> `updateMessageStatusToDb` 硬编码 `role='user'`，主进程把 role 当 WHERE 条件
> ——所有针对助手消息的终态写入都是静默 no-op。

GOOD (what it expands to):
> 那个"补改 status"的函数，内部写死了一句话：只改 role = user 的那条消息。
> 但 AI 消息的 role 是 assistant。于是数据库去找"role 是 user、id 是某某"——
> 找不到这行——什么都不改，也不报任何错。

The BAD version is correct and compact. It is still a failure: it assumes the
reader already holds the composite-PK model in their head.

## Calibration

If the user says 看不懂 again, the failure is YOUR granularity, not their
reading. Go one level more primitive — do NOT reformat, re-section, or add
structure. Adding layout to an ungrounded explanation produces a
well-organized incomprehensible explanation.

Every future explanation is a live test of this skill. When one lands,
note which rule carried it. When one fails, tighten the rule that was
missing.
