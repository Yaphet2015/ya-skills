# Ultra CR Workflow

Complete review process for multi-agent code review with architectural impact analysis.

Phase numbers are retained for saved-session compatibility: active phases are 0–5, 5.5, 7 and 8. Phase 6 (reviewer discussion) is retired. Do not dispatch discussion tasks or require a discussion artifact. Ignore legacy Phase 6 progress rows and preserve existing discussion files as historical evidence; they are not synthesis inputs or completion requirements.

## Phase 0: Session Verification

Use `scripts/review_state.py` for canonical paths, artifact checks and phase state. Read `references/session-state.md` for commands and data formats. Resolve `SKILL_ROOT` to the installation directory and use Python 3.9+ (`python3` on macOS/Linux, usually `python` on Windows). Only the coordinator updates state; reviewers write their assigned artifacts.

1. Resolve the output root/session path and snapshot inputs: resolved scope, pinned head/base/target SHAs, staged/unstaged/untracked content fingerprint where relevant, requirements, review options and reviewer-definition fingerprints. Exclude generated review artifacts from the code fingerprint. A different snapshot needs a new session; preserve prior evidence.
2. Save the snapshot as JSON, then run the helper's `init` command with that snapshot and session directory. `init` is idempotent for identical inputs and refuses a different snapshot/round. It preserves old progress as `PROGRESS.legacy.md` when adopting a session without `state.json`.
3. Run `status`, then `paths`. `state.json` is authoritative; `PROGRESS.md` is generated for humans. Never infer completion from a filename alone or hand-edit status. A DONE phase with missing/invalid output is downgraded. A file with the wrong name remains incomplete: use the exact returned path rather than scanning and guessing a rename.
4. If all active phases are DONE and final artifacts validate, present the existing final report. Otherwise resume the first incomplete phase. Existing valid artifacts may be accepted with `complete --phase N`; do not re-spawn a reviewer solely because its state row is missing. Confirm legacy scope/snapshot compatibility before adopting old files.
5. Preserve round numbers already selected by the session; do not automatically advance the round because `final.md` exists. A fresh snapshot uses a fresh session. Legacy Phase 6/discussion artifacts are historical only.

**Profiling resume**: When diagnostic mode is active, Phase 4 also requires `hotspot-inventory.md` before Wave 2. If absent, recover the profiling reviewer first; preserve other reports. If diagnostics already explicitly degraded to normal mode, use the recorded diff scope instead.

At each checkpoint run `complete --phase N` after the output is written. The helper checks canonical artifacts and writes state/progress atomically. A failed check is not completion. `status` reports the pending phase; read the error, recover the affected artifact, and retry only that checkpoint. The helper does not judge code correctness or dispatch/retry agents.

## Phase 1: Context Discovery

**Goal**: Build review context from config + discovered files + user requirements + resolve review scope.

### Steps

**1a. Load Configuration**

Check for `.ultra-cr.yaml`:

**Bash (Linux / macOS / Git Bash):**
```bash
cat .ultra-cr.yaml 2>/dev/null
```
**PowerShell (Windows):**
```powershell
if (Test-Path .ultra-cr.yaml) { Get-Content .ultra-cr.yaml -Raw }
```

If not found, use defaults (principal:2, quality:1, scope:current-branch).

Extract:
- `context:` — Direct project context (injected into all reviews)
- `base:` — Target branch/ref for branch scopes (optional)
- `scope:` — Review scope (staged | current-branch | all-branches | branch:REF | commit:SHA | range:SHA1..SHA2)
- `team:` — Reviewer team composition
- `rules:` — Per-severity review rules
- Legacy `discourse:` settings are ignored; reviewer discussion is no longer part of this workflow
- `verification:` — Whether to run Phase 5.5 Focused Verification (`enabled: true|false`, optional `risk_types:` list)

**1b. Parse $ARGUMENTS**

If user provided arguments, parse:
- `--team=type:count,...` — Override team composition
- `--quick` — Skip Phase 5.5 Focused Verification, write its skip-marker summary and proceed to synthesis
- `--base=REF` — Target branch/ref used to compute the branch merge-base
- `--scope=staged|current-branch|all-branches|branch:REF|commit:SHA|range:SHA1..SHA2` — Override review scope
  - `--scope=branch:feature-auth` — Review changes introduced by the `feature-auth` branch relative to the target merge-base
  - `--scope=commit:abc1234` — Review a single commit
  - `--scope=commit:feature-auth` — Review the latest commit on the `feature-auth` branch (resolved to its HEAD SHA)
  - `--scope=range:abc1234..def5678` — Review a commit range
  - `--scope=range:master~20..master` — Review the last 20 commits on master
- Any other text — Treat as requirements context

**1c. Resolve Review Scope**

Determine which changes to review:

1. **`--scope` argument** (highest priority)
2. **`.ultra-cr.yaml` `scope:` field** (second priority)
3. **Auto-detection from user intent** (third priority):
   - User says "review the whole branch", "review all changes on this branch", "review this feature branch", "review the whole repo", "review the entire codebase", "review all commits" → `current-branch` (review changes from the target merge-base to HEAD)
   - User says "review all branches", "review every branch" → `all-branches` (review each local branch from its target merge-base)
   - User says "review branch B", "review the B branch", "review branch feature-xyz" → `branch:B` or `branch:feature-xyz` (review the specified branch from its target merge-base to its HEAD)
   - User says "review B branch's latest commit", "review B branch last commit", "review the most recent commit on branch B" → `commit:B` (B is resolved to its HEAD commit SHA via `git rev-parse B`, then diff that single commit with `git diff SHA~1..SHA`)
   - User says "review commit abc1234", "review the commit abc1234" → `commit:abc1234` (review that single commit)
   - User says "review the last N commits", "review the last N commits on branch B" → `range:REF~N..REF` (e.g., "last 20 commits on master" → `range:master~20..master`)
   - User says "review changes from X to Y", "review commits X through Y" → `range:SHA1..SHA2` (review the specified range)
   - User says "review B branch's recent N months/weeks/days changes", "review changes in the last N months/weeks/days on branch B" → Resolve to `range:SHA1..SHA2` by finding the earliest commit within the time range: `git rev-parse $(git log REF --since="N months ago" --reverse --oneline | head -1 | cut -d' ' -f1)~1` → REF as the range
4. **Default**: `current-branch`

> **Important**: "Review the whole repo" defaults to `current-branch` (changes introduced by the current branch), NOT `all-branches`. Only use `all-branches` when the user explicitly mentions reviewing across multiple/all branches.

> **CRITICAL for branch:REF, commit:SHA, range:SHA1..SHA2**: These scopes work WITHOUT checking out any branch. Git ref syntax allows diffing any ref from any branch. NEVER run `git checkout` or `git switch` to obtain the diff. Use `git diff "$BASE_SHA..$REVIEW_SHA"`, `git diff SHA~1..SHA`, `git diff SHA1..SHA2` directly — these work from any working branch.

Store resolved scope in session context. This scope controls all git diff commands in subsequent phases.

**Branch comparison base (`current-branch`, `branch:REF`, `all-branches`)**:

1. Resolve `TARGET_BRANCH` using `--base=REF` > `.ultra-cr.yaml` `base:` > the target explicitly stated by the user or recorded in the referenced PR > the default branch saved locally. For default detection, use `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`; if unavailable, try existing refs in this order: `origin/main`, `origin/master`, `main`, `master`. Use local refs; fetching is not required. A feature branch's upstream (such as `origin/feature-x`) is not evidence of its merge target.
2. Verify the chosen target resolves to a commit and pin it as `TARGET_SHA`. An invalid explicit target is an error; do not replace it with a default. If no target is available or `git merge-base` fails (for example, missing shallow history or unrelated histories), report that the comparison base cannot be resolved. Never fall back to the repository's root commit or the latest commit.
3. Pin the reviewed commit as `REVIEW_SHA` (`HEAD` for `current-branch`, the specified ref for `branch:REF`). Compute `BASE_SHA` with `git merge-base "$TARGET_SHA" "$REVIEW_SHA"`. Compare `BASE_SHA..REVIEW_SHA`, not the target tip against the reviewed tip; target-only changes must stay outside the review. An empty comparison is a valid no-change result and must not expand the scope.
4. Record the target ref, target SHA, review SHA, merge-base SHA and base-selection source in `discovered-standards.md` and the session snapshot in `state.json`. Reuse these pinned SHAs for the diff, commit list and graph analysis. For `all-branches`, resolve and record a separate review SHA and merge-base for each local branch; apply the same explicit target unless a branch has a known PR target.

The Phase 2 snippets show the initialization commands; if these SHAs were already pinned in Phase 1 for graph analysis, reuse them rather than resolving moving refs again.

**Shared analysis base**: `$BASE_SHA` always means the lower endpoint of the resolved comparison. For `staged`, use `HEAD` for working/index changes (or the parent for the existing latest-commit fallback); for `commit:SHA`, use its parent; for `range:X..Y`, use resolved `X`. A root commit uses the empty tree for diffing; if a graph tool cannot accept that base, fall back to repository reads. Graph tools must use the same review snapshot as the diff; if they only support the checked-out HEAD and it differs from `REVIEW_SHA`, use repository reads instead. For `all-branches`, analyze each recorded range separately rather than reusing the last branch's base.

> **Profiling-diagnostic mode**: Enter **profiling-diagnostic mode** when EITHER condition holds: (a) user prompt / `requirements.md` contains profiling keywords (火焰图, flame graph, GC log, GC日志, profiling, heap dump, async-profiler, OOM, OutOfMemory, 内存泄漏, 性能分析, 性能热点, jfr, allocHumongous, Full GC, cpu profile), OR (b) the `profiling-analysis` reviewer is in the resolved team (whether auto-triggered by keywords per Phase 3 Step C, OR explicitly added via `--team=profiling-analysis:1` / natural language / `.ultra-cr.yaml`). **Equivalence invariant: profiling-analysis in team ⟺ diagnostic mode active** — there is no "profiling as enhancement dimension only" path; whenever the profiling-analysis reviewer runs, diagnostic mode is ON. In this mode:
> - Profiling hot paths (from `hotspot-inventory.md`, produced by the profiling-analysis reviewer in Phase 4) become the **primary review scope** for ALL reviewers, not just the profiling-analysis reviewer. The hotspot inventory is the scope axis; the diff is not.
> - **If a diff exists**: the diff is **demoted to supplementary context**. Reviewers use it only to check "was this hot method recently changed?" — the diff is NOT the scope axis. Phase 2 diff strategy is marked `supplementary (profiling-diagnostic)`.
> - **If no diff exists** (empty diff): profiling is the sole entry — no blocking. Phase 2 diff strategy is marked `N/A (profiling-diagnostic)`.
>
> This is NOT a separate review mode with different phases — the same active review phases run. The only difference is the **scope axis**: diagnostic mode uses the hotspot inventory as the scope axis; normal mode (no profiling-analysis reviewer) uses the diff as the scope axis. Profiling file paths are provided by the user in the prompt (Phase 2 Step 3b resolves them: directory → list, file path → record).

> **⚠️ Branch-fit reminder (diagnostic mode only)**: Profiling data (flame graphs, GC logs, JFR) is almost always collected from a **production/online deployment**, so the reviewed code MUST match the branch that is actually deployed online. If the scope resolves to the wrong branch (e.g., a local dev branch, uncommitted staged changes, or a feature branch not yet deployed), the review is wasted — the hot methods in the profiling data will not match the code under review. After resolving scope in Step 1c, if diagnostic mode is active, the Tech Lead MUST:
> 1. **Output a visible reminder to the terminal** (does NOT pause the flow — non-blocking): state the resolved scope (branch/commit/range), the current working branch, and warn: "诊断模式下，profiling 数据通常采集自线上环境，请确认当前审查分支 [{resolved scope}] 与火焰图/GC日志/JFR 采集时的线上部署分支一致。分支选错会导致热点方法与代码不匹配，整个审查无效。如需更换分支，请重新发起 review 并指定 --scope=branch:{线上分支}。"
> 2. **Record the reminder in `discovered-standards.md`** under a "Branch-fit reminder" section: resolved scope, working branch, and that the non-blocking reminder was emitted.
> 3. **Continue the flow** (do NOT wait for user response) — the reminder is informational; if the user did not specify `--scope`, the resolved scope stands. The user can re-launch with the correct `--scope` if needed.
>
> This is an **exception** to the "Do NOT ask the user" rule below — it is a one-way reminder (no question asked, no pause), not a clarifying question. The flow remains non-interactive.

