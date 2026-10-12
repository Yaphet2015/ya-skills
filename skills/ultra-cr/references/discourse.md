# Discourse Phase

After individual reviews are complete, facilitate a discourse phase where reviewers respond to each other's findings.

> **Language requirement**: All discourse output MUST be written in Chinese (中文). Only code snippets, file paths, and technical identifiers remain in English. The discourse file is read during Phase 7 Synthesis, so Chinese output ensures consistency in final.md.

## Purpose

- **Challenge findings** — Push back on conclusions with reasoning
- **Build consensus** — Identify agreed-upon issues (higher confidence)
- **Connect insights** — Link findings across different reviewers
- **Surface new concerns** — Raise issues that emerge from discussion

## When to Run

- **Default**: Always run after individual reviews (when `discourse.enabled: true`)
- **Skip**: When `--quick` flag is specified or `discourse.enabled: false`

> **Phase 5.5 衔接**: 如果 Phase 5.5 聚焦验证已执行，进入 discourse 的发现集是**已去噪**的——`verification-summary.md` 中"剔除清单"的 FALSE-ALARM 发现已被移除，"修正清单"的 REFINE 描述已被替换。discourse 仅针对 CONFIRM 发现与未经验证的发现展开。discourse prompt 中应注明"以下发现已经过 Phase 5.5 聚焦验证，标注了验证结论"，让 reviewer 知道哪些发现已有独立验证背书。如果 Phase 5.5 被跳过（`verification-summary.md` 含 `SKIPPED:` 标记，剔除/修正/确认清单均为空），discourse 输入与原流程一致。

## Response Types

| Type | Purpose | Effect |
|------|---------|--------|
| **AGREE** | Endorse another's finding | Increases confidence |
| **CHALLENGE** | Push back with reasoning | May reduce confidence or refine finding |
| **CONNECT** | Link findings across reviewers | Creates cross-cutting insight |
| **SURFACE** | Raise new concern from discussion | Adds new finding |

## Discourse Process

### Step 1: Compile Individual Reviews

Gather all individual review outputs from the current round:
```
rounds/round-{n}/reviews/principal-1.md
rounds/round-{n}/reviews/principal-2.md
rounds/round-{n}/reviews/quality-1.md
...
```
### Step 2: Present All Findings

Create a consolidated view of all findings for reviewers to respond to:

```markdown
## All Findings for Discourse

### From principal-1:
1. [Finding: Missing error handling in auth flow] - High
2. [Finding: Inconsistent naming in service layer] - Medium

### From principal-2:
1. [Finding: Missing error handling in auth flow] - High
2. [Finding: Potential memory leak in cache] - High

### From quality-1:
1. [Finding: Long function needs decomposition] - Medium
...
```

### Step 3: Spawn Discourse Tasks

For each reviewer, spawn a discourse task:

```markdown
# Discourse Task: {reviewer}

You previously reviewed this code. Now review what OTHER reviewers found.

## Your Original Findings
{their findings}

## Other Reviewers' Findings
{all other findings}

## Your Task

Respond to other reviewers' findings using:
- **AGREE [reviewer] [finding]**: You concur with this finding
- **CHALLENGE [reviewer] [finding]**: You disagree, with reasoning
- **CONNECT [your finding] → [their finding]**: Link related findings
- **SURFACE**: Raise new concern that emerged from reading others' work

Be constructive. Challenge with reasoning, not dismissal.
```

### Step 4: Collect Responses

Each reviewer produces discourse output:

```markdown
## Discourse from principal-1

AGREE quality-1 "Long function needs decomposition"
  - This aligns with my concern about maintainability

CHALLENGE security-1 "SQL injection risk"
  - The input is already validated at the API layer (see auth/middleware.ts:42)
  - The parameterized query handles this correctly

CONNECT "Missing error handling" → quality-2 "No logging on failures"
  - Both point to incomplete error management

SURFACE
  - Reading quality-1's finding made me realize: the retry logic also lacks timeout handling
```

### Step 5: Compile Discourse Results

Save to `rounds/round-{n}/discourse.md`:

```markdown
# 讨论结果

## 共识（高置信度）
- **认证流程缺少错误处理** — 一致同意: principal-1, principal-2, quality-2
- **长函数需要拆分** — 一致同意: quality-1, principal-1

## 受质疑的发现
- **SQL 注入风险** (security-1) — 被 principal-1 质疑
  - 理由: 输入在 API 层已验证，使用了参数化查询
  - 结论: 标记为误报

## 关联发现
- 错误处理 + 日志缺失 → "不完整的错误管理模式"

## 讨论中新发现
- 重试逻辑缺少超时处理（来自 principal-1）
```

## Confidence Adjustment

| Scenario | Confidence Change |
|----------|------------------|
| Multiple reviewers AGREE | +1 (Very High) |
| Finding CHALLENGED and defended | +1 |
| Finding CHALLENGED, not defended | -1 (May remove) |
| Finding CONNECTED to others | +1 |
| SURFACED in discourse | Standard confidence |

## Output

The discourse phase produces:
1. `discourse.md` — Full discourse record
2. Adjusted confidence levels for synthesis
3. Connected/grouped findings
4. Resolved challenges (false positives removed)

## Mandatory Cross-Review Rules

### Custom Reviewer Cross-Review (persona-body-driven)
When a custom reviewer (from `references/reviewers/bundled/`, `~/.config/ultra-cr/reviewer/`, or `.reviews/ultra-cr/reviewer/`) is in the team AND its persona body contains a "Cross-Review Awareness" section, the domain-specific reviewers mentioned in that section MUST respond to the custom reviewer's findings with AGREE/CHALLENGE. The routing is read directly from the reviewer's persona body (natural language). For example, `java-code-smell.md` describes in its "Cross-Review Awareness" section that its concurrency findings are validated by `@principal` and `@architect`, its random/crypto findings by `@security`, etc. Reviewers without a "Cross-Review Awareness" section have no mandatory cross-review routing (their findings are still visible to all reviewers for optional AGREE/CHALLENGE).

### Profiling Analysis Cross-Review
When profiling-analysis is in the team, domain-specific reviewers MUST respond to its findings:
- **CPU hot path findings** → @principal and @performance MUST AGREE/CHALLENGE
- **Memory/Allocation hot path findings** → @performance MUST AGREE/CHALLENGE
- **Humongous allocation patterns** → @backend MUST AGREE/CHALLENGE
- **GC pressure findings** → @reliability (if in team) MUST AGREE/CHALLENGE, otherwise @principal
- **Thread/Lock contention findings** → @backend MUST AGREE/CHALLENGE
