# Ultra CR Workflow

Complete 8-phase process for multi-agent code review with architectural impact analysis.

## Phase 0: Session Verification

Before starting ANY work, resolve SKILL_ROOT as specified by SKILL.md and verify the current session state.

Resolve output_dir from explicit arguments, config or user instructions before choosing SESSION_DIR; examples below show only the default. Record the resolved scope, HEAD/base refs, staged/unstaged/untracked content fingerprint, requirements fingerprint and review-options fingerprint in PROGRESS.md. Exclude generated session artifacts under `{OUTPUT_ROOT}/ultra-cr/result/` from the code fingerprint, so writing the review does not invalidate itself. Include configured reviewer definitions and review configuration as inputs. Reuse a session only when these inputs match. For changed inputs, choose a new unique session suffix and preserve the old directory. A valid explicit resume path takes precedence over the default date/branch location. Never treat a changed code snapshot as an already completed review.

### Step 1: Check for existing session

**Bash (Linux / macOS / Git Bash):**
```bash
BRANCH_RAW=$(git branch --show-current)
BRANCH=$(echo "$BRANCH_RAW" | tr '/' '-')
DATE=$(date +%Y-%m-%d)
OUTPUT_ROOT="${OUTPUT_ROOT:-.reviews}"
SESSION_DIR="${SESSION_DIR:-${OUTPUT_ROOT}/ultra-cr/result/${DATE}-${BRANCH}}"
ls -la "$SESSION_DIR" 2>/dev/null
```
**PowerShell (Windows):**
```powershell
$BranchRaw = git branch --show-current
$Branch = $BranchRaw -replace '/','-'
$Date = Get-Date -Format 'yyyy-MM-dd'
if (-not $OUTPUT_ROOT) { $OUTPUT_ROOT = ".reviews" }
if (-not $SESSION_DIR) { $SESSION_DIR = "$OUTPUT_ROOT/ultra-cr/result/${Date}-${Branch}" }
if (Test-Path $SESSION_DIR) { Get-ChildItem -Path $SESSION_DIR -Force | Format-Table }
```

### Step 2: Read or create PROGRESS.md

**PROGRESS.md is the authoritative source of truth for resume decisions.** Always check it FIRST.

**Bash (Linux / macOS / Git Bash):**
```bash
cat "$SESSION_DIR/PROGRESS.md" 2>/dev/null
```
**PowerShell (Windows):**
```powershell
if (Test-Path "$SESSION_DIR/PROGRESS.md") { Get-Content "$SESSION_DIR/PROGRESS.md" -Raw }
```

**COMPLETED REVIEW SHORT-CIRCUIT (IRON LAW):** If the saved scope, code snapshot, requirements and review options match the current inputs AND PROGRESS.md exists AND all phases (0–8, including the optional 5.5) are marked `DONE` AND `rounds/round-{current_round}/final.md` exists on disk, the review is complete. Read `final.md` and present results immediately. Do NOT re-execute any phase, do NOT re-spawn any reviewer, do NOT overwrite any existing output file. This applies even when a new conversation turn starts.

If PROGRESS.md says all DONE but `final.md` is missing on disk → treat as corrupted session: downgrade Phase 7 to `NOT_STARTED` in PROGRESS.md and proceed to Step 4 (Resume from Phase 7).

If the saved inputs match AND PROGRESS.md exists and all phases are DONE AND final.md exists → **STOP HERE, present final.md, no further work needed.**

If PROGRESS.md exists and contains valid phase tracking (some phases not DONE) → proceed to Step 4 (Resume).

If PROGRESS.md does not exist → proceed to Step 3 (Fresh Start).

If PROGRESS.md exists but appears corrupted or incomplete → reconstruct from disk (Step 3a).

### Step 3: Fresh Start

Create a fresh, unused session directory. If the proposed directory already contains artifacts, reconstruct progress or choose a new unique session suffix; never delete prior review evidence:
```bash
# Bash (Linux/macOS)
mkdir -p "$SESSION_DIR/rounds/round-1/reviews"
```
```powershell
# PowerShell (Windows) — SESSION_DIR must be fresh; preserve existing evidence.
New-Item -ItemType Directory -Path "$SESSION_DIR/rounds/round-1/reviews" -Force | Out-Null
```

Create initial PROGRESS.md:
**Bash (Linux / macOS / Git Bash):**
```bash
cat > "$SESSION_DIR/PROGRESS.md" << 'EOF'
# 审查进度

## 会话: {SESSION_ID}
## 分支: {branch}
## 范围: {staged|current-branch|all-branches|branch:REF|commit:SHA|range:SHA1..SHA2}
## 输出根目录: {OUTPUT_ROOT}
## 代码快照: {code-fingerprint-excluding-review-artifacts}
## 需求快照: {requirements-fingerprint}
## 审查配置快照: {options-and-reviewer-definitions-fingerprint}
## Diff 策略: 待定
## 当前轮次: 1

| 阶段 | 状态 | 完成时间 | 输出文件 | 备注 |
|------|------|---------|---------|------|
| 0 - 会话验证 | DONE | {timestamp} | - | 全新开始 |
| 1 - 上下文发现 | NOT_STARTED | - | - | - |
| 2 - 收集变更上下文 | NOT_STARTED | - | - | - |
| 3 - Tech Lead 分析 | NOT_STARTED | - | - | - |
| 4 - 启动评审员 | NOT_STARTED | - | - | - |
| 5 - 汇总发现 | NOT_STARTED | - | - | - |
| 5.5 - 聚焦验证 | NOT_STARTED | - | - | - |
| 6 - 讨论 | NOT_STARTED | - | - | - |
| 7 - 综合 | NOT_STARTED | - | - | - |
| 8 - 呈现 | NOT_STARTED | - | - | - |
EOF
```
**PowerShell (Windows):**
```powershell
$content = @'
# 审查进度

## 会话: {SESSION_ID}
## 分支: {branch}
## 范围: {staged|current-branch|all-branches|branch:REF|commit:SHA|range:SHA1..SHA2}
## 输出根目录: {OUTPUT_ROOT}
## 代码快照: {code-fingerprint-excluding-review-artifacts}
## 需求快照: {requirements-fingerprint}
## 审查配置快照: {options-and-reviewer-definitions-fingerprint}
## Diff 策略: 待定
## 当前轮次: 1

| 阶段 | 状态 | 完成时间 | 输出文件 | 备注 |
|------|------|---------|---------|------|
| 0 - 会话验证 | DONE | {timestamp} | - | 全新开始 |
| 1 - 上下文发现 | NOT_STARTED | - | - | - |
| 2 - 收集变更上下文 | NOT_STARTED | - | - | - |
| 3 - Tech Lead 分析 | NOT_STARTED | - | - | - |
| 4 - 启动评审员 | NOT_STARTED | - | - | - |
| 5 - 汇总发现 | NOT_STARTED | - | - | - |
| 5.5 - 聚焦验证 | NOT_STARTED | - | - | - |
| 6 - 讨论 | NOT_STARTED | - | - | - |
| 7 - 综合 | NOT_STARTED | - | - | - |
| 8 - 呈现 | NOT_STARTED | - | - | - |
'@
Set-Content -Path "$SESSION_DIR/PROGRESS.md" -Value $content -Encoding UTF8
```

### Step 3a: Reconstruct PROGRESS.md from disk

If PROGRESS.md is missing or corrupted, reconstruct it by inspecting disk files:

**Bash (Linux / macOS / Git Bash):**
```bash
# Check which files exist
test -f "$SESSION_DIR/discovered-standards.md" && echo "PHASE1:DONE" || echo "PHASE1:NOT_STARTED"
test -f "$SESSION_DIR/context.md" && echo "PHASE2:DONE" || echo "PHASE2:NOT_STARTED"
# Check if context.md has Tech Lead guidance
grep -q "Tech Lead Guidance" "$SESSION_DIR/context.md" 2>/dev/null && echo "PHASE3:DONE" || echo "PHASE3:NOT_STARTED"
# Check reviewer files
ls "$SESSION_DIR/rounds/round-*/reviews/" 2>/dev/null
# Check Phase 5.5 verification output (exists whenever Phase 5.5 ran OR was legitimately skipped — a skip writes a skip-marker summary)
test -f "$SESSION_DIR/rounds/round-1/verifications/verification-summary.md" && echo "PHASE5.5:DONE" || echo "PHASE5.5:NOT_STARTED"
test -f "$SESSION_DIR/rounds/round-1/discourse.md" && echo "PHASE6:DONE" || echo "PHASE6:NOT_STARTED"
test -f "$SESSION_DIR/rounds/round-1/final.md" && echo "PHASE7:DONE" || echo "PHASE7:NOT_STARTED"
```
**PowerShell (Windows):**
```powershell
# Check which files exist
if (Test-Path "$SESSION_DIR/discovered-standards.md") { Write-Output "PHASE1:DONE" } else { Write-Output "PHASE1:NOT_STARTED" }
if (Test-Path "$SESSION_DIR/context.md") { Write-Output "PHASE2:DONE" } else { Write-Output "PHASE2:NOT_STARTED" }
# Check if context.md has Tech Lead guidance
if ((Test-Path "$SESSION_DIR/context.md") -and (Select-String -Path "$SESSION_DIR/context.md" -Pattern 'Tech Lead Guidance' -Quiet)) { Write-Output "PHASE3:DONE" } else { Write-Output "PHASE3:NOT_STARTED" }
# Check reviewer files
Get-ChildItem -Path "$SESSION_DIR/rounds/round-*/reviews/" -File -ErrorAction SilentlyContinue
# Check Phase 5.5 verification output (exists whenever Phase 5.5 ran OR was legitimately skipped — a skip writes a skip-marker summary)
if (Test-Path "$SESSION_DIR/rounds/round-1/verifications/verification-summary.md") { Write-Output "PHASE5.5:DONE" } else { Write-Output "PHASE5.5:NOT_STARTED" }
if (Test-Path "$SESSION_DIR/rounds/round-1/discourse.md") { Write-Output "PHASE6:DONE" } else { Write-Output "PHASE6:NOT_STARTED" }
if (Test-Path "$SESSION_DIR/rounds/round-1/final.md") { Write-Output "PHASE7:DONE" } else { Write-Output "PHASE7:NOT_STARTED" }
```

Then create PROGRESS.md with the reconstructed state.

### Step 4: Resume from existing session

**This step is CRITICAL for interrupted reviews.** Follow it exactly:

1. **Read PROGRESS.md** to determine the resume point
2. **Verify PROGRESS.md against actual disk files** (cross-check):
   - If PROGRESS.md says phase is `DONE` but output file is missing → downgrade to `NOT_STARTED`
   - If PROGRESS.md says phase is `IN_PROGRESS` → re-execute that phase
   - If PROGRESS.md and disk agree → proceed to the first `NOT_STARTED` phase
   - **Allowed skip markers**: Phase 5.5 accepts `verification-summary.md` with a `SKIPPED:` reason; Phase 6 accepts `discourse.md` with `SKIPPED: --quick` or `SKIPPED: discourse.enabled=false`. These are valid DONE凭证 when the recorded options match the current review. Do not downgrade them or require reviewer responses for a skipped discourse. Missing marker files mean NOT_STARTED.
3. **Reconstruct context** by reading these files before resuming:
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   cat "$SESSION_DIR/discovered-standards.md" 2>/dev/null
   cat "$SESSION_DIR/context.md" 2>/dev/null
   cat "$SESSION_DIR/requirements.md" 2>/dev/null
   ```
   **PowerShell (Windows):**
   ```powershell
   if (Test-Path "$SESSION_DIR/discovered-standards.md") { Get-Content "$SESSION_DIR/discovered-standards.md" -Raw }
   if (Test-Path "$SESSION_DIR/context.md") { Get-Content "$SESSION_DIR/context.md" -Raw }
   if (Test-Path "$SESSION_DIR/requirements.md") { Get-Content "$SESSION_DIR/requirements.md" -Raw }
   ```
4. **For Phase 4 resume**: Check which reviewer files already exist:
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   ls -1 "$SESSION_DIR/rounds/round-$CURRENT_ROUND/reviews/" 2>/dev/null
   ```
   **PowerShell (Windows):**
   ```powershell
   Get-ChildItem -Path "$SESSION_DIR/rounds/round-$CURRENT_ROUND/reviews/" -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
   ```
   Only re-spawn reviewers whose output files are missing.

   > **Profiling-diagnostic mode resume (two-wave dependency)**: If diagnostic mode is active (profiling-analysis in team), resume MUST respect the two-wave dependency:
   > - **Check `$SESSION_DIR/hotspot-inventory.md` first.** If it does NOT exist, the profiling-analysis reviewer (Wave 1) did not complete — re-spawn it FIRST and wait for `hotspot-inventory.md` before spawning any Wave 2 reviewer. Do NOT spawn Wave 2 reviewers without the hotspot inventory (they would have no scope to inject).
   > - **If `hotspot-inventory.md` exists** but some Wave 2 reviewer files are missing — re-spawn the missing Wave 2 reviewers, AND re-inject the `hotspot-inventory.md` hot method list as their scope (same as the original spawn). The scope injection is stateless — it must be provided on every spawn, including resume.
   > - **Degradation already noted**: If `discovered-standards.md` records "profiling-diagnostic mode degraded to normal mode" (from a prior incomplete run), skip the two-wave logic and treat all missing reviewers as normal-mode (diff as scope axis).

### Step 4a: Round Resolution

**Bash (Linux / macOS / Git Bash):**
```bash
ROUNDS_DIR="$SESSION_DIR/rounds"
if [ ! -d "$ROUNDS_DIR" ]; then
  CURRENT_ROUND=1
  mkdir -p "$ROUNDS_DIR/round-1/reviews"
else
  HIGHEST=$(ls -1 "$ROUNDS_DIR" | grep -E '^round-[0-9]+$' | sed 's/round-//' | sort -n | tail -1)
  HIGHEST=${HIGHEST:-0}
  if [ -f "$ROUNDS_DIR/round-$HIGHEST/final.md" ]; then
    CURRENT_ROUND=$((HIGHEST + 1))
    mkdir -p "$ROUNDS_DIR/round-$CURRENT_ROUND/reviews"
  else
    CURRENT_ROUND=$HIGHEST
  fi
fi
```
**PowerShell (Windows):**
```powershell
$RoundsDir = "$SESSION_DIR/rounds"
if (-not (Test-Path $RoundsDir)) {
  $CURRENT_ROUND = 1
  New-Item -ItemType Directory -Path "$RoundsDir/round-1/reviews" -Force | Out-Null
} else {
  $Highest = Get-ChildItem -Path $RoundsDir -Directory |
    Where-Object { $_.Name -cmatch '^round-[0-9]+$' } |
    ForEach-Object { [int]($_.Name -replace 'round-','') } |
    Sort-Object -Descending | Select-Object -First 1
  if ($null -eq $Highest) { $Highest = 0 }
  if (Test-Path "$RoundsDir/round-$Highest/final.md") {
    $CURRENT_ROUND = $Highest + 1
    New-Item -ItemType Directory -Path "$RoundsDir/round-$CURRENT_ROUND/reviews" -Force | Out-Null
  } else {
    $CURRENT_ROUND = $Highest
  }
}
```

### Step 4b: Normalize Misnamed Output Files (cross-platform, MANDATORY on resume)

**On every resume, scan ALL existing round directories for misnamed conclusion files and rename them to their canonical names.** This corrects the most common interruption/retry failure — the model (or a reviewer subagent) writing a conclusion file under the wrong filename — so that round resolution, Phase 4/6/7/8 checks, and Phase 5 aggregation all see the correct filenames.

Four categories of files are normalized:

| Canonical name | Accepts misnamed candidates | Written by |
|----------------|------------------------------|------------|
| `final.md` | `summary.md`, `synthesis.md`, `SYNTHESIS.md`, `conclusion.md`, `result.md`, `review.md` | Tech Lead (Phase 7) |
| `discourse.md` | `discussion.md`, `discourse-log.md`, `discourse_log.md`, `debate.md`, `cross-review.md` | Tech Lead (Phase 6) |
| `reviews/{type}-{n}.md` | reviewer files with wrong separators or prefixes: `principal_1.md`, `principal.md`, `review-principal-1.md`, `principal-1-review.md` → `{type}-{n}.md` | Reviewer subagents (Phase 4) |
| `verifications/{type}-{n}-verify.md` | verification files with wrong separators: `principal_1-verify.md`, `verify-principal-1.md` → `{type}-{n}-verify.md`; `verification.md`/`verify-summary.md`/`verify.md` → `verification-summary.md` | Verification subagents (Phase 5.5) |