> **CRITICAL**: Do NOT ask the user to confirm or clarify the review scope. Apply the resolution rules deterministically and document the result in `discovered-standards.md`. (The diagnostic-mode branch-fit reminder above is a one-way informational notice, NOT a clarifying question — it does not pause the flow.)

**1d. Discover Reference Files**

```bash
# Check for AI assistant configuration
cat AGENTS.md 2>/dev/null
cat CLAUDE.md 2>/dev/null
cat .cursorrules 2>/dev/null
cat .windsurfrules 2>/dev/null

# Check for contribution guidelines
cat CONTRIBUTING.md 2>/dev/null

# Check for AI CodeReview custom rules (issue filtering / classification / trimming)
cat CODEREVIEW.md 2>/dev/null
```

PowerShell equivalent (cross-platform parity):

```powershell
# Check for AI assistant configuration
if (Test-Path AGENTS.md) { Get-Content AGENTS.md -Raw }
if (Test-Path CLAUDE.md) { Get-Content CLAUDE.md -Raw }
if (Test-Path .cursorrules) { Get-Content .cursorrules -Raw }
if (Test-Path .windsurfrules) { Get-Content .windsurfrules -Raw }

# Check for contribution guidelines
if (Test-Path CONTRIBUTING.md) { Get-Content CONTRIBUTING.md -Raw }

# Check for AI CodeReview custom rules (issue filtering / classification / trimming)
if (Test-Path CODEREVIEW.md) { Get-Content CODEREVIEW.md -Raw }
```

> **`CODEREVIEW.md`** is the AI CodeReview custom configuration. It declares **issue filtering rules, problem classification/grading, and problem trimming** (e.g. "do not check X", "grade as Critical/General", "return at most N items"). When present, its full content is merged into `discovered-standards.md` (see Step 1f) and propagated to EVERY reviewer sub-agent as part of the project context, so all reviewers apply the same filtering/grading/trimming rules. The file is OPTIONAL — when absent, reviewers use their default review rules.

**1e. Gather User-Provided Requirements**

Recognize requirements from ANY of these forms:
- **Inline**: "review this against the requirement that..."
- **Document reference**: "see the spec at path/to/spec.md" → Read the file
- **Pasted text**: Bug reports, acceptance criteria, notes
- **Ambiguous reference**: "check the auth spec" → Search for likely files (do NOT ask the user — make a reasonable assumption and document it)

If requirements provided, save to `requirements.md` in session directory.

**1f. Merge Into discovered-standards.md**

```markdown
# Discovered Project Standards

## Project Context
[content from .ultra-cr.yaml context field]

## Review Scope
[resolved scope: staged | current-branch | all-branches | branch:REF | commit:SHA | range:SHA1..SHA2]
[scope resolution source: argument | config | auto-detection | default]
[if branch scope — target ref/source = {target}; TARGET_SHA = {sha}; REVIEW_SHA = {sha}; BASE_SHA = {merge-base}; one entry per branch for all-branches]
[if branch:REF — resolved REF = {branch name or ref}]
[if commit:SHA — resolved SHA = {full commit hash}]
[if range:SHA1..SHA2 — resolved range = {full commit hashes}]

## From: AGENTS.md
[content]

## From: CLAUDE.md
[content]

## Review Rules
[rules from .ultra-cr.yaml]

## From: CODEREVIEW.md (AI CodeReview Custom Rules)
[full content of CODEREVIEW.md — issue filtering, problem classification/grading, problem trimming]
[ALL reviewers MUST apply these filtering/grading/trimming rules. When this file is absent, this section is omitted and reviewers use their default rules.]

## 知识图谱
- 状态: 可用 / 图未构建 / server 不可用
- 检测方法: list_graph_stats_tool + get_minimal_context_tool
- 全局上下文: [get_minimal_context_tool 返回的 stats/risk score/建议工具，供 Phase 2/3 复用]
- 定位: 导航加速器（快速定位该查哪里），不替代 Diff/Grep/Read 的细节分析
- 降级策略: server 不可用或图未构建时回退到 Grep/Glob/Read 流程
```

**1g. Graph 可用性检测**

分两步精确区分三种状态，避免把"图未构建"误判为"graph 可用"导致 Phase 2 调用失败：

1. **调用 `list_graph_stats_tool`**（最轻量、无副作用）判断 server 与图状态：
   - 工具不存在 / 连接失败 → **server 不可用**，标注"不可用"，走纯 grep 降级
   - 工具成功但返回 `last_updated` 为 null 或 nodes=0 → **图未构建**，标注"图未构建"，走纯 grep 降级，并在 discovered-standards.md 提示"可运行 build_or_update_graph_tool 构建图谱后获得增强"
   - 工具成功且有有效数据 → 图存在，进入第 2 步

2. **调用 `get_minimal_context_tool(task="ultra-cr code review", base=$BASE_SHA, changed_files=[<git diff --name-only 的文件列表>])`**（约 100 token）：
   - 一次拿到 graph stats + risk score + top communities/flows + 建议的下一步工具
   - **必须传 base 参数**：用 scope 解析阶段确定的 `$BASE_SHA`（已解析的比较起点；分支范围为 merge-base），使风险评分覆盖整个审查范围；默认 HEAD~1 只分析最后一个 commit，全量审查场景下会严重失真。changed_files 用 `git diff --name-only` 的文件列表
   - 结果存入 discovered-standards.md 的"全局上下文"字段，供 Phase 2/3 复用（避免重复查询，符合 code-review-graph 官方"ALWAYS start with get_minimal_context_tool"规则）
   - 如果此调用失败但第 1 步成功 → 图可用但上下文获取失败，仍标记"可用"，Phase 2 自行调用 detect_changes_tool

**设计原则**：
- 检测只做一次，结果全局共享，后续所有 phase 根据此标记决定是否使用 graph
- 当 graph 可用时，结构定位类任务优先使用 graph（调用链追踪、影响半径、测试覆盖）
- Grep/Read 仍用于 graph 不覆盖的区域（MyBatis XML、配置文件、语句级分析）
- 参见 `references/graph-integration.md` 了解 graph 的能力边界和正确使用方式

### Phase 1 Checkpoint

**STOP and verify before proceeding (self-check, do NOT ask the user):**
- [ ] Session directory created: `$SESSION_DIR/`
- [ ] `discovered-standards.md` written to session directory (persisted to disk)
- [ ] Review scope resolved and recorded (persisted to disk)
- [ ] If profiling keywords present: profiling-diagnostic mode documented in `discovered-standards.md` (mode = profiling-diagnostic, diff strategy = N/A (profiling-diagnostic) if empty diff OR supplementary (profiling-diagnostic) if diff exists)
- [ ] If profiling-diagnostic mode active: branch-fit reminder emitted to terminal AND recorded in `discovered-standards.md` (resolved scope + working branch + reminder text)
- [ ] If user provided requirements: `requirements.md` written (persisted to disk)
- [ ] Graph availability detected and recorded in `discovered-standards.md` (知识图谱 section with status: 可用/不可用)
- [ ] Helper `complete --phase 1` succeeded

---

## Phase 2: Gather Change Context + Impact Analysis

**Goal**: Understand what changed, why, and how it affects the architecture.

> **Context Protection Strategy**: The main agent (Tech Lead) MUST NOT read large diff output into its context, as it can consume most of the context window and cause context compression in later phases. Instead, use an **adaptive approach based on diff size**:
>
> | Diff Size | Lines (approx.) | Strategy | Main Agent | Subagents |
> |-----------|-----------------|----------|------------|-----------|
> | **Small** | ≤ 500 lines | Inline | Reads diff directly into context | Receives diff in prompt |
> | **Large** | > 500 lines | Disk-offload | Reads metadata only (name-only, stat) | Reads `$SESSION_DIR/diff.patch` from disk |
>
> **How to determine diff size**: After generating the diff, count lines. If the diff output is ≤ 500 lines, it is safe to read into the main agent's context directly. If > 500 lines, persist to `$SESSION_DIR/diff.patch` and use the disk-offload strategy.
>
> **Rationale**: Small diffs (e.g., a single commit, a few staged files) pose no context risk and benefit from the main agent having full visibility for Tech Lead analysis. Large diffs (e.g., entire branch reviews, multi-file refactors) must be offloaded to prevent context compression.

### Steps

