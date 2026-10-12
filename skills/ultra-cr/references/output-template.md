# Final Review Template & Synthesis Guide

> **Output file**: `rounds/round-{n}/final.md`

How to synthesize all findings into a unified final review.

**Language requirement**: The entire final review MUST be written in Chinese (中文). Only code snippets, file paths, and technical identifiers remain in their original form.

---

## IRON LAW: Location Field Mandatory Specification

Every finding in the final review **MUST** include a precise file path and line numbers. Findings without location data are INVALID and MUST NOT appear in the final review.

### Mandatory Format

**位置**: `完整相对路径/文件名.扩展名:起始行-结束行`

Examples:
- ✅ `src/App/DocumentObject.h:288-292`
- ✅ `browser_use/agent/service.py:86`
- ✅ `pkg/handler/user.go:42-55`
- ❌ `service.py` (missing full path)
- ❌ `browser_use/agent/service.py` (missing line numbers)
- ❌ Empty / blank location field

### Rules

1. Every blocker (阻塞性问题), should-fix (应当修复), and suggestion (改进建议) **MUST** have a location field
2. The location field **MUST NOT** be empty or blank
3. The location field **MUST** contain a complete relative path from the project root
4. The location field **MUST** contain at least a starting line number
5. If a finding spans multiple files, split it into separate findings, each with its own location
6. If you cannot pinpoint the exact line number, use code search methods to determine the location — **submitting findings without line numbers is PROHIBITED**

---

## IRON LAW: No Change Descriptions

The final review **STRICTLY PROHIBITS** the following types of output. These are NOT review findings — they are noise.

### 🚫 Prohibited Output Types