Run for your platform:

**Bash (Linux / macOS / Git Bash):**
```bash
ROUNDS_DIR="$SESSION_DIR/rounds"
for ROUND_DIR in "$ROUNDS_DIR"/round-*/; do
  [ -d "$ROUND_DIR" ] || continue

  # --- final.md ---
  if [ ! -f "$ROUND_DIR/final.md" ]; then
    MISNAMED=$(ls -1 "$ROUND_DIR" 2>/dev/null | grep -iE '^(summary|synthesis|conclusion|result|review)\.md$' || true)
    if [ -n "$MISNAMED" ]; then
      echo "Resume normalization: $ROUND_DIR$MISNAMED -> final.md"
      mv "$ROUND_DIR$MISNAMED" "$ROUND_DIR/final.md"
    fi
  fi

  # --- discourse.md ---
  if [ ! -f "$ROUND_DIR/discourse.md" ]; then
    MISNAMED=$(ls -1 "$ROUND_DIR" 2>/dev/null | grep -iE '^(discussion|discourse[-_]log|debate|cross-review)\.md$' || true)
    if [ -n "$MISNAMED" ]; then
      echo "Resume normalization: $ROUND_DIR$MISNAMED -> discourse.md"
      mv "$ROUND_DIR$MISNAMED" "$ROUND_DIR/discourse.md"
    fi
  fi

  # --- reviewer output files: reviews/{type}-{n}.md ---
  REVIEWS_DIR="$ROUND_DIR/reviews"
  if [ -d "$REVIEWS_DIR" ]; then
    for FILE in "$REVIEWS_DIR"/*.md; do
      [ -f "$FILE" ] || continue
      BASE=$(basename "$FILE")
      # Strip .md, normalize (lowercase + strip review- prefix/-review suffix + _ -> -), then re-check
      STEM="${BASE%.md}"
      NEW_STEM=$(echo "$STEM" | tr 'A-Z' 'a-z' | sed -E 's/^review-//; s/-review$//; s/_/-/g')
      NEW="${NEW_STEM}.md"
      # Skip only if nothing changed AND it is already canonical
      if [ "$NEW" = "$BASE" ] && echo "$BASE" | grep -qE '^[a-z][a-z0-9-]*-[0-9]+\.md$'; then
        continue
      fi
      if echo "$NEW" | grep -qE '^[a-z][a-z0-9-]*-[0-9]+\.md$'; then
        echo "Resume normalization: $REVIEWS_DIR/$BASE -> $NEW"
        mv "$FILE" "$REVIEWS_DIR/$NEW"
      else
        echo "WARNING: unrecognizable reviewer filename '$BASE' — cannot auto-rename; re-spawn this reviewer"
      fi
    done
  fi

  # --- verification output files: verifications/{type}-{n}-verify(-k)?.md + verification-summary.md ---
  VERIFICATIONS_DIR="$ROUND_DIR/verifications"
  if [ -d "$VERIFICATIONS_DIR" ]; then
    # summary file normalization first
    if [ ! -f "$VERIFICATIONS_DIR/verification-summary.md" ]; then
      MISNAMED=$(ls -1 "$VERIFICATIONS_DIR" 2>/dev/null | grep -iE '^(verification\.md|verify-summary\.md|verify\.md)$' || true)
      if [ -n "$MISNAMED" ]; then
        echo "Resume normalization: $VERIFICATIONS_DIR/$MISNAMED -> verification-summary.md"
        mv "$VERIFICATIONS_DIR/$MISNAMED" "$VERIFICATIONS_DIR/verification-summary.md"
      fi
    fi
    # per-finding verification files
    for FILE in "$VERIFICATIONS_DIR"/*.md; do
      [ -f "$FILE" ] || continue
      BASE=$(basename "$FILE")
      [ "$BASE" = "verification-summary.md" ] && continue
      # Already canonical? {type}-{n}-verify.md or {type}-{n}-verify-{k}.md
      if echo "$BASE" | grep -qE '^[a-z][a-z0-9-]*-[0-9]+-verify(-[0-9]+)?\.md$'; then
        continue
      fi
      # Normalize: lowercase, _ -> -, strip a leading "verify-" prefix, ensure -verify suffix present.
      STEM="${BASE%.md}"
      STEM=$(echo "$STEM" | tr 'A-Z' 'a-z' | sed -E 's/_/-/g; s/^verify-//')
      if ! echo "$STEM" | grep -qE -- '-verify(-[0-9]+)?$'; then
        STEM="${STEM}-verify"
      fi
      NEW="${STEM}.md"
      if [ "$NEW" = "$BASE" ]; then
        continue
      fi
      if echo "$NEW" | grep -qE '^[a-z][a-z0-9-]*-[0-9]+-verify(-[0-9]+)?\.md$'; then
        echo "Resume normalization: $VERIFICATIONS_DIR/$BASE -> $NEW"
        mv "$FILE" "$VERIFICATIONS_DIR/$NEW"
      else
        echo "WARNING: unrecognizable verification filename '$BASE' — cannot auto-rename; re-run verification"
      fi
    done
  fi
done
```

**PowerShell (Windows):**
```powershell
$RoundsDir = "$SESSION_DIR\rounds"
if (Test-Path $RoundsDir) {
  Get-ChildItem -Path $RoundsDir -Directory -Filter "round-*" | ForEach-Object {
    $RoundDir = $_.FullName

    # --- final.md ---
    $FinalPath = Join-Path $RoundDir "final.md"
    if (-not (Test-Path $FinalPath)) {
      $Misnamed = Get-ChildItem -Path $RoundDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(?i)(summary|synthesis|conclusion|result|review)\.md$' } |
        Select-Object -First 1
      if ($Misnamed) {
        Write-Output "Resume normalization: $($Misnamed.FullName) -> final.md"
        Rename-Item -Path $Misnamed.FullName -NewName "final.md" -Force
      }
    }

    # --- discourse.md ---
    $DiscoursePath = Join-Path $RoundDir "discourse.md"
    if (-not (Test-Path $DiscoursePath)) {
      $Misnamed = Get-ChildItem -Path $RoundDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(?i)(discussion|discourse[-_]log|debate|cross-review)\.md$' } |
        Select-Object -First 1
      if ($Misnamed) {
        Write-Output "Resume normalization: $($Misnamed.FullName) -> discourse.md"
        Rename-Item -Path $Misnamed.FullName -NewName "discourse.md" -Force
      }
    }

    # --- reviewer output files: reviews/{type}-{n}.md ---
    $ReviewsDir = Join-Path $RoundDir "reviews"
    if (Test-Path $ReviewsDir) {
      Get-ChildItem -Path $ReviewsDir -File -Filter "*.md" -ErrorAction SilentlyContinue | ForEach-Object {
        $Base = $_.Name
        # Strip .md, normalize (lowercase + strip review- prefix/-review suffix + _ -> -), then re-check
        $Stem = [System.IO.Path]::GetFileNameWithoutExtension($Base)
        $NewStem = $Stem.ToLower() -replace '^review-', '' -replace '-review$', '' -replace '_', '-'
        $New = "$NewStem.md"
        # Skip only if nothing changed AND it is already canonical (case-SENSITIVE: type must be lowercase)
        if ($New -ceq $Base -and $Base -cmatch '^[a-z][a-z0-9-]*-[0-9]+\.md$') { return }
        if ($New -cmatch '^[a-z][a-z0-9-]*-[0-9]+\.md$') {
          Write-Output "Resume normalization: $($_.FullName) -> $New"
          Rename-Item -Path $_.FullName -NewName $New -Force
        } else {
          Write-Output "WARNING: unrecognizable reviewer filename '$Base' — cannot auto-rename; re-spawn this reviewer"
        }
      }
    }

    # --- verification output files: verifications/{type}-{n}-verify(-k)?.md + verification-summary.md ---
    $VerificationsDir = Join-Path $RoundDir "verifications"
    if (Test-Path $VerificationsDir) {
      # summary file normalization first
      $SummaryPath = Join-Path $VerificationsDir "verification-summary.md"
      if (-not (Test-Path $SummaryPath)) {
        $MisnamedSummary = Get-ChildItem -Path $VerificationsDir -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '^(?i)(verification\.md|verify-summary\.md|verify\.md)$' } |
          Select-Object -First 1
        if ($MisnamedSummary) {
          Write-Output "Resume normalization: $($MisnamedSummary.FullName) -> verification-summary.md"
          Rename-Item -Path $MisnamedSummary.FullName -NewName "verification-summary.md" -Force
        }
      }
      # per-finding verification files
      Get-ChildItem -Path $VerificationsDir -File -Filter "*.md" -ErrorAction SilentlyContinue | ForEach-Object {
        $Base = $_.Name
        if ($Base -ceq "verification-summary.md") { return }
        # Already canonical? (case-SENSITIVE: type must be lowercase)
        if ($Base -cmatch '^[a-z][a-z0-9-]*-[0-9]+-verify(-[0-9]+)?\.md$') { return }
        # Normalize: lowercase, _ -> -, strip a leading "verify-" prefix, ensure -verify suffix present.
        $Stem = [System.IO.Path]::GetFileNameWithoutExtension($Base)
        $Stem = $Stem.ToLower() -replace '_', '-' -replace '^verify-', ''
        if ($Stem -notmatch '-verify(-[0-9]+)?$') {
          $Stem = "$Stem-verify"
        }
        $New = "$Stem.md"
        if ($New -ceq $Base) { return }
        if ($New -cmatch '^[a-z][a-z0-9-]*-[0-9]+-verify(-[0-9]+)?\.md$') {
          Write-Output "Resume normalization: $($_.FullName) -> $New"
          Rename-Item -Path $_.FullName -NewName $New -Force
        } else {
          Write-Output "WARNING: unrecognizable verification filename '$Base' — cannot auto-rename; re-run verification"
        }
      }
    }
  }
}
```

**Reviewer file recovery rules (what gets renamed):**
- `principal_1.md` → `principal-1.md` (underscore → hyphen)
- `review-principal-1.md` → `principal-1.md` (strip `review-` prefix)
- `principal-1-review.md` → `principal-1.md` (strip `-review` suffix)
- `Principal-1.md` → `principal-1.md` (uppercase → lowercase; reviewer IDs are always lowercase)
- `Review-Principal_1.md` → `principal-1.md` (all of the above combined)
- A file already matching `{type}-{n}.md` (e.g. `principal-1.md`, `java-code-smell-1.md`) is left untouched.
- A file that cannot be confidently mapped to `{type}-{n}.md` (e.g. `principal.md` with no instance number, `random-notes.md`) is left in place and reported — do NOT guess; re-spawn that reviewer instead.

> After normalization, re-run Step 4a round resolution if any `final.md` was renamed, because a previously-"incomplete" round may now correctly resolve as complete.

### Step 5: Report to user

```
Session: {session_id}
Current phase: {current_phase} (Phase {phase_number}/8)
Action: [Starting fresh | Resuming from Phase X — {reason for interruption}]
```

### Step 6: Update PROGRESS.md after EVERY phase

After completing each subsequent phase's checkpoint, you MUST update PROGRESS.md:

**Bash (Linux / macOS / Git Bash):**
```bash
# Example: After completing Phase 1
# Update the relevant row in PROGRESS.md
sed -i 's/| 1 - Context Discovery | NOT_STARTED/| 1 - Context Discovery | DONE/' "$SESSION_DIR/PROGRESS.md"
# Or rewrite the entire file if sed is unreliable
```
**PowerShell (Windows):**
```powershell
# Example: After completing Phase 1
# Update the relevant row in PROGRESS.md
$path = "$SESSION_DIR/PROGRESS.md"
(Get-Content $path -Raw) -replace '\| 1 - Context Discovery \| NOT_STARTED','| 1 - Context Discovery | DONE' | Set-Content $path -NoNewline
# Or rewrite the entire file if the replace is unreliable
```

**CRITICAL**: PROGRESS.md must be written to disk BEFORE proceeding to the next phase. This ensures that an interruption at any point can be recovered.

---

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
- `scope:` — Review scope (staged | current-branch | all-branches | branch:REF | commit:SHA | range:SHA1..SHA2)
- `team:` — Reviewer team composition
- `rules:` — Per-severity review rules
- `discourse:` — Whether to run discourse phase
- `verification:` — Whether to run Phase 5.5 Focused Verification (`enabled: true|false`, optional `risk_types:` list)

**1b. Parse $ARGUMENTS**

If user provided arguments, parse:
- `--team=type:count,...` — Override team composition
- `--quick` — Skip discourse phase AND Phase 5.5 Focused Verification (both write skip-marker outputs where applicable and proceed)
- `--scope=staged|current-branch|all-branches|branch:REF|commit:SHA|range:SHA1..SHA2` — Override review scope
  - `--scope=branch:feature-auth` — Review all commits on the `feature-auth` branch
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
   - User says "review the whole branch", "review all changes on this branch", "review this feature branch", "review the whole repo", "review the entire codebase", "review all commits" → `current-branch` (review ALL commits on the current branch from the first commit to HEAD)
   - User says "review all branches", "review every branch" → `all-branches` (review ALL commits across ALL local branches)
   - User says "review branch B", "review the B branch", "review branch feature-xyz" → `branch:B` or `branch:feature-xyz` (review ALL commits on the specified branch, from its root commit to its HEAD)
   - User says "review B branch's latest commit", "review B branch last commit", "review the most recent commit on branch B" → `commit:B` (B is resolved to its HEAD commit SHA via `git rev-parse B`, then diff that single commit with `git diff SHA~1..SHA`)
   - User says "review commit abc1234", "review the commit abc1234" → `commit:abc1234` (review that single commit)
   - User says "review the last N commits", "review the last N commits on branch B" → `range:REF~N..REF` (e.g., "last 20 commits on master" → `range:master~20..master`)
   - User says "review changes from X to Y", "review commits X through Y" → `range:SHA1..SHA2` (review the specified range)
   - User says "review B branch's recent N months/weeks/days changes", "review changes in the last N months/weeks/days on branch B" → Resolve to `range:SHA1..SHA2` by finding the earliest commit within the time range: `git rev-parse $(git log REF --since="N months ago" --reverse --oneline | head -1 | cut -d' ' -f1)~1` → REF as the range
4. **Default**: `current-branch`

> **Important**: "Review the whole repo" defaults to `current-branch` (all commits on the current branch), NOT `all-branches`. Only use `all-branches` when the user explicitly mentions reviewing across multiple/all branches.

> **CRITICAL for branch:REF, commit:SHA, range:SHA1..SHA2**: These scopes work WITHOUT checking out any branch. Git ref syntax allows diffing any ref from any branch. NEVER run `git checkout` or `git switch` to obtain the diff. Use `git diff {first}..REF`, `git diff SHA~1..SHA`, `git diff SHA1..SHA2` directly — these work from any working branch.

Store resolved scope in session context. This scope controls all git diff commands in subsequent phases.

> **Profiling-diagnostic mode**: Enter **profiling-diagnostic mode** when EITHER condition holds: (a) user prompt / `requirements.md` contains profiling keywords (火焰图, flame graph, GC log, GC日志, profiling, heap dump, async-profiler, OOM, OutOfMemory, 内存泄漏, 性能分析, 性能热点, jfr, allocHumongous, Full GC, cpu profile), OR (b) the `profiling-analysis` reviewer is in the resolved team (whether auto-triggered by keywords per Phase 3 Step C, OR explicitly added via `--team=profiling-analysis:1` / natural language / `.ultra-cr.yaml`). **Equivalence invariant: profiling-analysis in team ⟺ diagnostic mode active** — there is no "profiling as enhancement dimension only" path; whenever the profiling-analysis reviewer runs, diagnostic mode is ON. In this mode:
> - Profiling hot paths (from `hotspot-inventory.md`, produced by the profiling-analysis reviewer in Phase 4) become the **primary review scope** for ALL reviewers, not just the profiling-analysis reviewer. The hotspot inventory is the scope axis; the diff is not.
> - **If a diff exists**: the diff is **demoted to supplementary context**. Reviewers use it only to check "was this hot method recently changed?" — the diff is NOT the scope axis. Phase 2 diff strategy is marked `supplementary (profiling-diagnostic)`.
> - **If no diff exists** (empty diff): profiling is the sole entry — no blocking. Phase 2 diff strategy is marked `N/A (profiling-diagnostic)`.
>
> This is NOT a separate review mode with different phases — the 8-phase workflow runs unchanged. The only difference is the **scope axis**: diagnostic mode uses the hotspot inventory as the scope axis; normal mode (no profiling-analysis reviewer) uses the diff as the scope axis. Profiling file paths are provided by the user in the prompt (Phase 2 Step 3b resolves them: directory → list, file path → record).

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