1. Identify the review target based on the resolved scope and **determine diff size**:

   **Scope: `staged`** (default)
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # Metadata (always collected — small output)
   git diff --cached --name-only
   git diff --cached --stat
   git diff --name-only
   git diff --stat
   git log --oneline -10
   git branch --show-current

   # Generate diff and determine strategy
   if git diff --cached --quiet 2>/dev/null && git diff --quiet 2>/dev/null; then
     DIFF_OUTPUT=$(git diff HEAD~1)
   elif ! git diff --cached --quiet 2>/dev/null; then
     DIFF_OUTPUT=$(git diff --cached)
   else
     DIFF_OUTPUT=$(git diff)
   fi
   DIFF_LINES=$(echo "$DIFF_OUTPUT" | wc -l)

   if [ "$DIFF_LINES" -le 500 ]; then
     # Small diff → inline strategy (safe to read into context)
     echo "$DIFF_OUTPUT"
   else
     # Large diff → disk-offload strategy
     echo "$DIFF_OUTPUT" > "$SESSION_DIR/diff.patch"
     # Do NOT read diff.patch into context
   fi
   ```
   **PowerShell (Windows):**
   ```powershell
   # Metadata (always collected — small output)
   git diff --cached --name-only
   git diff --cached --stat
   git diff --name-only
   git diff --stat
   git log --oneline -10
   git branch --show-current

   # Generate diff and determine strategy
   # git diff --quiet: exit 0 = no changes (empty), exit 1 = has changes (non-empty)
   git diff --cached --quiet 2>$null; $cachedEmpty = ($LASTEXITCODE -eq 0)
   git diff --quiet 2>$null; $unstagedEmpty = ($LASTEXITCODE -eq 0)
   if ($cachedEmpty -and $unstagedEmpty) {
     $DIFF_OUTPUT = git diff HEAD~1
   } elseif (-not $cachedEmpty) {
     $DIFF_OUTPUT = git diff --cached
   } else {
     $DIFF_OUTPUT = git diff
   }
   $DIFF_LINES = ($DIFF_OUTPUT | Measure-Object -Line).Lines

   if ($DIFF_LINES -le 500) {
     # Small diff → inline strategy (safe to read into context)
     $DIFF_OUTPUT
   } else {
     # Large diff → disk-offload strategy
     $DIFF_OUTPUT | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
     # Do NOT read diff.patch into context
   }
   ```

   **Scope: `current-branch`** — Changes from the target merge-base to the pinned HEAD
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # TARGET_BRANCH is resolved in Phase 1 Step 1c; pin these once and reuse.
   TARGET_SHA=$(git rev-parse --verify "${TARGET_BRANCH}^{commit}") || exit 1
   REVIEW_SHA=$(git rev-parse --verify "HEAD^{commit}") || exit 1
   BASE_SHA=$(git merge-base "$TARGET_SHA" "$REVIEW_SHA") || exit 1

   # Metadata (always collected — small output)
   git log "$BASE_SHA..$REVIEW_SHA" --oneline
   git diff "$BASE_SHA..$REVIEW_SHA" --name-only
   git diff "$BASE_SHA..$REVIEW_SHA" --stat
   git branch --show-current

   # Branch diffs are typically large → default to disk-offload, then check size
   git diff "$BASE_SHA..$REVIEW_SHA" > "$SESSION_DIR/diff.patch"
   DIFF_LINES=$(wc -l < "$SESSION_DIR/diff.patch")

   if [ "$DIFF_LINES" -le 500 ]; then
     # Small branch diff → inline strategy (safe to read into context)
     cat "$SESSION_DIR/diff.patch"
   fi
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```
   **PowerShell (Windows):**
   ```powershell
   $TARGET_SHA = git rev-parse --verify "${TARGET_BRANCH}^{commit}"
   if ($LASTEXITCODE -ne 0) { throw "Cannot resolve target branch" }
   $REVIEW_SHA = git rev-parse --verify "HEAD^{commit}"
   if ($LASTEXITCODE -ne 0) { throw "Cannot resolve review HEAD" }
   $BASE_SHA = git merge-base $TARGET_SHA $REVIEW_SHA
   if ($LASTEXITCODE -ne 0) { throw "Cannot resolve merge-base" }

   # Metadata (always collected — small output)
   git log "$BASE_SHA..$REVIEW_SHA" --oneline
   git diff "$BASE_SHA..$REVIEW_SHA" --name-only
   git diff "$BASE_SHA..$REVIEW_SHA" --stat
   git branch --show-current

   # Branch diffs are typically large → default to disk-offload, then check size
   git diff "$BASE_SHA..$REVIEW_SHA" | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
   $DIFF_LINES = (Get-Content "$SESSION_DIR/diff.patch" | Measure-Object -Line).Lines

   if ($DIFF_LINES -le 500) {
     # Small branch diff → inline strategy (safe to read into context)
     Get-Content "$SESSION_DIR/diff.patch" -Raw
   }
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```

   **Scope: `all-branches`** — Each local branch compared with its target merge-base. The examples use one resolved target; when branches have different known PR targets, resolve the corresponding target SHA inside the collection loop.
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   TARGET_SHA=$(git rev-parse --verify "${TARGET_BRANCH}^{commit}") || exit 1
   REVIEW_REFS=()
   REVIEW_SHAS=()
   BASE_SHAS=()
   while IFS= read -r BRANCH; do
     REVIEW_SHA=$(git rev-parse --verify "${BRANCH}^{commit}") || exit 1
     BASE_SHA=$(git merge-base "$TARGET_SHA" "$REVIEW_SHA") || exit 1
     REVIEW_REFS+=("$BRANCH")
     REVIEW_SHAS+=("$REVIEW_SHA")
     BASE_SHAS+=("$BASE_SHA")
   done < <(git for-each-ref --format='%(refname)' refs/heads/)

   # Record these pinned ranges in the session context before collecting output.
   for INDEX in "${!REVIEW_REFS[@]}"; do
     git log "${BASE_SHAS[$INDEX]}..${REVIEW_SHAS[$INDEX]}" --oneline
     git diff "${BASE_SHAS[$INDEX]}..${REVIEW_SHAS[$INDEX]}" --name-only
     git diff "${BASE_SHAS[$INDEX]}..${REVIEW_SHAS[$INDEX]}" --stat
   done

   # Persist every branch patch using the same pinned range as its metadata.
   {
     for INDEX in "${!REVIEW_REFS[@]}"; do
       echo "=== Branch: ${REVIEW_REFS[$INDEX]} ==="
       git diff "${BASE_SHAS[$INDEX]}..${REVIEW_SHAS[$INDEX]}"
     done
   } > "$SESSION_DIR/diff.patch"
   ```
   **PowerShell (Windows):**
   ```powershell
   $TARGET_SHA = git rev-parse --verify "${TARGET_BRANCH}^{commit}"
   if ($LASTEXITCODE -ne 0) { throw "Cannot resolve target branch" }
   $ranges = @(foreach ($BRANCH in (git for-each-ref --format='%(refname)' refs/heads/)) {
     $REVIEW_SHA = git rev-parse --verify "${BRANCH}^{commit}"
     if ($LASTEXITCODE -ne 0) { throw "Cannot resolve review ref" }
     $BASE_SHA = git merge-base $TARGET_SHA $REVIEW_SHA
     if ($LASTEXITCODE -ne 0) { throw "Cannot resolve merge-base" }
     [PSCustomObject]@{ Ref = $BRANCH; Review = $REVIEW_SHA; Base = $BASE_SHA }
   })

   # Record these pinned ranges in the session context before collecting output.
   foreach ($range in $ranges) {
     git log "$($range.Base)..$($range.Review)" --oneline
     git diff "$($range.Base)..$($range.Review)" --name-only
     git diff "$($range.Base)..$($range.Review)" --stat
   }

   $diffContent = foreach ($range in $ranges) {
     Write-Output "=== Branch: $($range.Ref) ==="
     git diff "$($range.Base)..$($range.Review)"
   }
   $diffContent | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
   ```

   **Scope: `branch:REF`** — Changes from the target merge-base to the pinned specified ref
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # REF and TARGET_BRANCH are resolved in Phase 1; do not check out either branch.
   TARGET_SHA=$(git rev-parse --verify "${TARGET_BRANCH}^{commit}") || exit 1
   REVIEW_SHA=$(git rev-parse --verify "${REF}^{commit}") || exit 1
   BASE_SHA=$(git merge-base "$TARGET_SHA" "$REVIEW_SHA") || exit 1

   # Metadata (always collected — small output)
   git log "$BASE_SHA..$REVIEW_SHA" --oneline
   git diff "$BASE_SHA..$REVIEW_SHA" --name-only
   git diff "$BASE_SHA..$REVIEW_SHA" --stat
   git branch --show-current

   # Generate diff and determine strategy
   git diff "$BASE_SHA..$REVIEW_SHA" > "$SESSION_DIR/diff.patch"
   DIFF_LINES=$(wc -l < "$SESSION_DIR/diff.patch")

   if [ "$DIFF_LINES" -le 500 ]; then
     # Small diff → inline strategy (safe to read into context)
     cat "$SESSION_DIR/diff.patch"
   fi
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```
   **PowerShell (Windows):**
   ```powershell
   $TARGET_SHA = git rev-parse --verify "${TARGET_BRANCH}^{commit}"
   if ($LASTEXITCODE -ne 0) { throw "Cannot resolve target branch" }
   $REVIEW_SHA = git rev-parse --verify "${REF}^{commit}"
   if ($LASTEXITCODE -ne 0) { throw "Cannot resolve review ref" }
   $BASE_SHA = git merge-base $TARGET_SHA $REVIEW_SHA
   if ($LASTEXITCODE -ne 0) { throw "Cannot resolve merge-base" }

   # Metadata (always collected — small output)
   git log "$BASE_SHA..$REVIEW_SHA" --oneline
   git diff "$BASE_SHA..$REVIEW_SHA" --name-only
   git diff "$BASE_SHA..$REVIEW_SHA" --stat
   git branch --show-current

   # Generate diff and determine strategy
   git diff "$BASE_SHA..$REVIEW_SHA" | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
   $DIFF_LINES = (Get-Content "$SESSION_DIR/diff.patch" | Measure-Object -Line).Lines

   if ($DIFF_LINES -le 500) {
     # Small diff → inline strategy (safe to read into context)
     Get-Content "$SESSION_DIR/diff.patch" -Raw
   }
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```

   **Scope: `commit:SHA`** — A single specified commit
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # If SHA is a branch name or ref (not a full commit hash), resolve it first
   RESOLVED_SHA=$(git rev-parse SHA)
   git rev-parse --verify "$RESOLVED_SHA"

   # Metadata (always collected — small output)
   git log -1 --oneline $RESOLVED_SHA
   git diff $RESOLVED_SHA~1..$RESOLVED_SHA --name-only 2>/dev/null || git show --stat $RESOLVED_SHA --format="" --name-only
   git diff $RESOLVED_SHA~1..$RESOLVED_SHA --stat 2>/dev/null || git show --stat $RESOLVED_SHA --format=""
   git branch --show-current

   # Generate diff and determine strategy
   # Note: If SHA is the root commit (no parent), SHA~1 does not exist.
   # Fall back to `git show` which handles root commits correctly.
   if git rev-parse --verify "$RESOLVED_SHA~1" >/dev/null 2>&1; then
     DIFF_OUTPUT=$(git diff $RESOLVED_SHA~1..$RESOLVED_SHA)
   else
     # Root commit: use git show to get the diff (shows all files added)
     DIFF_OUTPUT=$(git show $RESOLVED_SHA --format="" --patch)
   fi
   DIFF_LINES=$(echo "$DIFF_OUTPUT" | wc -l)

   if [ "$DIFF_LINES" -le 500 ]; then
     # Small diff → inline strategy (safe to read into context)
     echo "$DIFF_OUTPUT"
   else
     # Large diff → disk-offload strategy
     echo "$DIFF_OUTPUT" > "$SESSION_DIR/diff.patch"
   fi
   ```
   **PowerShell (Windows):**
   ```powershell
   # If SHA is a branch name or ref (not a full commit hash), resolve it first
   $RESOLVED_SHA = git rev-parse SHA
   git rev-parse --verify "$RESOLVED_SHA"

   # Metadata (always collected — small output)
   git log -1 --oneline $RESOLVED_SHA
   git diff "$RESOLVED_SHA~1..$RESOLVED_SHA" --name-only 2>$null; if ($LASTEXITCODE -ne 0) { git show --stat $RESOLVED_SHA --format="" --name-only }
   git diff "$RESOLVED_SHA~1..$RESOLVED_SHA" --stat 2>$null; if ($LASTEXITCODE -ne 0) { git show --stat $RESOLVED_SHA --format="" }
   git branch --show-current

   # Generate diff and determine strategy
   # Note: If SHA is the root commit (no parent), SHA~1 does not exist.
   # Fall back to `git show` which handles root commits correctly.
   git rev-parse --verify "$RESOLVED_SHA~1" 2>$null
   if ($LASTEXITCODE -eq 0) {
     $DIFF_OUTPUT = git diff "$RESOLVED_SHA~1..$RESOLVED_SHA"
   } else {
     # Root commit: use git show to get the diff (shows all files added)
     $DIFF_OUTPUT = git show $RESOLVED_SHA --format="" --patch
   }
   $DIFF_LINES = ($DIFF_OUTPUT | Measure-Object -Line).Lines

   if ($DIFF_LINES -le 500) {
     # Small diff → inline strategy (safe to read into context)
     $DIFF_OUTPUT
   } else {
     # Large diff → disk-offload strategy
     $DIFF_OUTPUT | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
   }
   ```

   **Scope: `range:SHA1..SHA2`** — A specified commit range
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # Special resolution for relative commit counts and date ranges:
   # - "Last N commits on branch REF" → SHA1=REF~N, SHA2=REF
   #   Example: range:master~20..master
   #   Verify: git rev-parse --verify REF~N
   #
   # - "Recent N months/weeks/days on branch REF" → Find the earliest commit in the time range:
   #   FIRST_SHA=$(git log REF --since="N months ago" --reverse --oneline | head -1 | cut -d' ' -f1)
   #   if git rev-parse --verify "$FIRST_SHA~1" >/dev/null 2>&1; then
   #     SHA1="$FIRST_SHA~1"
   #   else
   #     SHA1="$FIRST_SHA"
   #   fi
   #   SHA2=REF

   # If SHA1 or SHA2 is a branch name or ref, resolve it first
   RESOLVED_SHA1=$(git rev-parse SHA1)
   RESOLVED_SHA2=$(git rev-parse SHA2)
   git rev-parse --verify "$RESOLVED_SHA1"
   git rev-parse --verify "$RESOLVED_SHA2"

   # Metadata (always collected — small output)
   git log $RESOLVED_SHA1..$RESOLVED_SHA2 --oneline
   git diff $RESOLVED_SHA1..$RESOLVED_SHA2 --name-only
   git diff $RESOLVED_SHA1..$RESOLVED_SHA2 --stat
   git branch --show-current

   # Generate diff and determine strategy
   git diff $RESOLVED_SHA1..$RESOLVED_SHA2 > "$SESSION_DIR/diff.patch"
   DIFF_LINES=$(wc -l < "$SESSION_DIR/diff.patch")

   if [ "$DIFF_LINES" -le 500 ]; then
     # Small diff → inline strategy (safe to read into context)
     cat "$SESSION_DIR/diff.patch"
   fi
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```
   **PowerShell (Windows):**
   ```powershell
   # Special resolution for relative commit counts and date ranges:
   # - "Last N commits on branch REF" → SHA1=REF~N, SHA2=REF
   #   Example: range:master~20..master
   #   Verify: git rev-parse --verify REF~N
   #
   # - "Recent N months/weeks/days on branch REF" → Find the earliest commit in the time range:
   #   $FIRST_SHA = (git log REF --since="N months ago" --reverse --oneline | Select-Object -First 1) -replace ' .*',''
   #   git rev-parse --verify "$FIRST_SHA~1" 2>$null
   #   if ($LASTEXITCODE -eq 0) { $SHA1 = "$FIRST_SHA~1" } else { $SHA1 = "$FIRST_SHA" }
   #   $SHA2 = "REF"

   # If SHA1 or SHA2 is a branch name or ref, resolve it first
   $RESOLVED_SHA1 = git rev-parse SHA1
   $RESOLVED_SHA2 = git rev-parse SHA2
   git rev-parse --verify "$RESOLVED_SHA1"
   git rev-parse --verify "$RESOLVED_SHA2"

   # Metadata (always collected — small output)
   git log "$RESOLVED_SHA1..$RESOLVED_SHA2" --oneline
   git diff "$RESOLVED_SHA1..$RESOLVED_SHA2" --name-only
   git diff "$RESOLVED_SHA1..$RESOLVED_SHA2" --stat
   git branch --show-current

   # Generate diff and determine strategy
   git diff "$RESOLVED_SHA1..$RESOLVED_SHA2" | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
   $DIFF_LINES = (Get-Content "$SESSION_DIR/diff.patch" | Measure-Object -Line).Lines

   if ($DIFF_LINES -le 500) {
     # Small diff → inline strategy (safe to read into context)
     Get-Content "$SESSION_DIR/diff.patch" -Raw
   }
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```

   > **CRITICAL for disk-offload mode**: Never use `cat`, `type`, `Get-Content`, or any command that would read `$SESSION_DIR/diff.patch` into the main agent's context when using disk-offload strategy (diff > 500 lines). This file exists solely for reviewer subagents to read in Phase 4.