1. **Change descriptions** — "Removed X", "Added Y", "Changed Z to W" (that's what git diff does, not a review)
2. **Refactoring summaries** — "Rewrote the module from X to Y" (no specific issue pointed out)
3. **File-level summaries** — "This file was completely rewritten" (too vague)
4. **Pure factual statements** — "Default changed from False to True" (must be converted to: point out the risk/impact of this change)

### ✅ Correct Output Types (each MUST point to a specific problem)

1. **Bug / Defect** — "Line 86: `AgentHookFunc` type changed from async to sync is a breaking change, existing async hooks will silently fail"
2. **Security risk** — "Line 202: `thinking_budget` hardcoded to -1 overrides user configuration"
3. **Performance issue** — "Line 21280: Old DAG path traverses all objects on each iteration, O(N×M) complexity"
4. **Best practice violation** — "Line 67: `list[str] = []` is a Python mutable default argument anti-pattern"

### Judgment Criterion

Ask yourself: **Does this output point to a specific problem that requires the developer to take action?**
- If the answer is "it just describes what the code changed" → DELETE it
- If the answer is "it points out a risk / defect / improvement point" → KEEP it

---

## Philosophy: Model Real Engineering Teams

1. **Any reviewer can block** — A single engineer identifying a critical issue can block a merge.
2. **No feedback is lost** — Every comment from every reviewer surfaces, fully attributed.
3. **Suggestions are suggestions** — Non-blocking feedback is presented for consideration but doesn't prevent merge.
4. **Tech Lead synthesizes, doesn't override** — Aggregates and presents all feedback with a recommendation.
5. **Trust and autonomy** — Authors are trusted to address feedback appropriately.

## Synthesis Process

### Step 1: Gather All Feedback

Collect without filtering:
- All individual reviews from current round
- Discourse results (if available)
- Requirements context (if provided)
- Tech Lead's original analysis from `context.md`

**Critical**: Do not discard any reviewer feedback at this stage.

### Step 2: Identify Blockers

A finding is a **blocker (阻塞性问题)** if ANY of the following are true:

| Blocker Criteria | Examples |
|------------------|----------|
| **Security vulnerability** | SQL injection, auth bypass, secrets exposure |
| **Data integrity risk** | Race conditions causing data loss, silent failures |
| **Correctness bug** | Logic errors that produce wrong results |
| **Breaking change without migration** | API contract violations, schema changes without rollback |

**Any single reviewer can flag a blocker.**

### Step 3: Categorize Non-Blocking Findings

**Should Fix (应当修复)** — Issues that should be addressed:

| Should Fix Criteria | Examples |
|---------------------|----------|
| **Code quality issues** | Missing error handling, dead code, untested critical paths |
| **Potential bugs** | Silent fallthrough, unvalidated input, race conditions |
| **Important refactors** | DRY violations with real maintenance cost, tight coupling |
| **Missing validation** | Input boundaries not enforced, missing null checks |

**Suggestions (改进建议)** — Lower-priority improvements:

| Suggestion Criteria | Examples |
|---------------------|----------|
| **Style preferences** | Naming, formatting, early returns vs nested ifs |
| **Minor refactors** | Extract small helper, simplify expression |
| **Documentation** | Add JSDoc, clarify comment |
| **Testing ideas** | Additional edge cases, performance benchmarks |

### Step 4: Note Consensus and Dissent

When multiple reviewers comment on the same area:

```markdown
### 发现: 认证流程中的错误处理

**评审员**: @principal-1, @principal-2, @quality-2

@principal-1: "OAuth 回调缺少 try-catch 包裹"
@principal-2: "同意 — token 刷新失败时会导致崩溃"
@quality-2: "错误处理存在但未传播到 UI 层"

**共识**: 所有评审员同意错误处理需要改进
**分歧**: 无
```

### Step 5: Assess Requirements (if provided)

```markdown
## 需求评估

| 需求 | 状态 | 备注 | 评审员 |
|------|------|------|--------|
| 用户可通过 OAuth 登录 | ✓ 已满足 | 实现完整 | @principal-1 |
| 会话 token 24小时后过期 | ? 不确定 | 过期逻辑不可见 | @security-1 |
| 登录失败限流 | ✗ 缺失 | 未找到限流机制 | @security-1 |
```

### Step 6: Collect Clarifying Questions

Preserve all questions from all reviewers:

```markdown
## 待澄清问题

### 来自 @principal-1
- "认证流程的目标延迟是多少？"

### 来自 @security-1
- "限流是否计划在后续 PR 中实现？"
```

### Step 7: Synthesize Verdict

| Condition | Verdict |
|-----------|---------|
| **Any blocker exists** | 要求修改 (REQUEST CHANGES) |
| **Unanswered questions about requirements** | 需要讨论 (NEEDS DISCUSSION) |
| **Suggestions only, no blockers** | 批准合并 (APPROVE) |
| **No findings** | 批准合并 (APPROVE) |

**Important**: The Tech Lead does NOT override blockers.

---

## Final Review Template

```markdown
# 代码审查: {branch/PR}

**日期**: {YYYY-MM-DD}
**审查团队**: @principal-1, @principal-2, @quality-1
**审查范围**: {暂存更改 | 当前分支所有提交 | 所有分支所有提交 | 指定分支(REF)所有提交 | 指定提交(SHA) | 指定范围(SHA1..SHA2)}
**模式**: 完整审查（含讨论） | 快速审查（无讨论）

---

## 审查结论

**批准合并** | **要求修改** | **需要讨论**

{一句话总结}

---

## 🚫 阻塞性问题

{如果存在阻塞性问题，在此列出。每个阻塞项必须在合并前解决。}

### 🚫 {阻塞项标题}
**提出者**: @security-1
**类型**: 安全漏洞
**位置**: `path/to/file.ts:42-50`

**问题描述**: {问题描述}

**阻塞原因**: {如果按当前状态合并的影响}

**修复建议**:
``{language}
{代码建议}
``

---

## 🔶 应当修复

### 1. {标题}

**提出者**: @principal-1, @quality-1
**位置**: `path/to/file.ts:42-50`

{问题描述及修复原因 — 必须指向具体问题，而非变更描述}

---

## 💡 改进建议

### 代码质量
- `path/to/file.ts:15` — "考虑提取验证逻辑" — @principal-1
- `path/to/file.ts:88` — "错误信息可以更友好" — @quality-1

### 性能
- `path/to/file.ts:202` — "此查询可以添加索引" — @principal-2

### 测试
- `path/to/file.ts:45` — "空数组的边界情况未覆盖" — @testing-1

### 代码风格
- `path/to/file.ts:67` — "建议使用提前返回减少嵌套" — @quality-1

---

## 共识与分歧

{当多位评审员对同一主题发表意见时}

---

## ✅ 值得肯定

- "关注点分离清晰" — @principal-1
- "主路径测试覆盖良好" — @testing-1
- "接口输入验证完善" — @security-1

---

## 需求评估

{如果提供了需求}

| 需求 | 状态 | 备注 | 评审员 |
|------|------|------|--------|
| 用户可通过 OAuth 登录 | ✓ 已满足 | 实现完整 | @principal-1 |
| 登录失败限流 | ✗ 缺失 | 未实现 | @security-1 |

---

## 待澄清问题

{所有评审员提出的问题}

### 来自 @principal-1
- "预期的延迟目标是多少？"

### 来自 @security-1
- "限流是否计划在后续 PR 中实现？"

---

## 各评审员详情

| 评审员 | 阻塞项 | 应当修复 | 改进建议 | 报告文件 |
|--------|--------|----------|----------|----------|
| @principal-1 | 0 | 1 | 3 | `rounds/round-{n}/reviews/principal-1.md` |
| @principal-2 | 0 | 0 | 2 | `rounds/round-{n}/reviews/principal-2.md` |
| @quality-1 | 0 | 1 | 4 | `rounds/round-{n}/reviews/quality-1.md` |

**会话目录**: `$SESSION_DIR/`
**讨论记录**: `rounds/round-{n}/discourse.md`
```

## Key Principles

1. **阻塞项是二元的** — 要么阻塞合并，要么不阻塞
2. **一个评审员就可以阻塞** — 安全工程师发现漏洞 = 阻塞项
3. **建议不阻塞** — 代码风格偏好不能阻止合并
4. **所有反馈必须呈现** — 每个评审员的每条评论都必须出现
5. **作者有自主权** — 对于建议，由作者决定是否采纳
6. **Tech Lead 是协调者** — 综合并推荐，不覆盖阻塞项
7. **位置字段是强制性的** — 每条发现必须有完整文件路径和行号，无位置的发现无效
8. **仅输出可操作发现** — 只输出指向具体问题（Bug/风险/缺陷/改进点）的内容，禁止变更描述/重构概述/事实陈述