2. **调用 `get_minimal_context_tool(task="ultra-cr code review", base=$FIRST_COMMIT^, changed_files=[<git diff --name-only 的文件列表>])`**（约 100 token）：
   - 一次拿到 graph stats + risk score + top communities/flows + 建议的下一步工具
   - **必须传 base 参数**：用 scope 解析阶段确定的 `$FIRST_COMMIT^`（首个提交的父提交），使风险评分覆盖整个审查范围；默认 HEAD~1 只分析最后一个 commit，全量审查场景下会严重失真。changed_files 用 `git diff --name-only` 的文件列表
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
- [ ] **PROGRESS.md updated**: Phase 1 status set to `DONE`, scope and session metadata filled in

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

    **Scope: `current-branch`** — ALL commits on the current branch (from the first commit to HEAD)
   **Bash (Linux / macOS / Git Bash):**
   ```bash
    FIRST_COMMIT=$(git rev-list --max-parents=0 HEAD)

   # Metadata (always collected — small output)
    git log $FIRST_COMMIT..HEAD --oneline
    git diff $FIRST_COMMIT..HEAD --name-only
    git diff $FIRST_COMMIT..HEAD --stat
   git branch --show-current

   # Branch diffs are typically large → default to disk-offload, then check size
    git diff $FIRST_COMMIT..HEAD > "$SESSION_DIR/diff.patch"
   DIFF_LINES=$(wc -l < "$SESSION_DIR/diff.patch")

   if [ "$DIFF_LINES" -le 500 ]; then
     # Small branch diff → inline strategy (safe to read into context)
     cat "$SESSION_DIR/diff.patch"
   fi
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```
   **PowerShell (Windows):**
   ```powershell
   $FIRST_COMMIT = git rev-list --max-parents=0 HEAD

   # Metadata (always collected — small output)
   git log "$FIRST_COMMIT..HEAD" --oneline
   git diff "$FIRST_COMMIT..HEAD" --name-only
   git diff "$FIRST_COMMIT..HEAD" --stat
   git branch --show-current

   # Branch diffs are typically large → default to disk-offload, then check size
   git diff "$FIRST_COMMIT..HEAD" | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
   $DIFF_LINES = (Get-Content "$SESSION_DIR/diff.patch" | Measure-Object -Line).Lines

   if ($DIFF_LINES -le 500) {
     # Small branch diff → inline strategy (safe to read into context)
     Get-Content "$SESSION_DIR/diff.patch" -Raw
   }
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```

   **Scope: `all-branches`** — ALL commits across all local branches (each from its first commit)
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # Metadata (safe to read into context — small output)
   git log --all --oneline -20
   git branch -a

   # Per-branch metadata + diff → persist to disk ONLY
   for BRANCH in $(git branch --format='%(refname:short)'); do
     FIRST_COMMIT=$(git rev-list --max-parents=0 $BRANCH)
     echo "=== Branch: $BRANCH ==="
     git log $FIRST_COMMIT..$BRANCH --oneline
     git diff $FIRST_COMMIT..$BRANCH --name-only
     git diff $FIRST_COMMIT..$BRANCH --stat
   done

   # Full merged diff → persist to disk ONLY, do NOT read into context
   {
     for BRANCH in $(git branch --format='%(refname:short)'); do
       FIRST_COMMIT=$(git rev-list --max-parents=0 $BRANCH)
       echo "=== Branch: $BRANCH ==="
       git diff $FIRST_COMMIT..$BRANCH
     done
   } > "$SESSION_DIR/diff.patch"
   ```
   **PowerShell (Windows):**
   ```powershell
   # Metadata (safe to read into context — small output)
   git log --all --oneline -20
   git branch -a

   # Per-branch metadata + diff → persist to disk ONLY
   $branches = git branch --format='%(refname:short)'
   foreach ($BRANCH in $branches) {
     $FIRST_COMMIT = git rev-list --max-parents=0 $BRANCH
     Write-Output "=== Branch: $BRANCH ==="
     git log "$FIRST_COMMIT..$BRANCH" --oneline
     git diff "$FIRST_COMMIT..$BRANCH" --name-only
     git diff "$FIRST_COMMIT..$BRANCH" --stat
   }

   # Full merged diff → persist to disk ONLY, do NOT read into context
   $diffContent = foreach ($BRANCH in $branches) {
     $FIRST_COMMIT = git rev-list --max-parents=0 $BRANCH
     Write-Output "=== Branch: $BRANCH ==="
     git diff "$FIRST_COMMIT..$BRANCH"
   }
   $diffContent | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
   ```

   **Scope: `branch:REF`** — ALL commits on the specified branch or ref (from its first commit to the ref)
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   # Resolve REF (validate it exists)
   git rev-parse --verify REF

   FIRST_COMMIT=$(git rev-list --max-parents=0 REF)

   # Metadata (always collected — small output)
   git log $FIRST_COMMIT..REF --oneline
   git diff $FIRST_COMMIT..REF --name-only
   git diff $FIRST_COMMIT..REF --stat
   git branch --show-current

   # Generate diff and determine strategy
   git diff $FIRST_COMMIT..REF > "$SESSION_DIR/diff.patch"
   DIFF_LINES=$(wc -l < "$SESSION_DIR/diff.patch")

   if [ "$DIFF_LINES" -le 500 ]; then
     # Small diff → inline strategy (safe to read into context)
     cat "$SESSION_DIR/diff.patch"
   fi
   # If > 500 lines, do NOT read diff.patch into context (disk-offload mode)
   ```
   **PowerShell (Windows):**
   ```powershell
   # Resolve REF (validate it exists)
   git rev-parse --verify REF

   $FIRST_COMMIT = git rev-list --max-parents=0 REF

   # Metadata (always collected — small output)
   git log "$FIRST_COMMIT..REF" --oneline
   git diff "$FIRST_COMMIT..REF" --name-only
   git diff "$FIRST_COMMIT..REF" --stat
   git branch --show-current

   # Generate diff and determine strategy
   git diff "$FIRST_COMMIT..REF" | Set-Content -Path "$SESSION_DIR/diff.patch" -Encoding UTF8
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
    FIRST_COMMIT=$(git rev-list --max-parents=0 HEAD)
    git log $FIRST_COMMIT..HEAD --oneline
   git branch --show-current

   # For all-branches scope
   git log --all --oneline -20
   git branch -a

   # For branch:REF scope
   FIRST_COMMIT=$(git rev-list --max-parents=0 REF)
   git log $FIRST_COMMIT..REF --oneline
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
   $FIRST_COMMIT = git rev-list --max-parents=0 HEAD
   git log "$FIRST_COMMIT..HEAD" --oneline
   git branch --show-current

   # For all-branches scope
   git log --all --oneline -20
   git branch -a

   # For branch:REF scope
   $FIRST_COMMIT = git rev-list --max-parents=0 REF
   git log "$FIRST_COMMIT..REF" --oneline
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
      - 调用 `detect_changes_tool(base=$FIRST_COMMIT^, changed_files=[<git diff --name-only 的文件列表>], detail_level="minimal")` 获取风险评分，识别高风险变更点。**必须传 base=$FIRST_COMMIT^**（首个提交的父提交），否则默认 HEAD~1 只分析最后一个 commit，全量审查场景下风险评分严重失真。**该工具已聚合受影响函数、flows、测试覆盖缺口**，优先复用其输出，避免逐文件重复查询（对齐 code-review-graph 官方"≤5 tool calls"目标）
      - **交叉验证**: 对比 `git diff --name-only` 输出与 `detect_changes_tool` 结果。如果某变更文件在 git diff 中出现但 `detect_changes_tool` 未返回该文件的任何函数/类，在导航提示中标注"⚠️ 图谱未索引此文件中的函数，reviewer 需自行 Grep/Read 检查"
      - **仅对 top-N 高风险函数**调用 `get_impact_radius_tool(changed_files=[<top-N 函数所在文件>], base=$FIRST_COMMIT^, detail_level="minimal")` 获取上游调用方和下游依赖（替代 `grep -r "import.*from.*changed-file"`）。N 自适应：变更 ≤5 文件取全部，6-20 文件取 top-3，>20 文件取 top-5（避免对每个变更文件都调用导致 token 超预算）。注意 get_impact_radius_tool 按 changed_files（文件级）分析，传 top-N 高风险函数**所在文件**
      - 调用 `get_affected_flows_tool(changed_files=[<git diff --name-only 的文件列表>])` 获取受影响执行路径（识别跨模块/跨层边界影响）。**必须传入 changed_files 参数**（从 `git diff --name-only` 获取的变更文件列表），否则返回的是全图 flows 而非"受本次变更影响的 flows"，数据会误导。注意该工具无 `detail_level` 参数，但接受 base（默认 HEAD~1，全量审查建议传 $FIRST_COMMIT^）
      - **仅对 top-N 高风险函数**调用 `query_graph_tool(pattern="tests_for")` 检查测试覆盖缺口（`detect_changes_tool` 已提供大部分测试缺口信息，此处仅补充高风险函数的精确匹配）
      - 生成导航提示写入 context.md：只给出"该查哪里"的方向，不做代码级判断，控制在 500-800 token 以内（只列最关键的导航方向）
      - 注意标注 graph 不覆盖的区域（MyBatis XML、配置文件等），提示 reviewer 用 Grep/Read 补充
      - **Disk-offload 模式补偿**（当 diff > 500 行、Tech Lead 未读 diff 时）：额外调用 `get_review_context_tool(changed_files=[<git diff --name-only 的文件列表>], base=$FIRST_COMMIT^, include_source=True, max_lines_per_file=200, detail_level="minimal")` 拿到变更函数的精简源码片段，补偿"读不到 diff"的信息缺失。**必须传 base 和 changed_files**，否则默认 HEAD~1 只拿最后一个 commit 的源码。`include_source=True` 会增大返回，`max_lines_per_file` 上限控制单文件 token；仅在此 disk-offload 场景使用，inline 模式不需要
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

   **DO**: The profiling-analysis reviewer MUST persist its Hot Stack Inventory to `$SESSION_DIR/hotspot-inventory.md` (see `references/reviewers/specialist/profiling-analysis.md` Step 1 "MANDATORY: Persist Hot Stack Inventory to Disk"). The main agent does NOT generate this file — the reviewer does. The Tech Lead reads `hotspot-inventory.md` during Phase 6 (discourse) and Phase 7 (synthesis) to cross-reference profiling evidence with other reviewers' findings.

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
   **范围**: {暂存更改 | 当前分支所有提交 | 所有分支所有提交 | 指定分支(REF)所有提交 | 指定提交(SHA) | 指定范围(SHA1..SHA2)}
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
- [ ] **PROGRESS.md updated**: Phase 2 status set to `DONE`, Diff Strategy and output files recorded

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
   - **Custom reviewer auto-detection (intelligent matching)**: Scan the BUNDLED reviewer directory (located inside the ultra-cr skill installation — try `${SKILL_ROOT}/references/reviewers/bundled` first, then `references/reviewers/bundled`) for ALL subdirectories (each subdirectory is a reviewer; the directory name is the reviewer ID), and scan `~/.config/ultra-cr/reviewer/`, `.reviews/ultra-cr/reviewer/` for ALL subdirectories too (same convention — each subdirectory is a reviewer). For each one NOT already in the team config, read its persona body (the direct-level `.md` file(s) inside the subdirectory; title, intro, Focus Areas, etc.) and judge whether it is applicable to the current change based on the file list, file types, and (if inline mode) diff content. If applicable → add it to the team (does NOT count toward the 6-reviewer limit). This is an LLM judgment. The reviewer's own description is the signal. See Step H for the full procedure.
   > **Example**: The `java-code-smell/` reviewer subdirectory contains a persona that describes itself as a Java code-smell reviewer with focus areas like concurrency, crypto, dependency management. When the file list contains `.java` files, the Tech Lead judges it applicable and auto-adds it. The user does NOT need to edit any framework file to enable this.
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
   ### JavaCodeSmell Reference Files
   - ✅ java-code-smell-checklist.md
   ```

   > **No SKILL.md/workflow.md edits needed for new reviewers**: Because loading is driven by a single directory-level convention (direct-level `.md` = persona, subdirectory `.md` = references) shared by all three paths, adding a new reviewer subdirectory (with persona `.md` and optional reference subdirectories) under any path requires NO changes to this file or `SKILL.md`. The example above uses `java-code-smell` only for illustration — the same mechanism applies to any custom reviewer on any path.

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
   Map extensions to reviewers:
   - `.tsx`/`.jsx`/`.vue`/`.svelte`/`.css`/`.scss` → +1 Frontend
   - `.go`/`.py` → +1 Backend
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
   - ✅ +1 Security (triggered by: "auth" keyword in FileX.java)
   - ✅ +1 Frontend (triggered by: .tsx file extension)
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
   - ✅ +1 java-code-smell (auto-detected: applicable to .java changes)
   - ✅ +1 Profiling Analysis (triggered by: "火焰图" keyword in user prompt; profiling-diagnostic mode ON)
   ```

   **Step H: Custom Reviewer Intelligent Auto-Detection** (does NOT count toward the 6-reviewer limit) — MANDATORY, NEVER SKIP

   Custom reviewers are auto-detected by intelligent matching. The Tech Lead reads each reviewer's persona body and judges applicability. This step is MANDATORY for every review regardless of diff strategy (inline or disk-offload) or change size. Even a 1-file, 10-line change MUST run this scan.

   > **Why mandatory**: BUNDLED custom reviewers (e.g. `golang-deep-review`, `java-code-smell`) encode domain-specific code-smell knowledge. Skipping the scan silently drops these reviewers and misses critical findings. A scan that returns zero results is only acceptable if ALL search paths were actually checked and empty — never because a command failed silently.

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
   2. Judge whether this reviewer is applicable to the current change, based on: the file list, file types/extensions, and (if inline mode) diff content. This is an LLM judgment using the reviewer's own self-description as the only signal.
   3. If applicable → add it to the resolved team (does NOT count toward the 6-reviewer limit)
   4. Deduplication: skip if already in team config or already added by the user via `--team`/natural language/`.ultra-cr.yaml`
   5. For each added reviewer, load its reference files per Step 5 above (all `.md` files in ALL subdirectories of the reviewer's directory, recursively — same rule for all three paths).
   6. **Document EVERY found reviewer** — even non-applicable ones must be listed as "available, not applicable" (so the scan is auditable). Example:
   ```markdown
   ### Custom Reviewers (no limit, auto-detected + user-requested)
   - ✅ +1 golang-deep-review (auto-detected: applicable to .go changes)
   - ⬜ java-code-smell (available, not applicable: no .java files in this change)
   ```

   > **No framework edits needed for new reviewers**: Because matching is driven by the reviewer's own persona description, adding a new reviewer subdirectory (with persona `.md` at direct level, plus optional reference subdirectories) under any of the three search paths is all that's required. The Tech Lead will discover and judge it automatically on the next review.

   Document custom reviewers in Tech Lead Guidance:
   ```markdown
   ### Custom Reviewers (no limit, auto-detected + user-requested)
   - ✅ +1 java-code-smell (auto-detected: applicable to .java changes)
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

   d) 对 `detect_changes_tool` 识别的高风险 Java 函数，调用 `find_large_functions_tool(file_path_pattern=<变更路径>, min_lines=200)` 定位超长方法：
      - 直接喂给 JavaCodeSmell 的性能检查（结合调用频次和实际证据），替代逐文件读源码判断

   ```markdown
   ### 结构级风险（知识图谱）
   - ⚠️ `PaymentService.process` 是 hub 节点（总度数 12，扇入 8），本次变更影响面大，建议 Architect 重点关注
   - ⚠️ `AuthRouter.dispatch` 是 bridge 节点（介数 0.43），断裂将导致认证/授权区域失联
   - ⚠️ `OrderService.create`（社区 order）→ `InventoryService.lock`（社区 stock）存在意外耦合
     原因: cross-community，surprise_score: 0.50 → Architect 检查是否违反架构边界
   - ⚠️ `OrderHandler.parse` 超 250 行，JavaCodeSmell 需结合实际性能证据检查
   ```

   **记录到 Graph Usage Log**：Step I 的 `query_graph_tool(tests_for)` 调用和 Step J 的 `get_knowledge_gaps_tool`/`get_hub_nodes_tool`/`get_bridge_nodes_tool`/`get_surprising_connections_tool`/`find_large_functions_tool` 调用（含 skip 情况），均向 context.md 的 Graph Usage Log 表追加一行（Phase=3）。skip 的调用也要记录，便于事后审计"为何未使用某工具"。