2. Gather supporting context (metadata only):
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # For staged scope
   git log --oneline -10
   git branch --show-current

   # For current-branch scope
   # Reuse the pinned BASE_SHA and REVIEW_SHA from Phase 1.
   git log "$BASE_SHA..$REVIEW_SHA" --oneline
   git branch --show-current

   # For all-branches scope
   git log --all --oneline -20
   git branch -a

   # For branch:REF scope
   # Reuse the pinned BASE_SHA and REVIEW_SHA for REF from Phase 1.
   git log "$BASE_SHA..$REVIEW_SHA" --oneline
   git branch --show-current

   # For commit:SHA scope
   RESOLVED_SHA=$(git rev-parse SHA)
   git log -1 --oneline $RESOLVED_SHA
   git branch --show-current

   # For range:SHA1..SHA2 scope
   RESOLVED_SHA1=$(git rev-parse SHA1)
   RESOLVED_SHA2=$(git rev-parse SHA2)
   git log $RESOLVED_SHA1..$RESOLVED_SHA2 --oneline
   git branch --show-current
   ```
   **PowerShell (Windows):**
   ```powershell
   # For staged scope
   git log --oneline -10
   git branch --show-current

   # For current-branch scope
   # Reuse the pinned BASE_SHA and REVIEW_SHA from Phase 1.
   git log "$BASE_SHA..$REVIEW_SHA" --oneline
   git branch --show-current

   # For all-branches scope
   git log --all --oneline -20
   git branch -a

   # For branch:REF scope
   # Reuse the pinned BASE_SHA and REVIEW_SHA for REF from Phase 1.
   git log "$BASE_SHA..$REVIEW_SHA" --oneline
   git branch --show-current

   # For commit:SHA scope
   $RESOLVED_SHA = git rev-parse SHA
   git log -1 --oneline $RESOLVED_SHA
   git branch --show-current

   # For range:SHA1..SHA2 scope
   $RESOLVED_SHA1 = git rev-parse SHA1
   $RESOLVED_SHA2 = git rev-parse SHA2
   git log "$RESOLVED_SHA1..$RESOLVED_SHA2" --oneline
   git branch --show-current
   ```

3. **Analyze architectural impact** (see `references/impact-analysis.md`):

   **当 graph 可用时**（graph 优先导航，grep 验证补充）：
    - **Step 3a: Graph 导航定位** — 用 graph 快速定位"该查哪里"
      - 调用 `detect_changes_tool(base=$BASE_SHA, changed_files=[<git diff --name-only 的文件列表>], detail_level="minimal")` 获取风险评分，识别高风险变更点。**必须传 base=$BASE_SHA**（已解析的比较起点；分支范围为 merge-base），否则默认 HEAD~1 只分析最后一个 commit，全量审查场景下风险评分严重失真。**该工具已聚合受影响函数、flows、测试覆盖缺口**，优先复用其输出，避免逐文件重复查询（对齐 code-review-graph 官方"≤5 tool calls"目标）
      - **交叉验证**: 对比 `git diff --name-only` 输出与 `detect_changes_tool` 结果。如果某变更文件在 git diff 中出现但 `detect_changes_tool` 未返回该文件的任何函数/类，在导航提示中标注"⚠️ 图谱未索引此文件中的函数，reviewer 需自行 Grep/Read 检查"
      - **仅对 top-N 高风险函数**调用 `get_impact_radius_tool(changed_files=[<top-N 函数所在文件>], base=$BASE_SHA, detail_level="minimal")` 获取上游调用方和下游依赖（替代 `grep -r "import.*from.*changed-file"`）。N 自适应：变更 ≤5 文件取全部，6-20 文件取 top-3，>20 文件取 top-5（避免对每个变更文件都调用导致 token 超预算）。注意 get_impact_radius_tool 按 changed_files（文件级）分析，传 top-N 高风险函数**所在文件**
      - 调用 `get_affected_flows_tool(changed_files=[<git diff --name-only 的文件列表>], base=$BASE_SHA)` 获取受影响执行路径（识别跨模块/跨层边界影响）。**必须传入 changed_files 参数**（从 `git diff --name-only` 获取的变更文件列表），否则返回的是全图 flows 而非"受本次变更影响的 flows"，数据会误导。注意该工具无 `detail_level` 参数；base 必须使用已解析的 $BASE_SHA，避免默认 HEAD~1 缩小审查范围
      - **仅对 top-N 高风险函数**调用 `query_graph_tool(pattern="tests_for")` 检查测试覆盖缺口（`detect_changes_tool` 已提供大部分测试缺口信息，此处仅补充高风险函数的精确匹配）
      - 生成导航提示写入 context.md：只给出"该查哪里"的方向，不做代码级判断，控制在 500-800 token 以内（只列最关键的导航方向）
      - 注意标注 graph 不覆盖的区域（MyBatis XML、配置文件等），提示 reviewer 用 Grep/Read 补充
      - **Disk-offload 模式补偿**（当 diff > 500 行、Tech Lead 未读 diff 时）：额外调用 `get_review_context_tool(changed_files=[<git diff --name-only 的文件列表>], base=$BASE_SHA, include_source=True, max_lines_per_file=200, detail_level="minimal")` 拿到变更函数的精简源码片段，补偿"读不到 diff"的信息缺失。**必须传 base 和 changed_files**，否则默认 HEAD~1 只拿最后一个 commit 的源码。`include_source=True` 会增大返回，`max_lines_per_file` 上限控制单文件 token；仅在此 disk-offload 场景使用，inline 模式不需要
      - **Disk-offload 模式架构概览补偿**（当 diff > 500 行时，可选）：调用 `get_architecture_overview_tool(detail_level="minimal")` 获取跨社区耦合警告与架构概览（minimal 模式 600KB→<5KB，token 友好）。这在 Tech Lead 无法读 diff 时提供结构级上下文，弥补"读不到 diff"的架构影响判断缺失。若 graph 工具调用已达软预算则 skip
   - **Step 3b: Grep 验证补充** — 补充 graph 不覆盖的依赖
     - 对变更的 Repository/DAO/Mapper 文件，搜索对应的 XML 映射：`grep -rl "namespace" --include="*.xml" src/main/resources/`
     - 对变更文件，检查 Spring 配置引用：`grep -rl "beanName" --include="*.xml" --include="*.yml" --include="*.properties" src/main/resources/`
     - 将 grep 补充发现追加到 context.md 的导航提示中
   - **失败处理**：单个 graph 查询失败 → 对该部分回退 grep，标注回退原因；全部失败 → 视为 graph 不可用
   - **记录到 Graph Usage Log**：每次 graph 工具调用后，立即向 context.md 的 Graph Usage Log 表追加一行（Phase=2, Tool, Target/Params, Status, Est. Tokens, Fallback）。Status 用 ok/partial/fail/skip。graph 不可用时不调用 graph 工具，故不追加 Phase 2 调用行（整体"未使用"标注见降级流程与 context.md 模板说明）

   **当 graph 不可用时**（纯 grep 流程，与 v1.1.0 完全一致）：
   - **Inline mode**: Analyze directly from the diff — trace specific code-level dependencies, identify affected interfaces, assess change propagation risk with full code visibility
   - **Disk-offload mode**: Analyze from metadata — trace upstream/downstream dependencies based on file list and stats, identify which system boundaries are affected (from file paths and directory structure), determine if change crosses module/service boundaries (from path analysis), assess risk of change propagation (from stat numbers — large changes in core modules = high risk). Reviewer subagents will validate and refine with the full diff.

3b. **Profiling file path resolution** (execute when profiling keywords are present in prompt/requirements — trigger detection itself is Phase 3 Step C's job, NOT this step's):

   Profiling files (flame graphs, GC logs, heap dumps, JFR recordings) can be extremely large. **Do NOT read them in the main agent.** The profiling-analysis reviewer handles all data extraction and analysis independently.

   > **Scope of this step**: This step ONLY resolves profiling file paths and records them in `context.md`. It does NOT decide whether to trigger the profiling-analysis reviewer — that decision is Phase 3 Step C's (keyword scan). This step runs because profiling keywords were already detected (or the user explicitly added profiling-analysis via `--team`), so the reviewer will be in the team and will need file paths. If profiling keywords are present but the user provided NO file paths, see the degradation warning below.

   **Resolve file paths** (if the user provided paths/URLs in the prompt):
   1. If user provided **individual file paths**, record them directly
   2. If user provided a **directory path**, list the directory to find profiling files:
      **Bash (Linux / macOS / Git Bash):**
      ```bash
      ls -la <directory>/*.html <directory>/*.collapsed <directory>/*.log <directory>/*.jfr <directory>/*.hprof 2>/dev/null
      ```
      **PowerShell (Windows):**
      ```powershell
      Get-ChildItem -Path <directory> -Include *.html,*.collapsed,*.log,*.jfr,*.hprof -File -Recurse -ErrorAction SilentlyContinue
      ```
      Record all matching files as profiling sources
   3. Record the file paths in `context.md`:
      ```markdown
      ## Profiling Data Status
      - **Available**: Yes
      - **Source files**: {list of original profiling file paths}
      - **Note**: Profiling data will be analyzed by the profiling-analysis reviewer. Do NOT attempt to read large flame graph files in the main agent context.
      ```

   > **⚠️ Degradation warning (diagnostic mode active but no files)**: If diagnostic mode is active (profiling keywords present, OR profiling-analysis added via `--team`/config — see Phase 1 equivalence invariant) BUT the user provided NO profiling file paths/URLs, record in `context.md`:
   > ```markdown
   > ## Profiling Data Status
   > - **Available**: No
   > - **Warning**: Profiling keywords detected (diagnostic mode active) but no profiling files provided. The profiling-analysis reviewer will have no data to extract; `hotspot-inventory.md` will NOT be produced. Phase 4 Wave 2 will degrade to normal diff mode (see Phase 4 fallback). Recommend the user provide profiling file paths.
   > ```
   > This makes the inevitable degradation visible early (Phase 2), rather than surfacing silently in Phase 4.

   **Do NOT**: Read or parse profiling file contents in the main agent. The profiling-analysis reviewer handles all data extraction and analysis independently.

   **DO**: The profiling-analysis reviewer MUST persist its Hot Stack Inventory to `$SESSION_DIR/hotspot-inventory.md` (see `references/reviewers/specialist/profiling-analysis.md` Step 1 "MANDATORY: Persist Hot Stack Inventory to Disk"). The main agent does NOT generate this file — the reviewer does. The Tech Lead reads `hotspot-inventory.md` during Phase 7 (synthesis) to cross-reference profiling evidence with other reviewers' findings.

4. Create session directory:
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   mkdir -p "$SESSION_DIR/rounds/round-1/reviews"
   ```
   **PowerShell (Windows):**
   ```powershell
   New-Item -ItemType Directory -Path "$SESSION_DIR/rounds/round-1/reviews" -Force | Out-Null
   ```

5. Save context to `context.md` (所有内容必须使用中文，代码路径和命令保持英文):
   ```markdown
   # 审查上下文

   **会话**: {SESSION_ID}
   **范围**: {暂存更改 | 当前分支相对目标分支的变更 | 各分支相对目标分支的变更 | 指定分支(REF)相对目标分支的变更 | 指定提交(SHA) | 指定范围(SHA1..SHA2)}
   **目标**: {审查内容描述}
   **分支**: {current branch} (工作分支) | {REF} (审查目标分支，仅 branch:REF/commit:REF)
   **文件**: 变更 {count} 个文件
   **提交**: 审查 {count} 个提交（适用于 current-branch/all-branches 范围）
   **Diff 策略**: {Inline | Disk-offload}（{DIFF_LINES} 行{，> 500 行触发磁盘卸载 | ，≤ 500 行直接读取}）
   **Diff 文件**: {$SESSION_DIR/diff.patch（供 reviewer subagent 读取） | N/A（inline 模式）}
   **图谱增强**: {是 | 否}

   ## 变更摘要
   [{inline 模式：基于完整 diff 的详细摘要 | disk-offload 模式：基于文件列表、stat 数字和 commit message 推断的变更内容简述}]
   [⚠️ 以业务功能脉络组织（按功能/特性分组描述变更意图），而非仅列模块/技术清单。图谱结构数据放下方"架构影响分析"独立章节，不得挤占本业务摘要]

   ## 受影响文件
   - path/to/file1.ts
   - path/to/file2.ts

   ## 提交历史（适用于 current-branch/all-branches 范围）
   [列出 commit 的 hash + message，便于用户将审查发现追溯到具体提交。数量自适应：≤20 个提交则全列；>20 个则列最近 ~10 个并在末尾标注"... 共 N 个提交（省略较早的 M 个）"。不可因 graph 数据挤占而省略本节]
   - abc1234: feat: add user authentication
   - def5678: fix: handle token expiry
   ...

   ## 架构影响分析
   [graph 可用时: 知识图谱导航提示（高风险变更点、调用链、影响半径、测试覆盖缺口、边界跨越、共享状态可见性变更对读取侧的影响、graph 未覆盖区域标注）——作为独立章节，不挤占上方业务摘要和提交历史]
   [graph 不可用时 inline 模式：基于完整 diff 的深度分析]
   [graph 不可用时 disk-offload 模式：基于文件路径和目录结构推断的影响分析]
   [disk-offload 模式附加：注意：此分析基于元数据推断，reviewer subagent 将基于完整 diff 进行验证]
   ```

### Phase 2 Checkpoint

**STOP and verify before proceeding (self-check, do NOT ask the user):**
- [ ] Session directory created: `$SESSION_DIR/`
- [ ] `rounds/round-1/reviews/` subdirectory created
- [ ] Diff size determined: inline (≤500 lines) or disk-offload (>500 lines)
- [ ] If disk-offload: `diff.patch` written to `$SESSION_DIR/diff.patch` and main agent context does NOT contain the full diff content
- [ ] If inline: main agent context contains the diff, no diff.patch file needed
- [ ] `context.md` written with change summary AND impact analysis (persisted to disk)
- [ ] `context.md` content is in Chinese (code/file paths remain in original form)
- [ ] `context.md` 变更摘要以业务功能脉络组织（非仅模块技术清单）
- [ ] `context.md` 提交历史按自适应数量列出 commit（不可因 graph 数据挤占而省略）
- [ ] `context.md` documents the diff strategy (inline or disk-offload)
- [ ] If profiling files referenced: Profiling Data Status section written in `context.md` with file paths; do NOT generate `hotspot-inventory.md` in the main agent (the profiling-analysis reviewer produces it in Phase 4)
- [ ] `context.md` documents graph enhancement status (是/否)
- [ ] If graph available: navigation tips generated with high-risk points, call chains, test coverage gaps, and graph-gap areas noted
- [ ] If graph available: grep verification completed for graph-gap areas (MyBatis XML, config files)
- [ ] If graph available: Graph Usage Log populated with Phase 1/2 tool calls (incl. skip/fail); if unavailable: single "未使用" line written
- [ ] Helper `complete --phase 2` succeeded

---

## Phase 3: Tech Lead Analysis

**Goal**: Summarize changes, analyze against requirements, identify risks, select reviewers.

### Steps

1. Review requirements (if provided):
   - What is the code SUPPOSED to do?
   - What are the acceptance criteria?
   - What edge cases are implied?

2. Analyze the available context to understand:
   - What functionality is being added/changed/removed?
     - **Inline mode**: Analyze directly from the diff content — identify specific code changes, patterns, and potential issues
     - **Disk-offload mode**: Infer from file paths, commit messages, and stat numbers — identify change types and risk areas at a directory/module level
   - Does this align with requirements?
   - What is the likely intent?
     - **Inline mode**: Determine from actual code changes
     - **Disk-offload mode**: Infer from commit messages and changed directories
   - What are the potential risk areas?
     - **Inline mode**: Identify specific code-level risks (e.g., missing null checks, unsafe operations)
     - **Disk-offload mode**: Infer from stat numbers — large changes in core modules = high risk
   - What architectural boundaries are affected?
     - **Inline mode**: Trace specific cross-module dependencies from the diff
     - **Disk-offload mode**: Infer from directory structure and file path patterns

3. Create dynamic guidance for reviewers:
   ```markdown
   ## Tech Lead Guidance

   ### Requirements Summary (if provided)
   [Summarize what the code should implement]

   ### Change Summary
   [Inline: Detailed summary based on full diff analysis]
   [Disk-offload: Summary based on file paths, commit messages, and stat analysis]

   ### Requirements Assessment
   [Gap analysis between requirements and implementation]
   [Disk-offload: note that this is preliminary — reviewers with full diff will validate]

   ### Architecture Impact
   [Inline: Detailed findings from full diff analysis]
   [Disk-offload: Findings based on file paths and directory structure — reviewers will validate]

   ### Graph Navigation Insights（当 graph 可用时）
   [基于知识图谱的结构级洞察，指导 reviewer "该查哪里"]
   [高风险变更点及其调用链上下文]
   [测试覆盖缺口]
   [跨层/跨模块边界违规]
   [Graph 未覆盖区域标注，提示 reviewer 用 Grep/Read 补充]

   ### Graph Usage Log（当 graph 可用时记录；不可用时标注"未使用"）
   [每次 graph 工具调用追加一行，格式如下。用于事后审计 graph 使用情况与 token 成本]
   | Phase | Tool | Target/Params | Status | Est. Tokens | Saved Tokens | Fallback |
   |-------|------|---------------|--------|-------------|--------------|----------|
   | 1 | list_graph_stats_tool | - | ok | ~50 | - | - |
   | 1 | get_minimal_context_tool | task="ultra-cr code review" | ok | ~120 | - | - |
   | 2 | detect_changes_tool | detail_level="minimal" | ok | ~400 | ~12932 (94%) | - |
   | 2 | get_impact_radius_tool | top-N funcs | partial | ~300 | ~8500 (88%) | grep 补充 1 处 |
   | 3 | get_hub_nodes_tool | top_n=10 | skip(无命中) | 0 | - | - |
   | 3 | get_surprising_connections_tool | top_n=15 | skip(预算紧张) | 0 | - | - |
   [Status 取值: ok / partial(部分回退 grep) / skip(条件不满足跳过) / fail(失败回退 grep)]
   [Saved Tokens 取值: 从工具返回的 context_savings.saved_tokens 提取（格式 "~{n} ({p}%)"），无此字段的工具填 "-"]
   [Saved Tokens 为 0/负时填 "0"，并在 Phase 8 汇总文案兜底]
   [graph 不可用时仅写一行: "graph 未启用，本次审查未使用图谱工具"]

   ### Risk-Based Reviewer Suggestions（当 graph 可用时）
   [基于 detect_changes_tool 风险评分的 reviewer 建议]
   [注意: 风险评分基于结构级分析，内容级风险仍需 grep 识别]

   ### Clarifying Questions (Tech Lead)
   [Questions about requirements, scope, edge cases]

   ### Risk Areas
   [Inline: Specific code-level risks identified from the diff]
   [Disk-offload: Areas inferred from stat numbers and path patterns]
   [Graph 可用时: 基于 detect_changes_tool 风险评分的结构级风险]

   ### Focus Points
   [Inline: Specific lines/patterns for reviewers to check]
   [Disk-offload: Areas/directories for reviewers to focus on]
   [Graph 可用时: 基于 graph 导航提示的精准定位方向]
   ```

4. **Resolve reviewer team**:
   - Read team from `.ultra-cr.yaml` or use defaults
   - Apply `--team` override from $ARGUMENTS if present
   - Apply auto-detection rules for additional reviewers
   - Handle `--reviewer` ephemeral reviewers if present
   - **Custom reviewer auto-detection (intelligent matching)**: Scan the BUNDLED reviewer directory (located inside the ultra-cr skill installation — try `${SKILL_ROOT}/references/reviewers/bundled` first, then `references/reviewers/bundled`) for ALL subdirectories (each subdirectory is a reviewer; the directory name is the reviewer ID), and scan `~/.config/ultra-cr/reviewer/`, `.reviews/ultra-cr/reviewer/` for ALL subdirectories too (same convention — each subdirectory is a reviewer). For each one NOT already in the team config, read its persona body (the direct-level `.md` file(s) inside the subdirectory; title, intro, Focus Areas, etc.) and judge whether its engineering risk applies to actual changed behavior. Skip programming-language specialist personas, even when they also mention general risks; assign those risks to domain reviewers. If applicable → add it to the team (does NOT count toward the 6-reviewer limit). This is an LLM judgment. The reviewer's own description is the signal. See Step H for the full procedure.
   > **Example**: The `behavior-regression/` persona examines shared-state write/read invariants. Add it when changed writes can alter downstream read behavior, independent of implementation language. Do not add custom reviewers for language/file-extension matches alone.
   - **Graph-enhanced risk-based reviewer selection**（当 graph 可用时）:
     - 从 Phase 2 的 graph 导航提示中提取高风险函数/类
     - 高风险变更（risk_score >= 0.7，0-1 浮点数）但尚未有对应 reviewer 时，应当添加（受 Step E 6-reviewer 自动检测上限约束，优先级同自动检测规则）：
       - 安全相关高风险 → 确保 Security reviewer 在团队中
       - 并发相关高风险 → 确保 Architect reviewer 在团队中
       - 数据相关高风险 → 确保 Data reviewer 在团队中
     - 在 Tech Lead Guidance 中记录基于风险评分的 reviewer 建议（标注"知识图谱"来源）
     - 注意: 风险评分基于结构级分析（调用链深度、依赖数量、是否在关键路径），内容级风险（如 SQL 注入、硬编码密钥）仍需 grep 扫描识别

5. **Load reference files for custom reviewers** (MUST do this before Phase 4):
   For every custom reviewer in the resolved team, load its reference files. All three search paths use the **same** directory convention — there is no per-path divergence:

   - **Every custom reviewer** (BUNDLED path `${SKILL_ROOT}/references/reviewers/bundled/{reviewer-id}/` or `references/reviewers/bundled/{reviewer-id}/`; user-global `~/.config/ultra-cr/reviewer/{reviewer-id}/`; project-level `.reviews/ultra-cr/reviewer/{reviewer-id}/`): The reviewer is a subdirectory. Its **persona** = ALL `.md` files at the directory's **direct level** (read and concatenate them — they form the persona body). Its **reference files** = ALL `.md` files inside ANY subdirectory of `{reviewer-id}/` (recursively, any depth). Read each reference file's full content — they are attached to the reviewer's prompt in Phase 4.

   No declaration or frontmatter is needed; the reviewer persona body tells the reviewer how to use these files.

   **Reference file locations** (same rule for all three paths — reference = all `.md` in the reviewer subdirectory's subdirectories; persona = direct-level `.md`):
   - Bundled reviewers: `references/reviewers/bundled/{reviewer-id}/` (subdirectories)
   - User-global reviewers: `~/.config/ultra-cr/reviewer/{reviewer-id}/` (subdirectories)
   - Project-level reviewers: `.reviews/ultra-cr/reviewer/{reviewer-id}/` (subdirectories)

   **How to load**: For each reference `.md` file found, read its full content. Record the loaded file list in `context.md` so Phase 4 knows what to attach:
   ```markdown
   ### {ReviewerName} Reference Files
   - ✅ {file} (loaded from references/reviewers/bundled/{reviewer-id}/<subdir>/)
   - ✅ {file} (loaded from references/reviewers/bundled/{reviewer-id}/<subdir>/)
   ```
   Example:
   ```markdown
   ### Behavior Regression Reference Files
   - ✅ regression-checklist.md
   ```

   > **No SKILL.md/workflow.md edits needed for new reviewers**: Because loading is driven by a single directory-level convention (direct-level `.md` = persona, subdirectory `.md` = references) shared by all three paths, adding a new reviewer subdirectory (with persona `.md` and optional reference subdirectories) under any path requires NO changes to this file or `SKILL.md`. The example above uses `behavior-regression` only for illustration — the same mechanism applies to any custom reviewer on any path.

6. **Auto-detection scan** (MUST execute before Phase 4):

   Scan the file list, stats, and (if inline mode) diff content to determine additional reviewers beyond the configured team.

   **Adaptive approach**: The scan method depends on the diff strategy:
   - **Inline mode**: The main agent has the full diff in context, so content pattern scans can search the diff directly
   - **Disk-offload mode**: The main agent only has metadata, so content pattern scans must search individual source files using `grep`/`Select-String`

   **Step A: File Extension Scan**
   Extract file extensions from the file list (already collected in Phase 2):
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   echo "$FILE_LIST" | sed 's/.*\.//' | sort | uniq -c | sort -rn
   ```
   **PowerShell (Windows):**
   ```powershell
   $FILE_LIST -split "`n" | ForEach-Object { $_ -replace '.*\.','' } | Group-Object | Sort-Object Count -Descending | Format-Table Count,Name
   ```
   Use extensions to locate candidate domains, then confirm a concrete risk in the changed behavior before adding a reviewer. Do not select a reviewer from the programming language alone:
   - UI/component/layout/state changes → +1 Frontend (source extensions only help locate them)
   - `Dockerfile`/k8s `.yaml`/`.tf` → +1 DevOps
   - SQL/migration files → +1 Data

   **Step B: Content Pattern Scan**
   - **Inline mode**: Search the diff (already in context) for trigger keywords directly
   - **Disk-offload mode**: Scan individual source files for trigger keywords using `grep`/`Select-String`:
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # Security patterns
   grep -ilE 'auth|token|password|secret|permission|encrypt' $FILE_LIST 2>/dev/null
   # API route patterns
   grep -ilE '@(Request|Get|Post|Put|Delete)Mapping|router\.(get|post)|app\.(get|post)' $FILE_LIST 2>/dev/null
   # Performance patterns
   grep -ilE 'cache|index|query|N\+1|latency|benchmark' $FILE_LIST 2>/dev/null
   # Reliability patterns
   grep -ilE 'retry|circuit.?break|timeout|fallback|health.?check' $FILE_LIST 2>/dev/null
   # AI patterns
   grep -ilE 'prompt|embedding|openai|langchain|llm|model.*call' $FILE_LIST 2>/dev/null
   # Abstraction patterns
   grep -ilE '(interface|abstract\s+class|protocol|trait)\s+\w+' $FILE_LIST 2>/dev/null
   ```
   **PowerShell (Windows):**
   ```powershell
   # Bash word-splits $FILE_LIST into multiple paths; PowerShell must split explicitly
   $files = $FILE_LIST -split "`n"
   # Security patterns
   Select-String -Path $files -Pattern 'auth|token|password|secret|permission|encrypt' -List -ErrorAction SilentlyContinue
   # API route patterns
   Select-String -Path $files -Pattern '@(Request|Get|Post|Put|Delete)Mapping|router\.(get|post)|app\.(get|post)' -List -ErrorAction SilentlyContinue
   # Performance patterns
   Select-String -Path $files -Pattern 'cache|index|query|N\+1|latency|benchmark' -List -ErrorAction SilentlyContinue
   # Reliability patterns
   Select-String -Path $files -Pattern 'retry|circuit.?break|timeout|fallback|health.?check' -List -ErrorAction SilentlyContinue
   # AI patterns
   Select-String -Path $files -Pattern 'prompt|embedding|openai|langchain|llm|model.*call' -List -ErrorAction SilentlyContinue
   # Abstraction patterns
   Select-String -Path $files -Pattern '(interface|abstract\s+class|protocol|trait)\s+\w+' -List -ErrorAction SilentlyContinue
   ```

   **Step C: User Intent Scan (Profiling Keywords)**
   Unlike other auto-detection patterns that scan the diff, profiling detection scans the user's prompt and requirements for profiling-related keywords:

   > **Keyword-only trigger (no file-extension matching)**: Triggering requires profiling keywords in the prompt. A bare file path (e.g., "帮我看看 `/tmp/cpu-2026.html`") **does NOT trigger** if it contains no profiling keyword — common extensions like `.html`/`.log` are too generic and would cause false positives. If a user provides only a file path, the Tech Lead notes in `discovered-standards.md` that profiling was NOT auto-triggered and the user may add a profiling keyword (火焰图/flame graph/GC log/jfr/heap dump/etc.) to enable profiling review.

   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # Scan requirements.md for profiling keywords (NOT the diff)
   # Note: User prompt content is captured in requirements.md during Phase 1
   grep -iE '火焰图|flame.?graph|async.profiler|GC.?log|GC日志|heap.?dump|cpu.?profile|性能分析|性能热点|profiling|jfr|allocHumongous|Full.?GC|内存泄漏|OOM|OutOfMemory' "$SESSION_DIR/requirements.md" 2>/dev/null
   ```
   **PowerShell (Windows):**
   ```powershell
   # Scan requirements.md for profiling keywords (NOT the diff)
   # Note: User prompt content is captured in requirements.md during Phase 1
   Select-String -Path "$SESSION_DIR/requirements.md" -Pattern '火焰图|flame.?graph|async.profiler|GC.?log|GC日志|heap.?dump|cpu.?profile|性能分析|性能热点|profiling|jfr|allocHumongous|Full.?GC|内存泄漏|OOM|OutOfMemory' -ErrorAction SilentlyContinue
   ```
   If ANY match → +1 Profiling Analysis (does NOT count toward 6-reviewer limit) AND enter **profiling-diagnostic mode** (see Phase 1). Document the triggering keyword in `discovered-standards.md`.

   **Step D: Scale Analysis**
   Use stats already collected in Phase 2:
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   FILE_COUNT=$(echo "$FILE_LIST" | wc -l)
   LINE_COUNT=$STAT_LINE  # From Phase 2 stat output
   ```
   **PowerShell (Windows):**
   ```powershell
   $FILE_COUNT = ($FILE_LIST -split "`n" | Where-Object { $_ -ne '' }).Count
   $LINE_COUNT = $STAT_LINE  # From Phase 2 stat output
   ```
   - FILE_COUNT > 10 or LINE_COUNT > 500 → +1 Martin Fowler
   - Changes span >3 distinct directories → +1 Architect

   **Step E: Path Analysis**
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   echo "$FILE_LIST" | sed 's|/[^/]*$||' | sort -u
   ```
   **PowerShell (Windows):**
   ```powershell
   $FILE_LIST -split "`n" | ForEach-Object { $_ -replace '/[^/]*$','' } | Sort-Object -Unique
   ```
   - `android/`, `ios/`, `react-native/`, `flutter/` → +1 Mobile
   - `terraform/`, `k8s/`, `helm/`, `ansible/` → +1 Infrastructure
   - New directory with core business logic → +1 John Ousterhout

   **Step F: Compile Additional Reviewers**
   1. Collect all triggered **built-in** reviewers
   2. Deduplicate (already in team config = skip)
   3. If count > 6, apply priority: Security > Reliability > Architect > Performance > Specialist > Persona
   4. Add to resolved team
   5. Document each addition with trigger reason in Tech Lead Guidance:
   ```markdown
   ### Auto-Detection Results (Built-in, max 6)
   - ✅ +1 Security (triggered by: an authentication boundary changed in the request handler)
   - ✅ +1 Frontend (triggered by: component state transitions changed)
   - ⬜ +1 Performance (not triggered)
   - Max 6 additional built-in reviewers applied: 2 of 6 used
   ```

   **Step G: Exempt Reviewers (no limit)**
   The following reviewers are ALWAYS added when triggered and do NOT count toward the 6-reviewer limit:
   - **Custom reviewers auto-detected via intelligent matching**: any reviewer under `references/reviewers/bundled/`, `~/.config/ultra-cr/reviewer/`, or `.reviews/ultra-cr/reviewer/` whose persona body indicates it is applicable to the current change (detected in Phase 3 Step 4 / Step H). This replaces any hard-coded per-reviewer rule — ALL custom reviewers are candidates, judged by the Tech Lead from their own description.
   - **Profiling Analysis**: +1 if profiling keywords found in user prompt/requirements (detected in Step C above); entering profiling-diagnostic mode
   - **Custom reviewers explicitly requested**: any custom reviewer the user added via `--team={reviewer-id}:1`, natural language, or `.ultra-cr.yaml` (whether or not it was auto-detected).

   Document exempt reviewers separately:
   ```markdown
   ### Exempt Reviewers (no limit, always added when triggered)
   - ✅ +1 behavior-regression (auto-detected: shared-state visibility changed)
   - ✅ +1 Profiling Analysis (triggered by: "火焰图" keyword in user prompt; profiling-diagnostic mode ON)
   ```

   **Step H: Custom Reviewer Intelligent Auto-Detection** (does NOT count toward the 6-reviewer limit) — MANDATORY, NEVER SKIP

   Custom reviewers are auto-detected by intelligent matching. The Tech Lead reads each reviewer's persona body and judges risk applicability; source language alone is not a trigger. This step is MANDATORY for every review regardless of diff strategy (inline or disk-offload) or change size. Even a 1-file, 10-line change MUST run this scan.

   > **Why mandatory**: BUNDLED custom reviewers encode risk-specific knowledge, such as write/read invariants in `behavior-regression`. Language-specialist matches alone are not eligible. Skipping the scan silently drops these reviewers and misses critical findings. A scan that returns zero results is only acceptable if ALL search paths were actually checked and empty — never because a command failed silently.

   **Custom reviewer search paths** — all three use the SAME directory convention (each subdirectory = a reviewer). The BUNDLED directory lives inside the ultra-cr skill installation, NOT in the reviewed project. Scan ALL of these locations (not "first that exists" — a reviewer may live under any of them):

   | # | Path (Bash & PowerShell identical) | What it is |
   |---|-----------|------------|
   | 1 | `${SKILL_ROOT}/references/reviewers/bundled` | BUNDLED skill-bundled reviewers (most common; subdirectory = reviewer) |
   | 2 | `references/reviewers/bundled` | BUNDLED path relative to skill root (when CWD = skill dir) |
   | 3 | `$HOME/.config/ultra-cr/reviewer` | User-global custom reviewers (subdirectory = reviewer) |
   | 4 | `.reviews/ultra-cr/reviewer` | Project-level custom reviewers (subdirectory = reviewer) |

   > Paths 1 & 2 are the same BUNDLED directory resolved two ways (try 1 first, then 2). Paths 3 & 4 are independent and must both be scanned. All four locations use identical discovery logic: each subdirectory directly under the root is a reviewer (directory name = reviewer ID), gated by an empty-dir guard (direct-level `.md` must exist).

   **List ALL available custom reviewers** (Bash + PowerShell — use only the example matching the current shell; behavior is equivalent):

   ```bash
   # Bash — locate the BUNDLED directory (try global skill install first, then relative)
   BUNDLED_DIR=""
   for d in "${SKILL_ROOT}/references/reviewers/bundled" "references/reviewers/bundled"; do
     [ -d "$d" ] && BUNDLED_DIR="$d" && break
   done
   # Helper: list reviewer subdirectories under a root (each subdirectory = a reviewer; empty-dir guard)
   # Usage: _list_reviewers <root> <prefix>
   _list_reviewers() {
     [ -d "$1" ] || return 0
     for sub in "$1"/*/; do
       [ -d "$sub" ] || continue
       rid=$(basename "$sub")
       # persona = direct-level .md files; only list if at least one exists (empty-dir guard)
       pers=$(find "$sub" -maxdepth 1 -type f -name '*.md' -print -quit 2>/dev/null)
       [ -n "$pers" ] && echo "$2:$rid"
     done
   }
   # BUNDLED reviewers
   _list_reviewers "$BUNDLED_DIR" "bundled"
   # User-global reviewers (same convention: each subdirectory = a reviewer)
   _list_reviewers "$HOME/.config/ultra-cr/reviewer" "user"
   # Project-level reviewers (same convention: each subdirectory = a reviewer)
   _list_reviewers ".reviews/ultra-cr/reviewer" "project"
   ```

   ```powershell
   # PowerShell — locate the BUNDLED directory (try global skill install first, then relative)
   $bundledDir = $null
   foreach ($d in @("${SkillRoot}/references/reviewers/bundled", "references/reviewers/bundled")) {
     if (Test-Path $d) { $bundledDir = $d; break }
   }
   # Helper: list reviewer subdirectories under a root (each subdirectory = a reviewer; empty-dir guard)
   # Usage: List-Reviewers <root> <prefix>
   function List-Reviewers($root, $prefix) {
     if (-not (Test-Path $root)) { return }
     Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
       $rid = $_.Name
       # persona = direct-level .md files; only list if at least one exists (empty-dir guard)
       $pers = Get-ChildItem -Path $_.FullName -File -Filter '*.md' -ErrorAction SilentlyContinue | Select-Object -First 1
       if ($pers) { "$prefix`:$rid" }
     }
   }
   # BUNDLED reviewers
   List-Reviewers $bundledDir "bundled"
   # User-global reviewers (same convention: each subdirectory = a reviewer)
   List-Reviewers "$HOME/.config/ultra-cr/reviewer" "user"
   # Project-level reviewers (same convention: each subdirectory = a reviewer)
   List-Reviewers ".reviews/ultra-cr/reviewer" "project"
   ```

   **MANDATORY verification** — after running the scan, you MUST confirm at least one search path was reachable. If ALL paths returned nothing (i.e. no reviewer subdirectory was found under any root), emit a WARNING in Tech Lead Guidance:
   ```markdown
   ### Custom Reviewers (no limit, auto-detected + user-requested)
   ⚠️ WARNING: No custom reviewer search path was reachable. Checked:
     - ${SKILL_ROOT}/references/reviewers/bundled (not found)
     - references/reviewers/bundled (not found)
     - $HOME/.config/ultra-cr/reviewer (not found)
     - .reviews/ultra-cr/reviewer (not found)
   If custom reviewers are expected, verify the ultra-cr skill is installed / the reviewer directories exist.
   ```
   This warning MUST appear — never silently report "no custom reviewers applicable" without first confirming the paths were checked.

   For each custom reviewer found (that is NOT already in team config):
   1. **Read the reviewer's persona body** (title, intro, Focus Areas, What You Look For, etc.). The persona = ALL `.md` files at the direct level of the reviewer subdirectory (concatenate them — read via the file path printed above). This rule is identical for BUNDLED, user-global, and project-level reviewers.
   2. Judge whether this reviewer covers a concrete changed risk, using its persona and the changed behavior as evidence. Skip programming-language specialist personas; source language/extensions alone do not establish applicability.
   3. If applicable → add it to the resolved team (does NOT count toward the 6-reviewer limit)
   4. Deduplication: skip if already in team config or already added by the user via `--team`/natural language/`.ultra-cr.yaml`
   5. For each added reviewer, load its reference files per Step 5 above (all `.md` files in ALL subdirectories of the reviewer's directory, recursively — same rule for all three paths).
   6. **Document EVERY found reviewer** — even non-applicable ones must be listed as "available, not applicable" (so the scan is auditable). Example:
   ```markdown
   ### Custom Reviewers (no limit, auto-detected + user-requested)
   - ✅ +1 behavior-regression (auto-detected: shared-state write changes downstream read behavior)
   - ⬜ resource-lifecycle (available, not applicable: no resource ownership changes)
   ```

   > **No framework edits needed for new reviewers**: Because matching is driven by the reviewer's own persona description, adding a new reviewer subdirectory (with persona `.md` at direct level, plus optional reference subdirectories) under any of the three search paths is all that's required. The Tech Lead will discover and judge it automatically on the next review.

   Document custom reviewers in Tech Lead Guidance:
   ```markdown
   ### Custom Reviewers (no limit, auto-detected + user-requested)
   - ✅ +1 behavior-regression (auto-detected: shared-state visibility changed)
   - ✅ +1 {reviewer-id} (added via --team={reviewer-id}:1)
   - ⬜ +1 {reviewer-id} (available, not applicable: no matching files)
   ```

   **Step I: Test Coverage Gap Scan**（当 graph 可用时执行，grep 无法精确完成此任务）

   对每个变更文件，调用 `query_graph_tool(pattern="tests_for", target=变更函数/类)` 识别缺少测试覆盖的高风险变更。
   这是 graph 的独特价值——grep 很难准确判断"哪些函数没有测试"，而 graph 的 tests_for 查询可以精确匹配测试函数与被测函数的调用关系。
   **注意**: `target` 使用图谱节点名（限定名，不带括号 `()`）。若返回空，先用 `semantic_search_nodes_tool` 确认节点名。

   ```markdown
   ### 测试覆盖缺口（知识图谱）
   - ✅ `AuthService.login` — 有 3 个测试 (AuthServiceTest.java)
   - ⚠️ `TokenRefreshService.refresh` — 无测试覆盖
   - ⚠️ `AuditLogService.recordLogin` — 无测试覆盖
   ```

   如果发现无覆盖的高风险变更，在 Tech Lead Guidance 中标注（作为导航提示，供已启用的 Testing reviewer 或其他 reviewer 参考）。⚠️ 不再自动添加 Testing reviewer——Testing reviewer 仅在用户显式要求时启用（--team=testing:1 或自然语言）。

   **Step J: Structural Risk Supplement**（当 graph 可用时执行，grep 无法完成此任务）

   这是 graph 的独有价值——发现 grep 无法感知的结构级弱点。**条件触发**：仅当 `detect_changes_tool` 显示有 risk_score >= 0.7 的变更时才调用，避免无谓增加工具调用次数。注意：`risk_score` 是 0-1 浮点数（非 0-10），0.7 即触发阈值。若 graph 工具调用已达软预算（≤8 次），优先 skip surprising_connections（成本最高），保留 hub/bridge/knowledge_gaps。

   a) 调用 `get_knowledge_gaps_tool` 识别结构级弱点：
      - 无测试的高扇入热点（high-degree nodes without test coverage）
      - 孤立节点（disconnected）、单文件社区
      - 将命中变更的弱点写入 Tech Lead Guidance，建议对应 reviewer 关注

   b) **架构热点与瓶颈检测**（修复 hub/bridge 检测，原仅文档承诺无工具支撑）:
      - 调用 `get_hub_nodes_tool(top_n=10)` 获取总度数最高的节点列表（⚠️ 无 detail_level，无法压缩，用 top_n 控制成本）
      - 调用 `get_bridge_nodes_tool(top_n=10)` 获取 betweenness centrality 最高的架构瓶颈节点
      - **交集过滤**（必须）：hub/bridge 返回的每个节点含 `qualified_name` 和 `file` 字段。将这两项与本次变更做交集——用 `git diff --name-only` 获取的变更文件列表（Phase 2 已获取）匹配节点的 `file`，或用 `detect_changes_tool` minimal 返回的 `review_priorities`（top-3 函数名）匹配节点的 `name`。任一匹配即视为命中。只保留命中的节点，未命中的丢弃（全图静态分析，与本次变更无关的 hub/bridge 是噪声）
      - 交集非空 → 在 Tech Lead Guidance 标注，并自动添加 Architect reviewer（如尚未在团队中）:
        "⚠️ {函数} 是 hub 节点（总度数 {total_degree}，扇入 {in_degree}），变更影响面大，Architect 重点关注"
        "⚠️ {函数} 是 bridge 节点（介数 {betweenness}），断裂将导致多代码区域失联"
      - 交集为空 → skip，记录到 Graph Usage Log（Status=skip, "无 hub/bridge 命中变更"）
      - **注意**: hub/bridge 是全图静态分析，不随本次变更变化。同一仓库多次审查会得到相同的 hub/bridge 列表，交集过滤是获得针对性的唯一手段
      - **注意**: `detect_changes_tool` 在 `detail_level="minimal"` 下**不返回 `changed_functions`**（只返回 `review_priorities` 纯函数名 top-3），故交集过滤用 `git diff --name-only` 文件列表匹配 hub/bridge 的 `file` 字段为主，`review_priorities` 函数名匹配为辅

   c) **意外耦合检测**（grep 做不到的结构级发现）:
      - 调用 `get_surprising_connections_tool(top_n=15)` 获取跨社区/跨语言/边缘直连 hub 的意外耦合边（⚠️ 无 detail_level，成本最高 ~1500 token，故在软预算紧张时优先 skip）
      - **交集过滤**（必须）：surprising_connections 返回的每条边含 `source`/`source_qualified`/`target`/`target_qualified` 字段（⚠️ 边没有独立的 `file` 字段，文件路径需从 `source_qualified`/`target_qualified` 中推断，qualified_name 通常含路径前缀）。用 `git diff --name-only` 变更文件列表匹配 `source_qualified`/`target_qualified` 中的路径，或用 `review_priorities` 函数名匹配 `source`/`target`。只保留命中本次变更的边，未命中的丢弃（全图静态分析，与变更无关的耦合是噪声）
      - 命中的边注入 Architect reviewer 导航提示:
        "⚠️ {source}（社区 {src_community}）→ {target}（社区 {tgt_community}）存在意外耦合
         原因: {reasons}，surprise_score: {score}
         → Architect 检查此跨社区调用是否故意，是否违反架构边界"
      - 模块化差的项目 cross-community 可能很多，交集后仍超 5 条时只取 surprise_score 最高的 3 条
      - 无命中 → skip，记录 Graph Usage Log

   d) 对 `detect_changes_tool` 识别的高风险函数，调用 `find_large_functions_tool(file_path_pattern=<变更路径>, min_lines=200)` 定位超长方法：
      - 作为导航交给该风险的负责 reviewer；结合调用频次和实际证据检查，函数长度本身不是缺陷，也不触发语言专项角色

   ```markdown
   ### 结构级风险（知识图谱）
   - ⚠️ `PaymentService.process` 是 hub 节点（总度数 12，扇入 8），本次变更影响面大，建议 Architect 重点关注
   - ⚠️ `AuthRouter.dispatch` 是 bridge 节点（介数 0.43），断裂将导致认证/授权区域失联
   - ⚠️ `OrderService.create`（社区 order）→ `InventoryService.lock`（社区 stock）存在意外耦合
     原因: cross-community，surprise_score: 0.50 → Architect 检查是否违反架构边界
   - ⚠️ `OrderHandler.parse` 超 250 行，由风险负责人结合实际性能证据检查
   ```

   **记录到 Graph Usage Log**：Step I 的 `query_graph_tool(tests_for)` 调用和 Step J 的 `get_knowledge_gaps_tool`/`get_hub_nodes_tool`/`get_bridge_nodes_tool`/`get_surprising_connections_tool`/`find_large_functions_tool` 调用（含 skip 情况），均向 context.md 的 Graph Usage Log 表追加一行（Phase=3）。skip 的调用也要记录，便于事后审计"为何未使用某工具"。

7. Update `context.md` with Tech Lead guidance section.

### Assign Review Work by Risk

For a verified empty comparison, record `empty_diff: true` in the snapshot and use empty assignments/ledger; no reviewer dispatch is necessary. Do not treat a failed diff as empty.

Before dispatch, write a reviewer assignment list (schema in `references/session-state.md`) and register it with the helper's `plan --kind reviewers` command. Keep the resolved team/count; this changes their work allocation, not the team-selection policy.

- Every instance gets a concrete risk, starting paths/functions, checks and explicit exclusions. Assign each changed area and important boundary to an owner; record uncovered areas as limitations.
- Give repeated personas different work. For example, `principal-1` checks behavior/requirements, `principal-2` checks cross-layer contracts, and `quality-1` checks documented rules with concrete correctness or operational consequences. Quality is not a search for naming preferences or optional refactors.
- Specialists own their risk slice across the necessary files. Shared boundaries may overlap deliberately; document why. Do not give every reviewer the whole PR as its mandatory starting task.
- Reviewers may follow callers, callees, configuration and tests needed to establish a finding. Expansion follows an evidence question; it is not another general scan of the repository.
- Initial reviews are independent: do not give reviewers another reviewer's findings or conclusions. Shared factual requirements and navigation are allowed. Persona instructions cannot override the assignment or the common evidence/filtering rules.
- In profiling mode, partition the hot methods/call chains from the inventory by risk. Wave 2 receives its assigned subset plus boundary context.

### Phase 3 Checkpoint

**STOP and verify before proceeding (self-check, do NOT ask the user):**
- [ ] `context.md` updated with Tech Lead guidance
- [ ] Reviewer team resolved (know which reviewers to spawn)
- [ ] If graph available: risk-based reviewer suggestions documented in Tech Lead Guidance
- [ ] If graph available: test coverage gaps identified and documented in Tech Lead Guidance (Testing reviewer is NOT auto-added — opt-in only)
- [ ] If graph available and high-risk changes present: structural risk supplement (knowledge gaps / large functions) documented
- [ ] If graph available: Graph Usage Log updated with Phase 3 tool calls (Step I/J, incl. skip)
- [ ] Helper `complete --phase 3` succeeded

---

## Phase 4: Spawn Reviewers

Use the host's real delegation facility, one independent context per registered reviewer assignment. Dispatch concurrently within host capacity. Preserve explicitly configured instances, but do not duplicate their assignments merely to obtain more votes.

1. Run helper `status` and `paths`; only dispatch assignments whose canonical report is missing or invalid. Read the existing artifact before replacing it. Each report needs a `## Summary` section; an empty file is not a report.
2. Resolve each persona under `references/reviewers/holistic/`, `specialist/`, `persona/`, or the custom reviewer roots from `references/configuration.md`. Load relevant custom references using the directory convention already recorded in `context.md`.
3. Give the reviewer its assignment, factual project requirements/standards, navigation hints, code snapshot and absolute output path returned by the helper. Inline diff delivery contains the assigned changes; with a persisted patch, tell it which file sections to read first. The complete patch remains available for necessary boundary checks. Do not require reading every unrelated hunk.
4. Tell it to investigate trigger, consequence and the code/contract evidence within its risk slice. Preserve uncertainty. Do not fill a quota. No findings is a valid result. Pure style, optional cleanup and claims based only on function length or names do not qualify; explicit repository rule violations qualify when the report establishes a practical consequence.
5. Instruct it to write in Chinese, keeping code/paths/identifiers unchanged. Start with `## Summary` and counts of candidate defects and unresolved questions. Each candidate includes source ID, precise location, trigger, consequence, evidence and severity proposal. A proposed blocker is still a candidate until independent verification.
6. Run `complete --phase 4` once reports are present. The helper verifies the assigned filenames and summary sections. If a report is missing, recover that instance; do not synthesize a fake independent review.

**Profiling two-wave dependency**: First run `profiling-analysis` to produce `hotspot-inventory.md` using the extraction rules in its persona. Then dispatch remaining assignments over the relevant hot methods and boundaries. Do not read entire profiling HTML files. If the inventory cannot be produced, record diagnostic degradation and its scope limitation before using diff-based assignments; do not claim measured evidence that was never read.

Persona suggestions to ask other reviewers are retained as questions for synthesis, not as discussion tasks. No all-reviewer discussion is dispatched.

## Phase 5: Aggregate Findings

Read reviewer summaries first, then the source evidence for candidate issues. Normalize all candidates into the round's `findings.json` ledger (schema in `references/session-state.md`). Raw reports remain unchanged as the audit record.

- Give each logical issue a stable ID (`F1`, `F2`, ...); merge duplicates while retaining all source reviewers and source locations. Agreement is not proof.
- Classify meaningful defects as `bug`, `security`, `data-loss`, `regression`, `performance` or `contract`. Keep pure style/cleanup as excluded ledger entries with a reason. A maintainability concern needs a concrete failure or documented operational consequence to qualify.
- Preserve every candidate in the ledger; the final findings list is filtered. Record why an item is excluded or judged false, so filtering remains auditable.
- `CONFIRMED` means the coordinator has checked the trigger, impact and code/contract evidence. Use `UNVERIFIED` if reachability, intent, consequences or a necessary contract remains unknown. Never promote an unreturned verifier to confirmation.
- A proposed blocker always enters independent batch verification before it can block. Known pre-existing issues are labeled and excluded from the PR verdict unless this change introduces or exposes their failure path.