7. Update `context.md` with Tech Lead guidance section.

### Phase 3 Checkpoint

**STOP and verify before proceeding (self-check, do NOT ask the user):**
- [ ] `context.md` updated with Tech Lead guidance
- [ ] Reviewer team resolved (know which reviewers to spawn)
- [ ] If graph available: risk-based reviewer suggestions documented in Tech Lead Guidance
- [ ] If graph available: test coverage gaps identified and documented in Tech Lead Guidance (Testing reviewer is NOT auto-added — opt-in only)
- [ ] If graph available and high-risk changes present: structural risk supplement (knowledge gaps / large functions) documented
- [ ] If graph available: Graph Usage Log updated with Phase 3 tool calls (Step I/J, incl. skip)
- [ ] **PROGRESS.md updated**: Phase 3 status set to `DONE`, resolved reviewer count recorded

---

## Phase 4: Spawn Reviewers

Read `references/configuration.md` §Subagent Dispatch Contract. Use the current host's delegation facility, one independent context per reviewer instance. Respect host concurrency limits and queue batches without dropping reviewers.

**Goal**: Run each reviewer independently with configured redundancy.

### Resume Check (if interrupted)

Before starting Phase 4, check if this is a resume from an interrupted session:

**Bash (Linux / macOS / Git Bash):**
```bash
# Check which reviewer files already exist
ls -1 "$SESSION_DIR/rounds/round-$CURRENT_ROUND/reviews/" 2>/dev/null
```
**PowerShell (Windows):**
```powershell
# Check which reviewer files already exist
Get-ChildItem -Path "$SESSION_DIR/rounds/round-$CURRENT_ROUND/reviews/" -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
```

Compare existing files against the resolved reviewer team. **Only spawn reviewers whose output files are missing.** If a reviewer file exists but appears incomplete (e.g., no `## Summary` section), treat it as missing and re-spawn that reviewer.

> **Profiling-diagnostic mode resume**: The two-wave dependency rule from Phase 0 Step 4 applies here too. If diagnostic mode is active: (1) if `hotspot-inventory.md` is missing, re-spawn the profiling-analysis reviewer FIRST (Wave 1) and wait — do NOT spawn Wave 2 reviewers until it exists; (2) if `hotspot-inventory.md` exists but Wave 2 reviewer files are missing, re-spawn them WITH the hotspot scope re-injected (scope injection is stateless, must be provided on every spawn including resume). See Phase 0 Step 4 "Profiling-diagnostic mode resume" for the full rule.

Update PROGRESS.md to mark Phase 4 as `IN_PROGRESS` with the list of completed and pending reviewers.

### Output Contract Checklist (MANDATORY before spawning any reviewer)

> **Read and confirm BEFORE spawning the first reviewer.** These rules are derived from the Output Convention in `SKILL.md` and are NON-NEGOTIABLE. If any rule is violated during the review, the output is INVALID.

- [ ] **File naming**: Final review output is ALWAYS `rounds/round-{n}/final.md` — never `SYNTHESIS.md`, `synthesis.md`, or any other name
- [ ] **Language**: ALL persisted output is written in Chinese (中文) — `PROGRESS.md`, reviewer files, `discourse.md`, `final.md`, terminal output. Only code/file paths/identifiers/status values remain in English
- [ ] **Cleanup**: `diff.patch` will be deleted in Phase 8 if disk-offload mode is used
- [ ] **Reviewer output path**: `rounds/round-{current_round}/reviews/{type}-{instance}.md`
- [ ] **Discourse output path**: `rounds/round-{current_round}/discourse.md`
- [ ] **Every finding has a location**: `path/to/file.ext:startLine-endLine` — no exceptions
- [ ] **No change descriptions**: Only actionable findings (bugs, risks, defects, improvements) — no "Added X", "Removed Y", "Changed Z"

### Steps

1. Load reviewer personas from `references/reviewers/{category}/{type}.md`:
   - Holistic: `references/reviewers/holistic/{type}.md`
   - Specialist: `references/reviewers/specialist/{type}.md`
   - Persona: `references/reviewers/persona/{type}.md`
   - Bundled: `references/reviewers/bundled/{type}/` (a subdirectory; persona = direct-level `.md` files inside it)

   Category mapping for reviewer IDs:
   | Reviewer ID | Category |
   |---|---|
   | principal, architect, fullstack, reliability, staff-engineer | holistic |
   | quality, security, testing, frontend, backend, performance, profiling-analysis, devops, data, infrastructure, accessibility, dx, mobile, ai, docs-writer | specialist |
   | martin-fowler, sandi-metz, john-ousterhout | persona |
   | any `{reviewer-id}/` subdirectory found under `references/reviewers/bundled/` | bundled |

   **Custom reviewer directory convention (all three paths)** — All custom reviewers (BUNDLED, user-global, project-level) use the SAME directory convention. The BUNDLED directory lives inside the ultra-cr skill installation: `${SKILL_ROOT}/references/reviewers/bundled/` (global skill install) or `references/reviewers/bundled/` (when CWD = skill dir). The user-global root is `~/.config/ultra-cr/reviewer/`; the project-level root is `.reviews/ultra-cr/reviewer/`. Under any of these roots, each reviewer is a **subdirectory** `{reviewer-id}/` (the directory name is the reviewer ID). The persona is formed by ALL `.md` files at the directory's **direct level** (concatenate them); reference files are ALL `.md` files inside ANY subdirectory of `{reviewer-id}/` (recursively). This keeps each reviewer self-contained, and persona/reference filenames are free — only the directory level matters.

   > **Path resolution note**: The `references/reviewers/bundled/` paths are relative to the ultra-cr skill root. When executing shell commands to scan/load (e.g. in Step H), resolve the BUNDLED directory via `${SKILL_ROOT}/references/reviewers/bundled` first (since CWD at runtime is the reviewed project, not the skill dir). The platform resolves built-in reviewer personas (`holistic/`, `specialist/`, `persona/`) via the skill root automatically; custom reviewers (BUNDLED + user paths) need explicit path resolution in shell commands. The user-global and project-level roots are already absolute/relative to the reviewed project.

   ```
   {search-path-root}/               ← bundled/ | ~/.config/ultra-cr/reviewer/ | .reviews/ultra-cr/reviewer/
   ├── {reviewer-id}/               ← a reviewer subdirectory (name = reviewer ID)
   │   ├── persona.md               ← persona: direct-level .md (filename free; multiple allowed)
   │   └── <any-subdir>/            ← reference: .md files in any subdirectory (name free, recursive)
   │       └── ...
   ```

   When resolving a custom reviewer ID, load the persona from ALL `.md` files at the direct level of the reviewer's subdirectory (concatenate them). Any reference files the reviewer needs are ALL `.md` files in ALL subdirectories of the reviewer's subdirectory (recursively — NOT the direct-level files, NOT the shared root) — the framework loads them automatically (see Phase 3 Step 5). To **discover all available custom reviewers**, scan every **subdirectory** directly under each search-path root — each subdirectory name is a valid reviewer ID. A subdirectory with no direct-level `.md` file is skipped (not a valid reviewer). This allows users to add new custom reviewers by simply creating a `{reviewer-id}/` subdirectory (with persona `.md` at direct level, plus optional reference subdirectories) under any of the three roots — no edits to `SKILL.md` or `workflow.md` are needed.

   **Custom reviewer resolution** — If the reviewer ID does NOT match any built-in category above (holistic/specialist/persona/bundled), search for the reviewer subdirectory in this order (use the FIRST match found — a match = a `{reviewer-id}/` subdirectory with at least one direct-level `.md` file):
   1. `~/.config/ultra-cr/reviewer/{reviewer-id}/` — Global custom reviewers (shared across all projects)
   2. `.reviews/ultra-cr/reviewer/{reviewer-id}/` — Project-level custom reviewers (committed to VCS)
   3. `${SKILL_ROOT}/references/reviewers/bundled/{reviewer-id}/` (or `references/reviewers/bundled/{reviewer-id}/`) — BUNDLED skill-bundled reviewers

   > **`~`** = user home directory (`$HOME` on Linux/Mac, `%USERPROFILE%` on Windows)

   If no subdirectory is found in any of these paths, treat the reviewer ID as an **ephemeral reviewer** — synthesize a focused persona from the reviewer ID name (convert kebab-case to descriptive focus areas).


2. For each reviewer in the resolved team:
   - Spawn with the persona's focus areas
   - Provide: project context, requirements, Tech Lead guidance, impact analysis
   - **Diff delivery depends on strategy**:
     - **Inline mode**: Include the diff directly in the reviewer's prompt
     - **Disk-offload mode**: Instruct the reviewer to read `$SESSION_DIR/diff.patch` as their first action
   - Instruct to explore codebase with full agency
   - Output to `rounds/round-{current_round}/reviews/{type}-{n}.md`

   **⚠️ Profiling-diagnostic mode: Two-wave spawn (when active)**
   When profiling-diagnostic mode is active (determined in Phase 1, recorded in `discovered-standards.md`), the spawn order becomes a **two-wave** sequence so that all reviewers receive the hotspot inventory as their review scope:

   - **Wave 1 — Spawn ONLY the `profiling-analysis` reviewer first.** It MUST produce `$SESSION_DIR/hotspot-inventory.md` (the Hot Stack Inventory, see `references/reviewers/specialist/profiling-analysis.md` Step 1). Wait for Wave 1 to complete before starting Wave 2 — other reviewers need the hotspot list to know what to review.
   - **Wave 2 — Spawn ALL other reviewers in parallel** (preserve parallelism for everyone except the profiling-analysis reviewer). Inject the `hotspot-inventory.md` hot method list as each reviewer's **review scope** (see Step 5 "Profiling-diagnostic scope injection" below). Each non-profiling reviewer is told: "诊断模式下，你的审查范围是以下热点方法及其调用链（来自 hotspot-inventory.md）：[hotspot list]。diff 仅作为补充上下文（用于判断热点是否被改动），不是你的审查范围主轴。"

   **Why two-wave (not fully parallel)**: Other reviewers need the hotspot list to know what to review. Without it, they'd review the diff (wrong scope for diagnostic mode). The two-wave adds one reviewer's latency to the critical path, but keeps all other reviewers parallel. This is an explicit, justified tradeoff.

   **Fallback**: If `hotspot-inventory.md` is missing after Wave 1 (the profiling-analysis reviewer failed to produce it — e.g., user triggered via keyword but provided no profiling files, see Phase 2 Step 3b degradation warning), fall back to normal mode (diff as scope axis) for Wave 2 reviewers, and note the degradation in `discovered-standards.md` ("profiling-diagnostic mode degraded to normal mode: hotspot-inventory.md missing after Wave 1"). This is the ONLY path where diagnostic mode does not take effect despite the profiling-analysis reviewer being in the team.

   **Non-diagnostic mode** (profiling-analysis reviewer NOT in team): Skip the two-wave logic entirely — spawn all reviewers in parallel as normal (diff is the scope axis). Per the equivalence invariant (Phase 1), profiling-analysis not in team ⟺ diagnostic mode OFF.

3. **File naming pattern**: `{type}-{instance_number}.md`
   - `principal-1.md`, `principal-2.md`, `quality-1.md`, etc.

4. **Mandatory Output Format**: Each reviewer output file MUST begin with a `## Summary` section written FIRST, before detailed findings. **All content MUST be in Chinese (中文)** — only code, file paths, and identifiers remain in English:

   - **Blockers**: {count} — {one-line list of blocker titles in Chinese}
   - **Should Fix**: {count} — {one-line list of should-fix titles in Chinese}
   - **Suggestions**: {count}
   - **Top Finding**: {most critical finding, one sentence in Chinese}

   This summary section is critical for Phase 7 Synthesis — it allows the Tech Lead to read a condensed version of all reviewer findings even under context pressure. The summary MUST be written FIRST, before the detailed findings.

 5. Each reviewer task receives:
    - Reviewer persona (from the resolved file or directory under `${SKILL_ROOT}/references/reviewers/`, or the configured custom reviewer root)
    - Project context (from `discovered-standards.md`)
    - Requirements context (from `requirements.md` if provided)
    - Tech Lead guidance (including requirements assessment)
    - Architecture impact analysis (from `context.md`)
    - **Diff content** (delivery depends on strategy):
      - **Inline mode**: The diff is included directly in the prompt
      - **Disk-offload mode**: `$SESSION_DIR/diff.patch` file path — the reviewer MUST read this file as its first action
    - **Navigation tips**（仅当 graph 可用时注入，参见下方"Graph Navigation Tips"）
    - **Graph exploration guide**（仅当 graph 可用时注入，参见下方"Graph Exploration Guide"）
    - **Profiling-diagnostic scope injection**（仅当 profiling-diagnostic mode 激活时注入，仅 Wave 2 评审员，非 profiling-analysis 评审员）:
      - 读取 `$SESSION_DIR/hotspot-inventory.md` 的 Hot Stack Inventory 表，提取热点方法清单
      - 在评审员 prompt 中注入：`## 诊断模式审查范围`，明确列出热点方法及其调用链，并声明"diff 仅作为补充上下文（判断热点是否被改动），不是你的审查范围主轴"
      - 评审员应围绕这些热点方法及其调用链展开审查（从自身专业视角，如 security 评审员关注热点方法的安全风险、quality 评审员关注热点方法的代码质量），而非审查 diff
    - Instruction to explore codebase with full agency

    **Graph Navigation Tips**（仅当 graph 可用时注入）:

    从 context.md 提取 graph 导航提示，告诉 reviewer "该查哪里"。导航提示只给方向，不做代码级判断。SQL 注入、代码味道、逻辑 bug 等必须靠 reviewer 读代码发现。

    ```markdown
    ## 知识图谱: 导航提示

    以下信息来自知识图谱的结构级分析，帮助你快速定位需要深入检查的代码区域。
    **重要**: 导航提示只告诉你"该查哪里"，不替代你读代码做细节分析。
    SQL 注入、代码味道、逻辑 bug 等必须靠你读代码发现。

    ### 高风险变更点
    - `AuthService.login()` 风险评分 0.82（>=0.7 高风险）
      → 导航: 上游调用方 AuthController, MobileAuthController, TokenRefreshService
      → 导航: 下游依赖 UserRepository, LdapClient, AuditLogService
      → 建议: Security reviewer 检查上游认证流程完整性；Architect 检查下游 LdapClient 容错

    - `UserRepository.findByName()` 风险评分 0.50（<0.7，非高风险但需关注）
      → 导航: 上游调用方 AuthService.login()
      → ⚠️ graph 不覆盖此函数的 MyBatis XML 映射
      → 建议: Grep/Read 检查 UserMapper.xml 的 SQL 参数化

    ### 受影响执行路径
    - HTTP → AuthController → AuthService → UserRepository
    - Token 刷新 → TokenRefreshService → AuthService → LdapClient

    ### 测试覆盖缺口
    - ⚠️ `TokenRefreshService.refresh()` 无测试覆盖
    - ✅ `AuthService.login()` 有测试覆盖 (AuthServiceTest)

    ### 边界跨越
    - controller → service 层：认证逻辑变更
    - service → 外部系统(LdapClient)：外部调用稳定性风险

    ### Graph 未覆盖区域（需 Grep/Read 补充）
    - MyBatis XML 映射文件
    - Spring 配置文件（yml/properties）
    - 非代码资源
    ```

    **Graph Exploration Guide**（仅当 graph 可用时注入）:

    ```markdown
    ## 知识图谱: 探索指南

    你可以使用 code-review-graph MCP 工具快速定位代码区域，然后用 Diff/Grep/Read 做细节分析。

    | 工具 | 用途 | 使用场景 |
    |------|------|---------|
    | `query_graph_tool(pattern="callers_of", target=函数)` | 谁调用了此函数 | 追踪上游影响范围 |
    | `query_graph_tool(pattern="callees_of", target=函数)` | 此函数调用了谁 | 追踪下游依赖 |
    | `query_graph_tool(pattern="tests_for", target=函数/类)` | 有哪些测试 | 验证变更是否有测试保护 |
    | `get_affected_flows_tool` | 受影响的执行路径 | 追踪跨模块调用链 |
    | `semantic_search_nodes_tool(query="关键词")` | 语义搜索 | 按功能/概念搜索代码 |
    | `get_impact_radius_tool(changed_files=[...])` | 影响半径 | 快速了解变更的爆炸半径（按文件，非单个函数） |
    | `get_review_context_tool(changed_files=[...], include_source=True, max_lines_per_file=200)` | 精简源码片段 | 需要快速查看变更文件实现时 |
    | `traverse_graph_tool(query=..., mode=bfs, depth=3, token_budget=2000)` | token 预算受控的图遍历 | 需要理解函数完整调用上下文（不只直接 callers/callees）时，token_budget 硬上限防止爆炸 |

    使用原则:
    - **Graph 做导航（"该查哪里"），Diff/Grep/Read 做分析（"具体有什么问题"）**
    - 用 `detail_level="minimal"` 减少输出 token（traverse_graph 无 detail_level，用 token_budget 控制）
    - Graph 不覆盖的内容（XML、配置、非代码文件）必须用 Grep/Read 检查
    - 不要仅依赖导航提示——它是起点，不是终点
    - 如果你怀疑某个函数有问题，先用 graph 查它的调用链，再用 Grep/Read 读具体实现
    - traverse_graph 适合"我想看这个函数周围 2-3 跳的全部上下文"的场景，比手动多次 callers_of/callees_of 更省 token
    ```

   **MANDATORY output rules for every reviewer**:
   - **Location rule**: Every finding MUST include a complete file path with line numbers in the format `path/to/file.ext:startLine-endLine`. Findings without location are INVALID.
   - **No change descriptions**: Reviewers MUST ONLY output actionable findings (bugs, risks, defects, improvement points). Change descriptions ("Removed X", "Added Y"), refactoring summaries, and factual statements are PROHIBITED.
   - **Self-check before output**: Before writing each finding, the reviewer MUST ask: "Does this point to a specific problem requiring developer action?" If not, discard it.

   **Dead Code Detection for deletion/refactor scenarios**（当 graph 可用且 diff 含大量删除时，注入 Principal/Quality reviewer）:

   当 diff 含大量删除行（删除行数 > 50 或删除行占比 > 30%）时，调用 `refactor_tool(mode="dead_code", file_pattern=<变更路径>)` 检测遗留孤儿代码（无调用方/无测试/无导入/非入口点的函数/类）。⚠️ **仅检测，绝不应用**——`apply_refactor_tool` 在审查中被禁止使用（审查工具必须只读）。

   - **false positive 防御**: dead_code 可能误判反射/SPI/动态调用/框架注解（@Bean/@EventListener 等）触发的代码为死代码。结果标注"可能是孤儿代码"而非"确定是死代码"，由 Principal reviewer 结合源码判断
   - 命中的死代码注入 Principal reviewer 导航:
     "⚠️ {函数} 在 {file} 无任何调用方/测试/导入，可能是孤儿代码（注意排除反射/SPI/框架调用），确认是否应一并删除"
   - 无命中 → skip，记录 Graph Usage Log