Write `findings.json`, then run `complete --phase 5`. If interrupted, reuse existing reports and stable finding IDs.

## Phase 5.5: Focused Batch Verification

Select proposed blockers and other meaningful candidates that need additional context or have a material false-positive risk. Already proven non-blocking findings do not require a second broad scan. Profiling evidence can establish measured cost; causal claims, safety and severity still need evidence, so profiling is not a blanket verification exemption.

1. Group selected findings by shared call chain, state owner or resource lifecycle. Each finding belongs to exactly one batch. Do not combine unrelated issues simply because they came from the same reviewer. Save the batch assignment list and register it through `plan --kind batches`.
2. If `verification.max_findings` is explicitly configured, prioritize blockers, then severity and uncertainty; overflow stays `UNVERIFIED`. No configured cap means no new cap. With `--quick` or `verification.enabled: false`, skip dispatch and leave unresolved/blocking candidates unverified. Preserve the existing quick-mode choice; it cannot turn uncertainty into a clean verdict.
3. Dispatch one independent verifier per batch, concurrently within host capacity. Give it the related findings, IDs, entry paths and factual requirements. It may share code/context reads within that batch. Do not give it other batches, a preferred conclusion or the whole PR as a new review assignment.
4. Require a separate result for every assigned ID: `CONFIRMED`, `REFINED`, `FALSE_ALARM` or `UNVERIFIED`. Evidence is mandatory for the first three; `REFINED` also supplies the corrected description, and `UNVERIFIED` supplies the missing fact/reason. Read the relevant callers/callees and existing protections before deciding. Write the JSON to the canonical batch path from `paths`.
5. For a missing/invalid batch, recover it once. If it still has no usable result, the coordinator writes explicit `UNVERIFIED` records for its assigned IDs with the failure reason. Preserve malformed/partial output separately before replacement. Do not re-run completed unrelated batches.
6. Write `verification-summary.md` with per-ID results, evidence and excluded/unverified counts. When no batch is dispatched, register an empty list and write the reason (`--quick`, configuration disabled, or no candidates requiring verification). Run `complete --phase 5.5`; the helper rejects missing/duplicate IDs, unsupported verdicts and evidence-free confirmations.

No debate or all-reviewer discussion follows verification. Proceed to synthesis.

## Phase 7: Synthesis

Read the ledger and each batch's per-ID results. Use `references/output-template.md` for the final-report rules and `references/session-state.md` for `decision.json`.

1. Apply batch results by finding ID, retaining rejected/uncertain items in their original reports, ledger and verification summary. `REFINED` replaces the original description; apply any evidence-backed verifier severity correction before computing the verdict. Planned verification that fails stays unverified.
2. Publish confirmed meaningful findings with exact location, trigger, impact, evidence and a minimal repair. Exclude pure style, optional cleanup, duplicates, change summaries and low-impact items from the main list. Preserve the excluded count and artifact links.
3. A blocker requires independent `CONFIRMED` or `REFINED` evidence; one verified blocker is enough for `REQUEST_CHANGES`. A minority finding is not removed by a vote, and multiple agreeing reviewers cannot replace evidence.
4. Other confirmed findings yield `FINDINGS`. If no blocker is confirmed and meaningful questions remain unresolved, use `INCOMPLETE`. With full coverage and no meaningful findings or uncertainty, use `NO_FINDINGS`; this is an automated review result, not a human approval.
5. Put unresolved meaningful candidates in a separate "待验证" section with the missing evidence. Do not list them as confirmed problems or block solely on speculation. State missing review coverage, failed verifier work and inferred requirements.
6. Write `final.md` and `decision.json` to the helper's paths, then run `complete --phase 7`. The helper checks the published IDs and verdict against the evidence ledger and batch results. It validates structure/consistency; the coordinator remains responsible for factual correctness and matching the prose to `decision.json`.
7. In profiling mode, organize findings around assigned hot methods and link the measured evidence in `hotspot-inventory.md`; do not discount or infer causality from measurements alone.