6. **Custom reviewer reference loading** (applies to ANY custom reviewer): When spawning a custom reviewer (from `references/reviewers/bundled/`, `~/.config/ultra-cr/reviewer/`, or `.reviews/ultra-cr/reviewer/`), you MUST read that reviewer's "{ReviewerName} Reference Files" list from `context.md` (built in Phase 3 Step 5) and attach ALL loaded reference files to the reviewer's prompt. For ALL custom reviewers (BUNDLED, user-global, project-level alike), the reference files are ALL `.md` files in ALL subdirectories of the reviewer's subdirectory (recursively) — the same rule applies to every path. The reviewer persona body itself contains any reviewer-specific rules (e.g., thread-safe class lists, detection rules, full-file-scan mandates). Include the persona body verbatim in the prompt so those rules are enforced.

   **Graph Navigation for Java code-smell reviewers**（当 graph 可用时附加）:

   为 Java code-smell 类 reviewer（如 java-code-smell）提供调用链上下文导航，辅助判断 code smell 的严重程度和修复优先级。
   该 reviewer 仍需读完整 Java 源码做语句级分析，graph 只辅助判断函数所在上下文。

   a) 对检测到 ThreadPool/CompletableFuture/parallelStream 的函数，用 `query_graph_tool(pattern="callers_of")` 追踪调用链：
      - 识别是否在请求处理路径上（影响线程池选择建议）
      - 识别是否有异步调用链（CompletableFuture 链式调用）

   b) 对检测到 MessageDigest/SecureRandom/Random 的函数，用 `query_graph_tool(pattern="callers_of")` 追踪是否在安全敏感路径：
      - 识别是否被签名/认证函数调用（应使用 SecureRandom）
      - 识别是否在并发上下文中（应使用 ThreadLocal）

   c) **复用 Phase 3 Step J 的 `find_large_functions_tool` 结果**：将已识别的超长方法（>200 行）直接作为 JVM 性能检测的导航输入，reviewer 无需逐文件读源码判断方法长度，直接对这些方法检查可拆分性。

   d) 将导航提示附加到 reviewer context：
      ```markdown
      ## 知识图谱: Java 调用链导航

      以下调用链上下文来自知识图谱，帮助你判断 code smell 的严重程度和修复优先级。
      你仍需读完整 Java 源码做语句级分析，graph 只提供结构级上下文。

      ### 并发上下文
      - `processAsync` 的上游调用方: `OrderService.handleOrder`（HTTP 请求路径）
        → 此函数在线程池选择上需考虑请求上下文传播
      - `batchProcess` 的上游调用方: `ScheduledJob.dailyBatch`（定时任务路径）
        → 此函数可使用独立线程池，不受 Web 线程池限制

      ### 安全上下文
      - `generateNonce` 的上游调用方: `SignatureService.sign`（签名路径）
        → ⚠️ 此函数在安全敏感路径上，应使用 SecureRandom 而非 Random

      ### 超长方法（来自 find_large_functions_tool）
      - `OrderHandler.parse` 250 行 → 结合运行证据检查性能影响；不能仅凭长度报告缺陷
      ```

      注意: 导航提示不替代 reviewer 的完整源码扫描。reviewer 仍需读每个 Java 文件的完整源码做语句级检测。导航提示的作用是：
      1. 帮助判断发现的 code smell 的严重程度（安全路径上的 Random 比工具类中的更严重）
      2. 提供修复建议的上下文（知道是请求路径才能建议合适的线程池配置）
      3. 超长方法导航让性能检测直接定位目标，省去全文件长度扫描