If interrupted, use available raw reports, ledger and batch results. Always produce an explicitly incomplete report when necessary; never claim a clean result from missing work. Do not reopen a valid completed review for the same snapshot.

## Phase 8: Present

Run `status`, read `final.md`, and present the confirmed-finding count, verdict, unresolved count and report path. When there are no confirmed issues, say so plainly. Link raw/excluded/verification artifacts instead of dumping every reviewer comment into the response.

Delete `diff.patch` if disk-offload was used, preserving the ledger and reports. Run `complete --phase 8`. Missing/invalid final artifacts must be recovered before presentation is marked done.

## Quick Reference

| Phase | Action | Artifact/checkpoint |
|---|---|---|
| 0 | Match snapshot, initialize/resume state | `state.json`, generated `PROGRESS.md` |
| 1 | Discover standards, scope and target merge-base | `discovered-standards.md` |
| 2 | Gather diff and impact context | `context.md`, optional `diff.patch` |
| 3 | Resolve team and partition risks | Registered reviewer assignments, `context.md` |
| 4 | Independent assigned reviews | Canonical reviewer reports |
| 5 | Normalize and screen candidates | `findings.json` |
| 5.5 | Independently verify related batches | Batch JSON results, `verification-summary.md` |
| 7 | Filter confirmed findings and synthesize | `final.md`, `decision.json` |
| 8 | Present results, clean persisted diff | Valid final artifacts |