7. **Custom reviewer cross-review** (driven by the reviewer's persona body): All reviewers run in parallel as normal. If a custom reviewer's persona body contains a "Cross-Review Awareness" section (natural language describing which domain reviewers should validate its findings), the Tech Lead reads that section and routes the reviewer's findings accordingly during Phase 6 (Discourse) — the routed domain reviewers MUST respond with AGREE/CHALLENGE. This is enforced in Phase 6 via the discourse prompt, which includes the custom reviewer's findings and instructs each routed reviewer to validate the findings in its domain. No serial execution is needed — all reviewers run in parallel, and cross-validation happens in discourse. Reviewers without a "Cross-Review Awareness" section have no mandatory cross-review routing (their findings are still visible to all reviewers for optional AGREE/CHALLENGE).

8. **Profiling Analysis reviewer special context**: When spawning a profiling-analysis reviewer:
   - Provide the profiling file paths from `context.md` "Profiling Data Status" section
   - The reviewer MUST read the original profiling files itself using the grep extraction commands defined in its persona (`references/reviewers/specialist/profiling-analysis.md`)
   - If `hotspot-inventory.md` already exists in `$SESSION_DIR/` (e.g., from a resumed run), inform the reviewer it exists — but the reviewer MUST still produce/refresh it as the authoritative artifact (see its Step 1 "MANDATORY: Persist Hot Stack Inventory to Disk")
   - **CRITICAL**: Instruct the reviewer that it MUST NOT attempt to read entire HTML flame graph files — it MUST use grep-based extraction only
   - Provide the diff content (same as other reviewers) so the reviewer can do Hot Path × Diff cross-reference — in profiling-diagnostic mode (always active when this reviewer is in team, per the Phase 1 equivalence invariant), provide the diff as **supplementary context** (if a diff exists); if no diff exists (Phase 2 diff strategy = `N/A (profiling-diagnostic)`), tell the reviewer there is no diff. The reviewer uses the diagnostic-mode adaptation in both sub-cases (see its Step 2).
   - Provide project base package (e.g., `com/example`) for targeted frame extraction — this is essential for efficient grep extraction
   - **REMIND the reviewer**: it MUST write `$SESSION_DIR/hotspot-inventory.md` — this file is read by the Tech Lead in Phase 6/7 for cross-reviewer evidence sharing

9. **Spawn ephemeral reviewers** (if `--reviewer` was provided):
   - Synthesize a focused reviewer persona from the description
   - Output to `ephemeral-{n}.md`

### Phase 4 Post-Spawn Filename Verification (MANDATORY, cross-platform)

Reviewer output files are written by **subagents**, which are the most prone to naming drift (e.g. `principal_1.md`, `review-principal-1.md`, `principal.md`). After all reviewers have returned, verify every file in `reviews/` matches the canonical `{type}-{n}.md` pattern and rename any misnamed file before updating PROGRESS.md.

**Bash (Linux / macOS / Git Bash):**
```bash
REVIEWS_DIR="$SESSION_DIR/rounds/round-$CURRENT_ROUND/reviews"
for FILE in "$REVIEWS_DIR"/*.md; do
  [ -f "$FILE" ] || continue
  BASE=$(basename "$FILE")
  # Strip .md, normalize (lowercase + strip review- prefix/-review suffix + _ -> -), then re-check
  STEM="${BASE%.md}"
  NEW_STEM=$(echo "$STEM" | tr 'A-Z' 'a-z' | sed -E 's/^review-//; s/-review$//; s/_/-/g')
  NEW="${NEW_STEM}.md"
  # Skip only if nothing changed AND it is already canonical
  if [ "$NEW" = "$BASE" ] && echo "$BASE" | grep -qE '^[a-z][a-z0-9-]*-[0-9]+\.md$'; then
    continue
  fi
  if echo "$NEW" | grep -qE '^[a-z][a-z0-9-]*-[0-9]+\.md$'; then
    echo "Reviewer file normalization: $BASE -> $NEW"
    mv "$FILE" "$REVIEWS_DIR/$NEW"
  else
    echo "WARNING: unrecognizable reviewer filename '$BASE' — cannot auto-rename; re-spawn this reviewer"
  fi
done
```

**PowerShell (Windows):**
```powershell
$ReviewsDir = "$SESSION_DIR\rounds\round-$CURRENT_ROUND\reviews"
if (Test-Path $ReviewsDir) {
  Get-ChildItem -Path $ReviewsDir -File -Filter "*.md" | ForEach-Object {
    $Base = $_.Name
    # Strip .md, normalize (lowercase + strip review- prefix/-review suffix + _ -> -), then re-check
    $Stem = [System.IO.Path]::GetFileNameWithoutExtension($Base)
    $NewStem = $Stem.ToLower() -replace '^review-', '' -replace '-review$', '' -replace '_', '-'
    $New = "$NewStem.md"
    # Skip only if nothing changed AND it is already canonical (case-SENSITIVE: type must be lowercase)
    if ($New -ceq $Base -and $Base -cmatch '^[a-z][a-z0-9-]*-[0-9]+\.md$') { return }
    if ($New -cmatch '^[a-z][a-z0-9-]*-[0-9]+\.md$') {
      Write-Output "Reviewer file normalization: $Base -> $New"
      Rename-Item -Path $_.FullName -NewName $New -Force
    } else {
      Write-Output "WARNING: unrecognizable reviewer filename '$Base' — cannot auto-rename; re-spawn this reviewer"
    }
  }
}
```

**Rules:**
- The ONLY valid pattern is `{type}-{n}.md` (lowercase type, hyphen separator, integer instance). Underscores, `review-` prefixes, `-review` suffixes are all invalid.
- If a file can be confidently mapped (underscore→hyphen, strip prefix/suffix), rename it — preserve content.
- If a file cannot be confidently mapped, do NOT guess. Re-spawn that reviewer and have it write to the correct path.
- After normalization, the `reviews/` directory should contain ONLY files matching `{type}-{n}.md`.

### Phase 4 Checkpoint — MANDATORY VALIDATION

**Verify before proceeding (self-check, do NOT ask the user):**
- [ ] **Post-Spawn Filename Verification PASSED** — every file in `reviews/` matches `{type}-{n}.md` (run the cross-platform verification above; any misnamed file has been renamed or the reviewer re-spawned)
- [ ] Review files exist for EACH entry in the team config
- [ ] All files use `{type}-{n}.md` pattern
- [ ] Each review file contains findings
- [ ] Each review file begins with `## Summary` section in Chinese
- [ ] All review content is in Chinese (code/file paths remain in original form)
- [ ] **Every finding has a complete file path with line numbers** — no findings with missing/empty location
- [ ] **No change descriptions or factual summaries** — every finding points to an actionable problem
- [ ] If any custom reviewer with a "Cross-Review Awareness" section in its persona body is in the team: its findings will be cross-reviewed in Phase 6 discourse
- [ ] If graph available: navigation tips injected into reviewer context (500-800 token budget)
- [ ] If graph available: graph exploration guide injected into reviewer context
- [ ] If graph available and a Java code-smell reviewer is in team: call chain navigation provided
- [ ] If profiling-diagnostic mode active: Wave 1 (profiling-analysis reviewer) completed and `hotspot-inventory.md` exists; Wave 2 reviewers spawned with hotspot scope injected (or degradation noted if `hotspot-inventory.md` missing)
- [ ] **PROGRESS.md updated**: Phase 4 status set to `DONE`, all reviewer filenames recorded in Output Files column

---

## Phase 5: Aggregate Findings

**Goal**: Merge redundant reviewer runs and mark confidence. **All output MUST be in Chinese (中文)**.

### Resume Check (if interrupted)

Phase 5 is a pure computation step with no persisted output file (findings are held in context for Phase 6/7). If interrupted during Phase 5, simply re-execute it — read all reviewer files from disk and re-aggregate. No partial state to recover.

### Steps

1. For reviewers with redundancy > 1, compare findings:
   - **Confirmed**: Found in all runs → Very High Confidence
   - **Partial**: Found in some runs → Medium Confidence
   - **Single**: Found in one run → Lower Confidence

2. Deduplicate identical findings.

3. Create aggregated findings per reviewer type.

### Phase 5 Checkpoint

**STOP and verify before proceeding (self-check, do NOT ask the user):**
- [ ] Redundant reviewer runs compared and confidence levels assigned
- [ ] Identical findings deduplicated
- [ ] **PROGRESS.md updated**: Phase 5 status set to `DONE`

---

## Phase 5.5: Focused Verification (Noise Reduction)

**Goal**: For high false-positive-risk findings (those that require complete call-chain context to judge correctly), dispatch focused verification subagents to do a deep, single-finding recheck —剔除误报，使后续 discourse 和 synthesis 基于已去噪的发现。**All output MUST be in Chinese (中文)**.

> **Why this phase exists**: Reviewers in Phase 4 receive diff fragments + navigation tips, but for problem types like deadlock/ABA/race-condition/security-injection, judging correctness requires the *complete* call chain (who calls it, lock ordering, concurrency model, input flow path). A reviewer working in parallel across many findings often concludes from the diff fragment alone, producing false positives. A verification subagent that focuses its *entire context* on a single finding and retrieves the full call chain can correctly identify false alarms (e.g., "the ABA deadlock is not real because the lock is always released before re-acquire").

> **Skip this phase** when ANY of:
> - `--quick` flag is used
> - `verification.enabled: false` in `.ultra-cr.yaml`
> - No high false-positive-risk findings are identified after screening (empty operation)
>
> These skips do NOT violate the IRON LAW "Never skip phases" — Phase 5.5 is a noise-reduction sub-step between Phase 5 and 6; it may be legitimately empty when there is nothing to verify.
>
> **Skip MUST still persist a skip-marker `verification-summary.md`** (see Step 1 "Skip-marker summary format"). Regardless of which skip condition triggered, write the skip-marker file with the reason filled in (`SKIPPED: --quick` / `SKIPPED: verification.enabled=false` / `SKIPPED: 无高风险发现`), set PROGRESS.md Phase 5.5 to `DONE`, then proceed to Phase 6. This guarantees the disk has a DONE凭证 so Phase 0 resume/rebuild never mistakes a legitimate skip for "never ran".

### Resume Check (if interrupted)

Check if verification outputs already exist:
**Bash (Linux / macOS / Git Bash):**
```bash
test -f "$SESSION_DIR/rounds/round-$CURRENT_ROUND/verifications/verification-summary.md" && echo "EXISTS" || echo "MISSING"
```
**PowerShell (Windows):**
```powershell
if (Test-Path "$SESSION_DIR/rounds/round-$CURRENT_ROUND/verifications/verification-summary.md") { Write-Output "EXISTS" } else { Write-Output "MISSING" }
```

If `verification-summary.md` exists and contains CONFIRM/FALSE-ALARM/REFINE/CONFIRM (unverified)/UNVERIFIED (exceeded max_findings cap) verdicts → Phase 5.5 is complete, proceed to Phase 6.

If `verification-summary.md` exists and contains a `SKIPPED:` skip-marker line → Phase 5.5 was legitimately skipped and is complete, proceed to Phase 6. Do NOT re-execute (a skip is a valid DONE state).

If `verification-summary.md` is missing → re-execute Phase 5.5. Re-screen aggregated findings from Phase 5, re-dispatch verification subagents only for findings whose per-finding verify file is missing.

> **Resume with partial verify files**: If `verification-summary.md` exists but some screened findings have no verify file AND no `CONFIRM (unverified)` row (i.e. interrupted mid-verification), do NOT discard them. Re-dispatch the missing verifications ONCE; if still missing, mark them `CONFIRM (unverified)` per the Step 2 degradation rule and update the summary, then proceed. Never leave a screened finding without a verdict row.

### Step 0: Early Skip Check (`--quick` / `verification.enabled: false`)

Before screening, check whether Phase 5.5 is disabled entirely (as opposed to "screening found nothing", which is handled at the end of Step 1):

- If `--quick` flag is set OR `verification.enabled: false` in `.ultra-cr.yaml` → Phase 5.5 is skipped before any screening. You MUST still write a skip-marker `verification-summary.md` (use the Step 1 "Skip-marker summary format", fill the `SKIPPED:` reason as `--quick` or `verification.enabled=false`), set PROGRESS.md Phase 5.5 to `DONE` with the skip note, then proceed directly to Phase 6. Do NOT run screening, do NOT dispatch any verification subagent.
- Otherwise → proceed to Step 1 (screening). Note: Step 1 may itself decide to skip (empty screening result), in which case it writes its own skip-marker file with reason `无高风险发现`.

### Step 1: Screen High False-Positive-Risk Findings

After Phase 5 aggregation, the Tech Lead scans every aggregated finding and selects those matching high false-positive-risk **problem types** (NOT severity levels — severity and false-positive probability are unrelated). Selection is by **keyword match against the Chinese keyword list below** (findings are written in Chinese per the IRON LAW, so match against the Chinese keywords, not the English type names), automatic, no user interaction. A finding is selected if ANY of its keywords appears in the finding's description/location.

> **Profiling findings EXEMPTION (CRITICAL)**: Findings whose source reviewer ID is `profiling-analysis` are **directly exempted** from Phase 5.5 verification — they do NOT enter the screening set, regardless of whether their description matches any keyword below. Rationale: profiling findings are backed by runtime measured evidence (flame graph samples, GC events, allocation bytes), NOT code-speculation. Phase 5.5 verification subagents only read code (not profiling files), so they could incorrectly overturn a measured hot-path finding via code reasoning — this directly violates the profiling-analysis reviewer's "Lead with profiling evidence" principle. These exempted findings pass through to Phase 6 unchanged. Record the exempted count in `verification-summary.md`: if Phase 5.5 is skipped (skip-marker), append a line `已豁免: N 条 profiling 发现已豁免去噪（实测证据不参与代码推测式验证）`; if Phase 5.5 executes, add an "已豁免的 profiling 发现" note in the summary noting the exempted count and that they entered Phase 6 as-is.

| High false-positive-risk type | Chinese keywords (match these) | Why it needs full context |
|-------------------------------|-------------------------------|--------------------------|
| Concurrency / deadlock / ABA / race | 死锁, ABA, 竞态, 竞争, 锁顺序, 双检锁, 可见性, happens-before, 内存可见, volatile, synchronized, ReentrantLock, Concurrent, 原子性, CAS | Needs complete call chain + lock ordering + concurrency model |
| Security injection | 注入, SQL注入, XSS, 命令注入, 拼接, 反序列化, 转义, 过滤, 参数化, sanitize | Needs to confirm input flow path + existing sanitization |
| Cross-module impact / data flow | 跨模块, 下游, 调用链, 数据流, 影响范围, 破坏, 依赖, 耦合, 签名变更 | Needs cross-layer call chain tracing |
| Resource leak / lifecycle | 泄漏, 泄露, 未关闭, 未释放, 连接泄漏, 资源, 生命周期, try-with, finally, close | Needs acquire/release path |
| Timing / state machine | 状态机, 状态转换, 时序, 竞态, 重入, 幂等, 乱序 | Needs complete state transitions |

Common trait: **cannot be judged from the diff fragment alone — must read the complete call chain/context.**

> **Override via config**: `.ultra-cr.yaml` `verification.risk_types:` may override the default type list (use the English type identifiers: `concurrency`, `security-injection`, `cross-module-impact`, `resource-leak`, `state-machine`).

Record the screening result (which findings were selected, by which type, with the source reviewer ID + location) for the verification-summary.md "验证范围" section. This screening record IS the authoritative finding→verify mapping (see Step 3). **Also record the exempted profiling findings count** (from the `profiling-analysis` reviewer) in the same section — these are deliberately NOT in the verify mapping, noted as "已豁免（profiling 实测证据）" for traceability.

> **Cap the verification set**: If `verification.max_findings` is set in config and the screening result exceeds it, keep the **lowest-confidence** findings first (lowest-confidence findings are the most likely false positives — they benefit most from verification) up to the cap. The rest are recorded in verification-summary.md with verdict `UNVERIFIED (exceeded max_findings cap)` and enter Phase 6 as-is (not discarded, not marked "✅ 已验证"). If `max_findings` is unset, no cap.

If the screening result is empty → Phase 5.5 is a legitimate empty operation, but you MUST still persist a **skip-marker summary file** so the disk has a DONE凭证 (otherwise Phase 0 resume/rebuild cannot distinguish "legitimately skipped" from "never ran"). Write `rounds/round-{current_round}/verifications/verification-summary.md` with the skip format below (fill the `SKIPPED:` reason as `无高风险发现`), then proceed to Phase 6. Update PROGRESS.md Phase 5.5 to `DONE` with note "无高风险发现，跳过". (The same skip-marker file is also written for the `--quick` / `verification.enabled: false` skip paths — see the skip rule above.)

**Skip-marker summary format** (the `## 跳过标记` section with the literal token `SKIPPED` is the authoritative skip signal read by Phase 0/6/7):
```markdown
# 聚焦验证汇总

## 跳过标记
SKIPPED: 无高风险发现，Phase 5.5 空操作跳过。所有发现原样进入 Phase 6，无剔除/修正/已验证标注。

## 验证范围
本轮未筛选出高误判风险发现，未派发验证 subagent。
<!-- If profiling-analysis reviewer is in the team: append a line here, e.g. "已豁免: N 条 profiling 发现已豁免去噪（实测证据不参与代码推测式验证）" -->

## 剔除清单（FALSE-ALARM，不进入 Phase 6/7）
（无）

## 修正清单（REFINE，用修正描述进入 Phase 6）
（无）

## 确认清单（CONFIRM / CONFIRM (unverified)，原样进入 Phase 6）
（无）
```

> **Why persist a skip-marker file**: Phase 5.5 is the ONLY phase whose "skipped" state leaves no natural output. Every other phase leaves a file when DONE. Without a persisted marker, Phase 0 Step 3a (rebuild PROGRESS.md from disk) and Step 4 (cross-check DONE vs disk) would misread a legitimately-skipped 5.5 as `NOT_STARTED` and re-execute it — violating "completed reviews must not re-execute". The skip-marker file restores disk-state parity with all other phases.

### Step 2: Dispatch Verification Subagents

For each selected finding, dispatch a verification subagent. Verification subagents run in parallel. Each subagent receives the **minimal, cleanest possible context**:

**Input (per subagent — single finding only):**
- The single finding's description (original reviewer ID, severity, location `path:line-line`, original description)
- **Nothing else**: no other findings, no full diff, no Tech Lead opinions
- The subagent's task: retrieve the complete call chain / context itself, then judge independently

**Verification subagent prompt core requirements:**
1. MUST read the **complete context** of the file the finding points to (not just the diff fragment)
2. MUST trace the call chain:
   - If graph available: use `query_graph_tool(pattern="callers_of"/"callees_of")` to trace upstream/downstream
   - If graph unavailable: use grep/read to trace callers and callees
3. MUST give one of three verdicts + **evidence** (which files read, what the call chain is, why it holds / does not hold)
4. MUST NOT conclude from inference alone — code evidence required
5. **MUST write the verify file's first line as a target anchor**: `> 验证目标: {reviewer-id} 第{k}条 finding @ {path:line-line} — {一句话摘要}`. This anchor is the authoritative link back to the source finding and MUST match the screening record in Step 1.

**Output: one of three verdicts**

| Verdict | Meaning | Downstream handling |
|---------|---------|---------------------|
| `CONFIRM` | Confirmed as a real problem, with evidence | Finding enters Phase 6 as-is |
| `FALSE-ALARM` | Judged as false positive, with evidence | **Directly removed — does NOT enter Phase 6/7** (full record kept in verification-summary.md for traceability) |
| `REFINE` | Problem exists but description needs correction | Replace original description with corrected one, enter Phase 6 |

**Failure / degraded-result handling (MANDATORY after subagents return):**
- **Recovery reconciliation**: After all verification subagents return, count the per-finding verify files actually written. If fewer files were written than findings dispatched (a subagent crashed / timed out / produced no file) → re-dispatch the missing verifications ONCE. If still missing after the retry, apply the degradation rule below.
- **Degradation rule — default to CONFIRM, never silently drop**: A finding whose verification produced no usable verdict (missing file, or file lacks a clear CONFIRM/FALSE-ALARM/REFINE) MUST be treated as **CONFIRM (unverified)** and enters Phase 6 as-is — it is NOT discarded. Rationale: the whole point of Phase 5.5 is to remove FALSE-ALARMs with evidence; without a verdict there is no evidence to remove, so the conservative choice is to keep the finding. Record such findings in verification-summary.md with verdict `CONFIRM (unverified — verification failed)`.
- This degradation MUST NOT be used to skip verification of a finding that actually returned a FALSE-ALARM — only for findings where no verdict was produced at all.

### Step 3: Write Verification Outputs

Output directory: `rounds/round-{current_round}/verifications/`

- **Per-finding verification files**: `{type}-{n}-verify.md` (corresponds to the source reviewer file + `-verify`)
  - If the same reviewer has multiple findings to verify: `{type}-{n}-verify-{k}.md` (k increments from 1, matching the `第{k}条` index in the verify file's target anchor)
  - Example: `principal-1-verify.md`, `security-1-verify-1.md`, `security-1-verify-2.md`
- **Summary file**: `verification-summary.md` (fixed name — read by Phase 6 and Phase 7)

**Who writes what:**
- **Per-finding verify files** are written by each verification subagent (it owns its single finding's full call-chain analysis).
- **`verification-summary.md` is written by the Tech Lead.** The Tech Lead reads ONLY each verify file's **target anchor (first line) + verdict + evidence summary (the conclusion section)** — NOT the full call-chain narrative — to fill the summary table. This keeps the Tech Lead's context clean (the long call-chain traces stay on disk in the per-finding files) while ensuring the summary faithfully reflects each verify file's actual verdict. The Tech Lead MUST copy the verdict verbatim from the verify file; it MUST NOT re-interpret or override a subagent's verdict.

**verification-summary.md format** (MUST be in Chinese, only code/paths/identifiers in original form). The table is the authoritative finding↔verify mapping — `位置` + `发现摘要` together must uniquely identify each source finding:

```markdown
# 聚焦验证汇总

## 验证范围
本轮共筛选出 N 条高误判风险发现，派发 M 个验证 subagent。

| # | 原发现来源 | 位置 | 发现摘要 | 问题类型 | 验证结论 | 验证文件 |
|---|-----------|------|---------|---------|---------|---------|
| 1 | principal-1 | AuthService.java:42-58 | ABA 死锁（锁重入顺序） | 并发/死锁 | FALSE-ALARM | principal-1-verify.md |
| 2 | security-1 | UserRepo.java:30-35 | SQL 拼接注入风险 | 安全注入 | CONFIRM | security-1-verify.md |
| 3 | architect-1 | OrderFlow.java:100-120 | 变更破坏下游 X 模块 | 跨模块影响 | REFINE | architect-1-verify-1.md |
| 4 | principal-1 | AuthService.java:70-72 | 竞态条件（可见性） | 并发/死锁 | CONFIRM (unverified — verification failed) | (missing) |
| 5 | quality-1 | Cache.java:88-95 | 连接泄漏 | 资源泄漏 | UNVERIFIED (exceeded max_findings cap) | (not dispatched) |

## 剔除清单（FALSE-ALARM，不进入 Phase 6/7）
- principal-1 "ABA 死锁" (AuthService.java:42-58)
  - 验证依据: [验证 agent 读取的调用链 + 为什么不成立]

## 修正清单（REFINE，用修正描述进入 Phase 6）
- architect-1 "变更破坏下游 X 模块" → 修正为 "下游 X 模块的 Y 方法需同步更新签名"

## 确认清单（CONFIRM / CONFIRM (unverified)，原样进入 Phase 6）
- security-1 "SQL 注入风险" (UserRepo.java:30-35)
- principal-1 "竞态条件" (AuthService.java:70-72) — ⚠️ 验证失败，按保守策略保留
```

> **Completeness rule**: Every finding listed in the Step 1 screening record MUST appear as exactly one row in the summary table (with a verdict). If a screened finding has no row, the summary is INCOMPLETE — resolve it via the degradation rule (CONFIRM unverified) before proceeding.

### Post-Write Filename Verification (MANDATORY, cross-platform)

**Immediately after writing verification outputs, verify every file in `verifications/` matches the canonical pattern.** Verification files are written by subagents and prone to naming drift.

**Bash (Linux / macOS / Git Bash):**
```bash
VERIFICATIONS_DIR="$SESSION_DIR/rounds/round-$CURRENT_ROUND/verifications"
if [ -d "$VERIFICATIONS_DIR" ]; then
  # summary normalization
  if [ ! -f "$VERIFICATIONS_DIR/verification-summary.md" ]; then
    MISNAMED=$(ls -1 "$VERIFICATIONS_DIR" 2>/dev/null | grep -iE '^(verification\.md|verify-summary\.md|verify\.md)$' || true)
    if [ -n "$MISNAMED" ]; then
      echo "Verification file normalization: $MISNAMED -> verification-summary.md"
      mv "$VERIFICATIONS_DIR/$MISNAMED" "$VERIFICATIONS_DIR/verification-summary.md"
    fi
  fi
  # per-finding file normalization
  for FILE in "$VERIFICATIONS_DIR"/*.md; do
    [ -f "$FILE" ] || continue
    BASE=$(basename "$FILE")
    [ "$BASE" = "verification-summary.md" ] && continue
    # Already canonical? {type}-{n}-verify.md or {type}-{n}-verify-{k}.md
    if echo "$BASE" | grep -qE '^[a-z][a-z0-9-]*-[0-9]+-verify(-[0-9]+)?\.md$'; then
      continue
    fi
    # Normalize: lowercase, _ -> -, strip a leading "verify-" prefix, ensure -verify suffix present.
    # e.g. verify-principal-1 -> principal-1 -> principal-1-verify ; principal_1 -> principal-1-verify
    STEM="${BASE%.md}"
    STEM=$(echo "$STEM" | tr 'A-Z' 'a-z' | sed -E 's/_/-/g; s/^verify-//')
    # Ensure -verify suffix present (canonical requires it; do not double-append)
    if ! echo "$STEM" | grep -qE -- '-verify(-[0-9]+)?$'; then
      STEM="${STEM}-verify"
    fi
    NEW="${STEM}.md"
    if [ "$NEW" = "$BASE" ]; then
      continue
    fi
    if echo "$NEW" | grep -qE '^[a-z][a-z0-9-]*-[0-9]+-verify(-[0-9]+)?\.md$'; then
      echo "Verification file normalization: $BASE -> $NEW"
      mv "$FILE" "$VERIFICATIONS_DIR/$NEW"
    else
      echo "WARNING: unrecognizable verification filename '$BASE' — cannot auto-rename; re-run verification"
    fi
  done
fi
```

**PowerShell (Windows):**
```powershell
$VerificationsDir = "$SESSION_DIR\rounds\round-$CURRENT_ROUND\verifications"
if (Test-Path $VerificationsDir) {
  # summary normalization
  $SummaryPath = Join-Path $VerificationsDir "verification-summary.md"
  if (-not (Test-Path $SummaryPath)) {
    $Misnamed = Get-ChildItem -Path $VerificationsDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(?i)(verification\.md|verify-summary\.md|verify\.md)$' } |
      Select-Object -First 1
    if ($Misnamed) {
      Write-Output "Verification file normalization: $($Misnamed.Name) -> verification-summary.md"
      Rename-Item -Path $Misnamed.FullName -NewName "verification-summary.md" -Force
    }
  }
  # per-finding file normalization
  Get-ChildItem -Path $VerificationsDir -File -Filter "*.md" -ErrorAction SilentlyContinue | ForEach-Object {
    $Base = $_.Name
    if ($Base -ceq "verification-summary.md") { return }
    # Already canonical? (case-SENSITIVE)
    if ($Base -cmatch '^[a-z][a-z0-9-]*-[0-9]+-verify(-[0-9]+)?\.md$') { return }
    # Normalize: lowercase, _ -> -, strip a leading "verify-" prefix, ensure -verify suffix present.
    # e.g. verify-principal-1 -> principal-1 -> principal-1-verify ; principal_1 -> principal-1-verify
    $Stem = [System.IO.Path]::GetFileNameWithoutExtension($Base)
    $Stem = $Stem.ToLower() -replace '_', '-' -replace '^verify-', ''
    # Ensure -verify suffix present (canonical requires it; do not double-append)
    if ($Stem -notmatch '-verify(-[0-9]+)?$') {
      $Stem = "$Stem-verify"
    }
    $New = "$Stem.md"
    if ($New -ceq $Base) { return }
    if ($New -cmatch '^[a-z][a-z0-9-]*-[0-9]+-verify(-[0-9]+)?\.md$') {
      Write-Output "Verification file normalization: $Base -> $New"
      Rename-Item -Path $_.FullName -NewName $New -Force
    } else {
      Write-Output "WARNING: unrecognizable verification filename '$Base' — cannot auto-rename; re-run verification"
    }
  }
}
```

**Rules:**
- Per-finding files MUST match `{type}-{n}-verify.md` or `{type}-{n}-verify-{k}.md` (lowercase type, hyphen separator). Underscores, `verify-` prefixes are invalid.
- The summary file MUST be named `verification-summary.md`. `verification.md`, `verify-summary.md`, `verify.md` are invalid.
- If a file can be confidently mapped, rename it (preserve content). If not, re-run that verification.

### Phase 5.5 Checkpoint

**STOP and verify before proceeding (self-check, do NOT ask the user):**

**If Phase 5.5 was skipped** (a skip-marker `verification-summary.md` with a `SKIPPED:` line was written):
- [ ] `verification-summary.md` exists and contains a `SKIPPED:` line with the skip reason (`--quick` / `verification.enabled=false` / `无高风险发现`)
- [ ] **PROGRESS.md updated**: Phase 5.5 status set to `DONE` with the skip note, verification-summary.md recorded in Output Files
- [ ] (No per-finding verify files expected — skip directly to Phase 6)

**If Phase 5.5 was actually executed** (verification subagents were dispatched):
- [ ] **Post-Write Filename Verification PASSED** — every file in `verifications/` matches `{type}-{n}-verify(-k)?.md` or is `verification-summary.md` (run the cross-platform verification above)
- [ ] `verification-summary.md` exists and contains at least one valid verdict among CONFIRM / FALSE-ALARM / REFINE / CONFIRM (unverified) / UNVERIFIED (exceeded max_findings cap)
- [ ] **Verdict completeness PASSED** — every finding in the Step 1 screening record has exactly one row in the summary table with a valid verdict; any finding whose verification failed is recorded as `CONFIRM (unverified)` (NOT missing, NOT silently dropped)
- [ ] **Recovery reconciliation PASSED** — number of per-finding verify files written (or marked `CONFIRM (unverified)` after retry) equals the number of findings dispatched. (Note: `UNVERIFIED (exceeded max_findings cap)` findings were NOT dispatched — they have a summary row but no verify file, and are excluded from this count.)
- [ ] Every FALSE-ALARM finding has evidence recorded
- [ ] Every per-finding verify file's first line is the target anchor (`> 验证目标: ...`) matching its summary-table row
- [ ] All verification content is in Chinese (code/file paths remain in original form)
- [ ] **PROGRESS.md updated**: Phase 5.5 status set to `DONE`, verification-summary.md recorded in Output Files

---

## Phase 6: Discourse

**Goal**: Let reviewers challenge and build on each other's findings. **All discourse output MUST be in Chinese (中文)**.

> Skip this phase **only** if `--quick` flag is used or `discourse.enabled: false` in config. A skip must write `rounds/round-{current_round}/discourse.md` with a `SKIPPED:` line stating the reason, record the file in PROGRESS.md and mark Phase 6 DONE. No reviewer responses are expected for a valid skip marker.
> ⚠️ **graph 增强不构成跳过 discourse 的理由**。图谱导航提示是 Tech Lead 的输入，但 reviewer 之间的交叉挑战（AGREE/CHALLENGE/CONNECT/SURFACE）仍是发现单 reviewer 视角盲区的关键环节，不可省略。graph 可用时 discourse 应基于图谱发现的 hub 节点/跨层边界等结构级风险展开更深入的讨论，而非取消。

> **Phase 5.5 衔接**: 如果 Phase 5.5 已执行，discourse 的输入是**已去噪的发现集**——读取 `rounds/round-{current_round}/verifications/verification-summary.md`，剔除"剔除清单"中的 FALSE-ALARM 发现，应用"修正清单"中的 REFINE 修正描述，将以下发现呈现给 reviewer 讨论：(a) CONFIRM 发现、(b) `CONFIRM (unverified)` 发现（验证失败按保守策略保留）、(c) `UNVERIFIED (exceeded max_findings cap)` 发现（超限未验证）。后两类发现 discourse 中标注"未经验证"。discourse prompt 中注明"以下发现已经过 Phase 5.5 聚焦验证，标注了验证结论"。如果 Phase 5.5 被跳过（`verification-summary.md` 含 `SKIPPED:` 标记，剔除/修正/确认清单均为空，无发现需去噪），discourse 输入与原流程一致。

### Resume Check (if interrupted)

Check if discourse.md already exists:
**Bash (Linux / macOS / Git Bash):**
```bash
test -f "$SESSION_DIR/rounds/round-$CURRENT_ROUND/discourse.md" && echo "EXISTS" || echo "MISSING"
```
**PowerShell (Windows):**
```powershell
if (Test-Path "$SESSION_DIR/rounds/round-$CURRENT_ROUND/discourse.md") { Write-Output "EXISTS" } else { Write-Output "MISSING" }
```

If discourse.md exists and contains AGREE/CHALLENGE/CONNECT/SURFACE responses OR a valid `SKIPPED:` marker matching the recorded quick/discourse setting → Phase 6 is complete, proceed to Phase 7.

If discourse.md is missing or incomplete and has no valid skip marker → re-execute Phase 6. For quick/disabled discourse, recreate only the skip marker; otherwise read reviewer files and aggregated findings to reconstruct the discourse context.

### Steps

1. Present all aggregated findings to each reviewer. Include mandatory cross-review rules from `references/discourse.md` in the discourse prompt:
   - **Custom Reviewer Cross-Review**: For any custom reviewer in the team whose persona body contains a "Cross-Review Awareness" section, the routed domain reviewers MUST respond to its findings (see discourse.md for rules). The routing is read from each reviewer's persona body.
   - **Profiling Analysis Cross-Review**: When in team, specific domain reviewers MUST respond to its findings (see discourse.md for rules)
   - **Profiling hotspot-inventory injection**: When profiling-analysis is in the team, the Tech Lead MUST read `$SESSION_DIR/hotspot-inventory.md` (produced by the profiling-analysis reviewer in Phase 4, see `references/reviewers/specialist/profiling-analysis.md` Step 1) and inject its Hot Stack Inventory table into the discourse prompt. This gives domain reviewers visibility into the measured hot paths so they can AGREE/CHALLENGE profiling findings with full evidence context — without it, profiling evidence stays siloed in the profiling-analysis reviewer's own output. If the file is missing (e.g., the reviewer failed to produce it), note the absence in the discourse prompt and proceed with the reviewer's finding-format output alone.
   - **Profiling-diagnostic mode discourse axis (when active)**: When profiling-diagnostic mode is active, the discourse prompt MUST instruct all reviewers to organize their AGREE/CHALLENGE responses **around the hot methods in `hotspot-inventory.md`** (e.g., "围绕热点方法 `AsgRepositoryImpl.readAllAsg` 及其调用链，各评审员从自身视角发表 AGREE/CHALLENGE"), rather than around diff findings. The hot method list is the discourse axis; the diff (if any) is supplementary context.

2. Each reviewer responds using these types:
   - **AGREE**: "I concur with Security's SQL injection finding..."
   - **CHALLENGE**: "I disagree because the ORM sanitizes..."
   - **CONNECT**: "This relates to my maintainability concern..."
   - **SURFACE**: "Based on this discussion, I notice..."

3. Save discourse to `rounds/round-{current_round}/discourse.md`.

See `references/discourse.md` for detailed instructions.

### Post-Write Filename Verification (MANDATORY, cross-platform)

**Immediately after saving the discourse output, verify the file landed on disk with the EXACT name `discourse.md`.** If it was written as `discussion.md`, `discourse-log.md`, `debate.md`, or `cross-review.md`, rename it to `discourse.md` before updating PROGRESS.md.

**Bash (Linux / macOS / Git Bash):**
```bash
DISCOURSE="$SESSION_DIR/rounds/round-$CURRENT_ROUND/discourse.md"
if [ -f "$DISCOURSE" ]; then
  echo "OK: discourse.md exists"
else
  echo "FATAL: discourse.md missing — scanning for misnamed discourse files..."
  ROUND_DIR="$SESSION_DIR/rounds/round-$CURRENT_ROUND"
  MISNAMED=$(ls -1 "$ROUND_DIR" 2>/dev/null | grep -iE '^(discussion|discourse[-_]log|debate|cross-review)\.md$' || true)
  if [ -n "$MISNAMED" ]; then
    echo "Found misnamed file: $MISNAMED — renaming to discourse.md"
    mv "$ROUND_DIR/$MISNAMED" "$DISCOURSE"
    echo "OK: renamed -> discourse.md"
  else
    echo "FATAL: no candidate file found. Re-execute Phase 6 and write to $DISCOURSE immediately."
  fi
fi
```

**PowerShell (Windows):**
```powershell
$Discourse = "$SESSION_DIR\rounds\round-$CURRENT_ROUND\discourse.md"
if (Test-Path $Discourse) {
  Write-Output "OK: discourse.md exists"
} else {
  Write-Output "FATAL: discourse.md missing — scanning for misnamed discourse files..."
  $RoundDir = "$SESSION_DIR\rounds\round-$CURRENT_ROUND"
  $Misnamed = Get-ChildItem -Path $RoundDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(?i)(discussion|discourse[-_]log|debate|cross-review)\.md$' } |
    Select-Object -First 1
  if ($Misnamed) {
    Write-Output "Found misnamed file: $($Misnamed.Name) — renaming to discourse.md"
    Rename-Item -Path $Misnamed.FullName -NewName "discourse.md" -Force
    Write-Output "OK: renamed -> discourse.md"
  } else {
    Write-Output "FATAL: no candidate file found. Re-execute Phase 6 and write to $Discourse immediately."
  }
}
```

**Rules:**
- The ONLY valid filename is `discourse.md`. `discussion.md`, `discourse-log.md`, `discourse_log.md`, `debate.md`, `cross-review.md` are ALL invalid.
- If a misnamed file is found, rename it to `discourse.md` (preserve content, do NOT delete and rewrite).
- If no candidate exists, re-execute Phase 6 and write directly to `discourse.md`. Do NOT proceed to Phase 7 until `discourse.md` exists.

### Phase 6 Checkpoint

**STOP and verify before proceeding (self-check, do NOT ask the user):**
- [ ] **Post-Write Filename Verification PASSED** — `discourse.md` exists on disk with the EXACT name (run the cross-platform verification above; any misnamed file has been renamed to `discourse.md`)
- [ ] `rounds/round-{n}/discourse.md` written to round directory
- [ ] Contains AGREE/CHALLENGE/CONNECT/SURFACE responses, OR a valid `SKIPPED:` marker for the recorded quick/discourse setting
- [ ] All discourse content is in Chinese (code/file paths remain in original form)
- [ ] If skipped, the marker exists and its reason matches `--quick` or `discourse.enabled: false`; proceed to synthesis without dispatching discourse reviewers
- [ ] **PROGRESS.md updated**: Phase 6 status set to `DONE`

---

## Phase 7: Synthesis

**Goal**: Produce final prioritized review **in Chinese (中文)**.

> **IRON LAW**: The final.md file MUST be produced. No exceptions. If context compression has occurred, use the Recovery Protocol below.
>
> **OUTPUT FILE NAME: `final.md`** — The output file MUST be named `final.md`. Do NOT name it `SYNTHESIS.md`, `synthesis.md`, or anything else. The only valid path is `rounds/round-{n}/final.md`.

### Resume Check (if interrupted)

Check if final.md already exists:
**Bash (Linux / macOS / Git Bash):**
```bash
test -f "$SESSION_DIR/rounds/round-$CURRENT_ROUND/final.md" && echo "EXISTS" || echo "MISSING"
```
**PowerShell (Windows):**
```powershell
if (Test-Path "$SESSION_DIR/rounds/round-$CURRENT_ROUND/final.md") { Write-Output "EXISTS" } else { Write-Output "MISSING" }
```

If final.md exists and contains categorized findings (🚫, 🔶, 💡) → Phase 7 is complete, proceed to Phase 8.

If final.md is missing → re-execute Phase 7 from scratch. Use the summary-first approach to reconstruct findings from reviewer output files on disk.

If final.md exists but appears incomplete (e.g., missing categories, no findings) → overwrite it by re-executing synthesis.

### Steps

1. Aggregate all findings from Phase 5 and Phase 6. **If profiling-analysis was in the team**, read `$SESSION_DIR/hotspot-inventory.md` (produced in Phase 4, surfaced in Phase 6 discourse) to weight profiling-backed findings with their measured evidence — these findings carry runtime evidence and should not be discounted relative to code-only speculation. **If profiling-diagnostic mode is active**, organize `final.md` findings **by hot method** (each hot method from `hotspot-inventory.md` gets a section aggregating all reviewers' findings about it + its call chain), rather than by diff file/module — the hot method list is the categorization axis in diagnostic mode.

2. **FILTER out invalid findings** (MANDATORY before categorization):
   - Remove any finding that lacks a complete file path with line numbers — these are INVALID
   - Remove any finding that is a change description, refactoring summary, or factual statement — these are PROHIBITED
   - Only findings that point to specific actionable problems (bugs, risks, defects, improvement points) may proceed

3. **Apply Phase 5.5 verification results** (if Phase 5.5 was actually executed, i.e. `verification-summary.md` exists AND does NOT contain a `SKIPPED:` skip-marker line):
   - Read `rounds/round-{current_round}/verifications/verification-summary.md`
   - If the file contains a `SKIPPED:` skip-marker → Phase 5.5 was legitimately skipped; there is nothing to apply (no FALSE-ALARM/REFINE/CONFIRM). Skip this step entirely and go to step 4.
   - **Skip** any finding in the "剔除清单" (FALSE-ALARM) — these do NOT enter categorization
   - **Replace** the description of any finding in the "修正清单" (REFINE) with its corrected description
   - **Mark** any finding with a plain `CONFIRM` verdict with "✅ 已验证" in the final output so the user knows it passed independent focused verification (higher confidence)
   - **Do NOT mark** `CONFIRM (unverified)` or `UNVERIFIED (exceeded max_findings cap)` findings with "✅ 已验证" — they entered Phase 6 without a successful verification. Leave them unmarked; they receive no confidence bonus (see step 5)

4. Deduplicate and merge related findings.

5. Weight by confidence:
   - Confirmed by redundancy: +2
   - Agreed in discourse: +1
   - Challenged and defended: +1
   - Challenged and undefended: -1
   - Confirmed by Phase 5.5 focused verification (CONFIRM): +1

6. Categorize findings into three sections:
   - **🚫 阻塞性问题 (Blockers)**: 安全漏洞、数据完整性风险、正确性缺陷、破坏性变更
   - **🔶 应当修复 (Should Fix)**: 代码质量问题、潜在缺陷、缺失校验、重要重构
   - **💡 改进建议 (Suggestions)**: 代码风格偏好、小幅重构、文档补充、测试建议

   **Every finding in every category MUST have a location field** with the format `path/to/file.ext:startLine-endLine`.

7. **If requirements were provided**, include Requirements Assessment (需求评估).

8. **Collect and surface Clarifying Questions** (待澄清问题) from Tech Lead and all reviewers.

9. **Write the final review file IN CHINESE**:
   ```
   OUTPUT: $SESSION_DIR/rounds/round-{current_round}/final.md
   ```

   **Language requirement**: The final review file MUST be written entirely in Chinese (中文). All section headers, descriptions, findings, suggestions, and summaries must be in Chinese. Code snippets and file paths remain in their original form.

   See `references/output-template.md` for the template format.

### Post-Write Filename Verification (MANDATORY, cross-platform)

**Immediately after writing the synthesis output, verify the file landed on disk with the EXACT name `final.md`.** This guards against the most common failure mode under interruption/retry: the model writing `summary.md`, `synthesis.md`, or `SYNTHESIS.md` instead of `final.md`. Run the verification for your platform BEFORE updating PROGRESS.md:

**Bash (Linux / macOS / Git Bash):**
```bash
FINAL="$SESSION_DIR/rounds/round-$CURRENT_ROUND/final.md"
if [ -f "$FINAL" ]; then
  echo "OK: final.md exists"
else
  echo "FATAL: final.md missing — scanning for misnamed synthesis files..."
  # Scan the round dir for any .md that looks like a misnamed final output
  ROUND_DIR="$SESSION_DIR/rounds/round-$CURRENT_ROUND"
  MISNAMED=$(ls -1 "$ROUND_DIR" 2>/dev/null | grep -iE '^(summary|synthesis|conclusion|result|review)\.md$' || true)
  if [ -n "$MISNAMED" ]; then
    echo "Found misnamed file: $MISNAMED — renaming to final.md"
    mv "$ROUND_DIR/$MISNAMED" "$FINAL"
    echo "OK: renamed -> final.md"
  else
    echo "FATAL: no candidate file found. Re-execute synthesis and write to $FINAL immediately."
  fi
fi
```

**PowerShell (Windows):**
```powershell
$Final = "$SESSION_DIR\rounds\round-$CURRENT_ROUND\final.md"
if (Test-Path $Final) {
  Write-Output "OK: final.md exists"
} else {
  Write-Output "FATAL: final.md missing — scanning for misnamed synthesis files..."
  $RoundDir = "$SESSION_DIR\rounds\round-$CURRENT_ROUND"
  $Misnamed = Get-ChildItem -Path $RoundDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(?i)(summary|synthesis|conclusion|result|review)\.md$' }
  if ($Misnamed) {
    Write-Output "Found misnamed file: $($Misnamed.Name) — renaming to final.md"
    Rename-Item -Path $Misnamed.FullName -NewName "final.md" -Force
    Write-Output "OK: renamed -> final.md"
  } else {
    Write-Output "FATAL: no candidate file found. Re-execute synthesis and write to $Final immediately."
  }
}
```

**Rules:**
- The ONLY valid filename is `final.md`. `summary.md`, `synthesis.md`, `SYNTHESIS.md`, `conclusion.md`, `result.md`, `review.md` are ALL invalid.
- If a misnamed file is found, rename it to `final.md` (do NOT delete and rewrite — preserve the content).
- If no candidate exists, re-execute synthesis and write directly to `final.md`. Do NOT proceed to Phase 8 until `final.md` exists.
- After a rename, re-read `final.md` to confirm it contains categorized findings (🚫, 🔶, 💡).

### Synthesis Strategy (Context-Aware)

To produce final.md reliably even under context pressure, use a **summary-first approach**:

1. **Read summaries first** — For each reviewer output file, read only the `## Summary` section (first ~15 lines). Use `head -15` or read with line limits.

2. **Build the skeleton** — Using only the summaries, create the skeleton of final.md:
   - Move blocker titles to the 🚫 section
   - Move should-fix titles to the 🔶 section
   - Move suggestion titles to the 💡 section

3. **Fill in details selectively** — For each finding that needs detail (blockers always, should-fix optionally):
   - Read the specific section from the reviewer output file
   - Use `grep -A 10 "finding title"` or targeted line-range reads to extract just the relevant section
   - Do NOT read entire reviewer files at once if context is constrained

4. **Write progressively** — Write each section of final.md to disk as you complete it. Do not hold the entire final.md in context before writing.

### Recovery Protocol (Context Compression)

If you discover that intermediate phase outputs have been lost due to context compression:

1. **Check what files exist** in the session directory:
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   ls -la "$SESSION_DIR/"
   ls -la "$SESSION_DIR/rounds/round-$CURRENT_ROUND/reviews/"
   ```
   **PowerShell (Windows):**
   ```powershell
   Get-ChildItem -Path "$SESSION_DIR/" -Force
   Get-ChildItem -Path "$SESSION_DIR/rounds/round-$CURRENT_ROUND/reviews/" -Force
   ```

2. **Read available files** — Read whatever reviewer outputs, context.md, and discourse.md still exist.

3. **Synthesize from available data** — Produce final.md using whatever findings are available.

4. **Mark uncertainty** — Add a note at the top of final.md (in Chinese):
   ```markdown
   > **注意**: 本次审查在上下文恢复条件下合成，部分发现可能不完整。
   > 可用的评审员输出: [列出找到的文件]
   > 缺失的评审员输出: [列出预期但未找到的文件]
   ```

5. **NEVER skip writing final.md** — Even a partial review with 1 reviewer's findings is better than no output.

### Phase 7 Checkpoint

**STOP and verify before proceeding (self-check, do NOT ask the user):**
- [ ] **Post-Write Filename Verification PASSED** — `final.md` exists on disk with the EXACT name (run the cross-platform verification above; any misnamed file has been renamed to `final.md`)
- [ ] `rounds/round-{n}/final.md` exists and has been written to disk
- [ ] Contains categorized findings in Chinese (阻塞性问题, 应当修复, 改进建议)
- [ ] **Every finding has a complete file path with line numbers** — zero findings with empty/missing location
- [ ] **Zero change descriptions or factual summaries** — every finding points to an actionable problem
- [ ] **If Phase 5.5 was actually executed (not skipped — i.e. `verification-summary.md` has verdicts, NOT a `SKIPPED:` marker)**: no FALSE-ALARM finding (from verification-summary.md "剔除清单") appears in final.md; plain CONFIRM findings are marked "✅ 已验证"; `CONFIRM (unverified)` and `UNVERIFIED (exceeded max_findings cap)` findings are NOT marked "✅ 已验证"
- [ ] Contains 待澄清问题 section (if any)
- [ ] If requirements provided: Contains 需求评估
- [ ] All text content is in Chinese (code/file paths remain in original form)
- [ ] **PROGRESS.md updated**: Phase 7 status set to `DONE`, final.md recorded in Output Files

---

## Phase 8: Present

**Goal**: Display results to the user **in Chinese (中文)**.

### Resume Check (if interrupted)

Phase 8 is a display-only phase. If interrupted after final.md was written but before presentation was complete, simply re-read final.md from disk and present it again.

### Final.md Verification (MANDATORY, cross-platform)

Before presenting results, verify that final.md exists. If it is missing, scan for a misnamed synthesis file and rename it to `final.md` before proceeding.

**Bash (Linux / macOS / Git Bash):**
```bash
FINAL="$SESSION_DIR/rounds/round-$CURRENT_ROUND/final.md"
if [ -f "$FINAL" ]; then
  echo "EXISTS"
else
  echo "MISSING — scanning for misnamed synthesis files..."
  ROUND_DIR="$SESSION_DIR/rounds/round-$CURRENT_ROUND"
  MISNAMED=$(ls -1 "$ROUND_DIR" 2>/dev/null | grep -iE '^(summary|synthesis|conclusion|result|review)\.md$' || true)
  if [ -n "$MISNAMED" ]; then
    echo "Found misnamed file: $MISNAMED — renaming to final.md"
    mv "$ROUND_DIR/$MISNAMED" "$FINAL"
    echo "RECOVERED"
  else
    echo "MISSING"
  fi
fi
```

**PowerShell (Windows):**
```powershell
$Final = "$SESSION_DIR\rounds\round-$CURRENT_ROUND\final.md"
if (Test-Path $Final) {
  Write-Output "EXISTS"
} else {
  Write-Output "MISSING — scanning for misnamed synthesis files..."
  $RoundDir = "$SESSION_DIR\rounds\round-$CURRENT_ROUND"
  $Misnamed = Get-ChildItem -Path $RoundDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(?i)(summary|synthesis|conclusion|result|review)\.md$' }
  if ($Misnamed) {
    Write-Output "Found misnamed file: $($Misnamed.Name) — renaming to final.md"
    Rename-Item -Path $Misnamed.FullName -NewName "final.md" -Force
    Write-Output "RECOVERED"
  } else {
    Write-Output "MISSING"
  }
}
```

If MISSING (after the scan above still reports MISSING):
1. This is a critical failure — the review MUST produce a final.md
2. Re-run Phase 7 Synthesis immediately using the Recovery Protocol
3. If no reviewer outputs exist at all, write a minimal final.md explaining the failure
4. **NEVER end the review without a final.md file**

### Steps

1. **Clean up diff.patch FIRST** (disk-offload mode only) — If the review used disk-offload mode (diff > 500 lines), delete the diff patch file to free disk space and prevent accidental re-reading of large diff content. **Run the command matching your shell** (the file must be removed on BOTH platforms — a leftover diff.patch on Windows would silently leave large diff content on disk):
   ```bash
   # Bash (Linux/macOS)
   rm -f "$SESSION_DIR/diff.patch"
   ```
   ```powershell
   # PowerShell (Windows) — MUST use Remove-Item with -Force.
   # Do NOT write `rm -f` here: in PowerShell `rm` is an alias for Remove-Item
   # and `-f` is ambiguous (matches both -Filter and -Force), which makes the
   # command ERROR OUT and leave diff.patch undeleted.
   Remove-Item -Path "$SESSION_DIR/diff.patch" -Force -ErrorAction SilentlyContinue
   ```
   If inline mode was used, no diff.patch exists — skip this step.

2. Display the final review in Chinese in a clear format:
   ```markdown
   # 代码审查: {branch}

   ## 概要
   {X} 个阻塞项, {Y} 个应当修复, {Z} 个改进建议

   ## 🚫 阻塞性问题
   ...

   ## 🔶 应当修复
   ...

   ## 💡 改进建议
   ...
   ```

2a. **展示已剔除的误报（Phase 5.5 可见性，当 verification-summary.md 存在且含 FALSE-ALARM 时）**: 从 `rounds/round-{current_round}/verifications/verification-summary.md` 的"剔除清单"读取，在审查报告末尾（三类问题之后、Graph 汇总之前）追加一节，让用户知道有哪些发现被聚焦验证判定为误报并剔除、可去 summary 查完整依据。这是为了保留用户对"被 AI 自行判定为误报的发现"的可见性——不污染 actionable findings，但不让剔除静默发生。
   ```markdown
   ## 🧹 已剔除的误报（经 Phase 5.5 聚焦验证）
   以下发现经验证判定为误报，未计入上方问题列表。完整验证依据见 verification-summary.md。

   - principal-1 "ABA 死锁" (AuthService.java:42-58) — 验证依据摘要: 锁总在重入前释放，不构成 ABA
   - ...
   ```
   若 Phase 5.5 被跳过（`--quick` / 无高风险发现 / 配置关闭）或无 FALSE-ALARM，跳过此节，不显示空标题。同时若有 `CONFIRM (unverified)` 或 `UNVERIFIED (exceeded max_findings cap)` 条目，在此节后单独提示一行："⚠️ 有 {N} 条发现因验证失败/超限未验证而按保守策略保留（已计入上方列表），详见 verification-summary.md。"

3. **展示 Graph 使用汇总**（当 graph 可用时）：从 context.md 的 Graph Usage Log 表读取汇总，在审查报告末尾呈现，让用户了解本次审查的图谱使用情况与成本。graph 不可用时跳过此步。
   ```markdown
   ## 📊 知识图谱使用情况

   - 图谱状态: 可用（检测方法: list_graph_stats_tool + get_minimal_context_tool）
   - 工具调用: {N} 次（ok {a} / partial {b} / skip {c} / fail {d}）
   - 估算 token 消耗: ~{T}
   - **估算 token 节省: ~{saved}（平均 {avg_percent}%）** ← 从 context_savings.saved_tokens 汇总
   - 回退 grep 补充: {fallback_count} 处
   - 结构级发现: hub 命中 {hub_hits} / bridge 命中 {bridge_hits} / 意外耦合 {surprise_hits}

   | Phase | Tool | Status | Est. Tokens | Saved Tokens |
   |-------|------|--------|-------------|--------------|
   | ... | (从 Graph Usage Log 摘录关键行) | ... | ... | ... |

   > 估算 token 为粗略值（4 chars/token 近似），实际消耗以平台计费为准。
   ```
   **token 节省文案兜底**：若所有调用的 saved_percent 均 <= 0，改显示"本次变更较小，图谱开销与直读相当，未显著节省 token"。
   若 graph 不可用，仅显示一行: "本次审查未使用知识图谱（graph 未启用或图未构建），全程使用 grep。"

4. Confirm session saved:
   ```
   审查完成
   -> $SESSION_DIR/rounds/round-{n}/final.md
   ```

5. **PROGRESS.md updated**: Phase 8 status set to `DONE`. All phases complete. Review finished.

---

## Quick Reference

| Phase | Action | Output | Resume Check |
|-------|--------|--------|-------------|
| 0 | Check PROGRESS.md + existing session | Session directory, `PROGRESS.md` | N/A (entry point) |
| 1 | Discover context + config + resolve scope + **detect graph availability** | `discovered-standards.md`, `requirements.md` | File exists → skip |
| 2 | Git metadata + adaptive diff + **graph navigation (available) / grep-only (unavailable)** | `context.md`, `diff.patch` (if disk-offload), `rounds/round-1/reviews/` | `context.md` exists → skip |
| 3 | Analyze + **graph risk scoring + test coverage gaps (available)**, select reviewers | Guidance in `context.md` | `context.md` has Tech Lead Guidance → skip |
| 4 | Spawn reviewer tasks + **inject navigation tips + graph guide (available)** | `rounds/round-{n}/reviews/*.md` | Check which reviewer files exist; only re-spawn missing |
| 5 | Compare redundant runs | Aggregated findings | Pure computation; re-execute if interrupted |
| 5.5 | Focused verification of high false-positive-risk findings (skippable via `--quick` or when no high-risk findings) | `rounds/round-{n}/verifications/verification-summary.md` | `verification-summary.md` exists with verdicts OR a `SKIPPED:` skip-marker → skip |
| 6 | Reviewer discourse | `rounds/round-{n}/discourse.md` | `discourse.md` exists with responses OR a valid `SKIPPED:` marker → skip |
| 7 | Synthesize final review (in Chinese) | `rounds/round-{n}/final.md` | `final.md` exists with categories → skip |
| 8 | Present results (in Chinese) + cleanup diff.patch (if disk-offload) | Terminal output | Re-read `final.md` from disk |
