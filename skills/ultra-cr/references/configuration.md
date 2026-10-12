# Reviewer Teams and Configuration

Resolve all `references/` paths from SKILL_ROOT, not this document directory.

## Default Reviewer Team

| Reviewer            | Count | Focus                                   |
| ------------------- | ----- | --------------------------------------- |
| **Principal** | 2     | Architecture, patterns, maintainability |
| **Quality**   | 1     | Code style, readability, best practices |

Optional reviewers (added based on change type or user request):

### Holistic Reviewers

| Reviewer                 | Count | When Added                                               |
| ------------------------ | ----- | -------------------------------------------------------- |
| **Architect**      | 1     | Cross-module changes, new abstractions, breaking changes |
| **Fullstack**      | 1     | End-to-end changes crossing FE/BE boundary               |
| **Reliability**    | 1     | Retry, circuit breaker, observability changes            |
| **Staff Engineer** | 1     | Cross-team impact, strategic alignment                   |

### Specialist Reviewers

| Reviewer                     | Count | When Added                                                                                        |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| **Security**           | 1     | Auth, API, or data handling changes                                                               |
| **Testing**            | 1     | Manual only — opt-in via`--team=testing:1` or "检查测试覆盖" (never auto-added)                |
| **Frontend**           | 1     | UI/component/state management changes                                                             |
| **Backend**            | 1     | API/data modeling/concurrency changes                                                             |
| **Performance**        | 1     | Hot path, query, caching, algorithm changes                                                       |
| **Profiling Analysis** | 1     | Profiling data provided (flame graphs, GC logs, heap dumps) — triggers profiling-diagnostic mode |
| **DevOps**             | 1     | CI/CD, infra, deployment changes                                                                  |
| **Data**               | 1     | Schema/migration/query changes                                                                    |
| **Infrastructure**     | 1     | Cloud/deployment/scaling changes                                                                  |
| **Accessibility**      | 1     | UI/UX/a11y changes                                                                                |
| **DX**                 | 1     | API ergonomics, error messages, SDK changes                                                       |
| **Mobile**             | 1     | iOS/Android/React Native changes                                                                  |
| **AI**                 | 1     | LLM/prompt/model integration changes                                                              |
| **Docs Writer**        | 1     | Documentation-heavy changes                                                                       |

### Persona Reviewers

| Reviewer                  | Count | When Added                                                         |
| ------------------------- | ----- | ------------------------------------------------------------------ |
| **Martin Fowler**   | 1     | Large-scale refactoring, code smell detection                      |
| **Sandi Metz**      | 1     | Object design, dependency management, abstraction timing           |
| **John Ousterhout** | 1     | Deep modules, complexity budget, strategic vs tactical programming |

### Bundled Reviewers

Bundled reviewers live in the `references/reviewers/bundled/` directory inside the ultra-cr skill installation (absolute path: `${SKILL_ROOT}/references/reviewers/bundled/`). They are **not hard-coded** — each is a self-contained custom reviewer represented by a **subdirectory** under `bundled/` (the directory name is the reviewer ID). The directory's direct-level `.md` files are the persona; any `.md` files inside its subdirectories are reference materials. The bundled `java-code-smell` reviewer serves as the reference example.

| Reviewer                                              | Count | When Added                                                                                                   |
| ----------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| **JavaCodeSmell** (example custom reviewer) | 1     | Java code smells, concurrency, dependency, crypto (auto-added for`.java` changes via intelligent matching) |

> **Extensible — no SKILL.md/workflow.md edits needed**: To add a new custom reviewer under any of the three search paths, create a `{reviewer-id}/` directory, place persona `.md` file(s) at its direct level, and (optionally) place reference `.md` files inside any subdirectory of it. The framework discovers it automatically and loads all reference files in those subdirectories. See [Custom Reviewer Directory Convention](#custom-reviewer-directory-convention-all-three-paths) below.

**Override via natural language**: "add security focus", "use 3 principal reviewers", "include architect", "check java code smells", "add frontend review", "include performance perspective", "use martin fowler lens", "add AI review", "check with devops lens"

**Override via `--team`**: `--team=principal:2,security:1,architect:1,frontend:1,performance:1,martin-fowler:1`

**Auto-detection** (adds built-in reviewers beyond config, max 6 additional):

| Change Type                                                                                                                                 | Additional Reviewers   | Detection Method                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| Auth/Security changes (`auth`, `token`, `password`, `secret`, `permission`)                                                       | +1 Security            | Content pattern scan                                                             |
| API changes (`@RequestMapping`, `router.get/post`, `app.get/post`)                                                                    | +1 Security +1 Backend | Content pattern scan                                                             |
| Cross-module changes (>3 directories)                                                                                                       | +1 Architect           | Path analysis                                                                    |
| New abstractions (new`interface`/`abstract class`/`protocol`)                                                                         | +1 Architect           | Content pattern scan                                                             |
| Frontend files (`.tsx`/`.jsx`/`.vue`/`.svelte`/`.css`/`.scss`)                                                                  | +1 Frontend            | File extension scan                                                              |
| Go/Python files (`.go`/`.py`)                                                                                                           | +1 Backend             | File extension scan                                                              |
| Dockerfile/k8s/TF (`Dockerfile`/k8s `.yaml`/`.tf`)                                                                                    | +1 DevOps              | File extension scan                                                              |
| SQL/migration files                                                                                                                         | +1 Data                | File extension scan                                                              |
| Performance keywords (`cache`, `index`, `query`, `N+1`, `latency`)                                                                | +1 Performance         | Content pattern scan                                                             |
| Profiling keywords (`火焰图`, `flame graph`, `GC log`, `profiling`, `heap dump`, `async-profiler`, `OOM`, `内存泄漏`, etc.) | +1 Profiling Analysis  | User prompt + requirements scan (keyword-only; enters profiling-diagnostic mode) |
| Reliability keywords (`retry`, `circuit-break`, `timeout`, `fallback`)                                                              | +1 Reliability         | Content pattern scan                                                             |
| AI keywords (`prompt`, `embedding`, `openai`, `langchain`, `llm`)                                                                 | +1 AI                  | Content pattern scan                                                             |
| Mobile paths (`android/`, `ios/`, `react-native`, `flutter`)                                                                        | +1 Mobile              | Path scan                                                                        |
| Infrastructure paths (`terraform/`, `k8s/`, `helm/`, `ansible/`)                                                                    | +1 Infrastructure      | Path scan                                                                        |
| Large refactoring (>10 files OR >500 lines)                                                                                                 | +1 Martin Fowler       | Scale analysis                                                                   |
| New core module (new directory with business logic)                                                                                         | +1 John Ousterhout     | Path + content analysis                                                          |
| Significant class hierarchy change                                                                                                          | +1 Sandi Metz          | Content pattern scan                                                             |

> **Custom reviewers auto-trigger too**: Custom reviewers under `references/reviewers/bundled/` (and `~/.config/ultra-cr/reviewer/`, `.reviews/ultra-cr/reviewer/`) are auto-detected by intelligent matching — the Tech Lead reads each reviewer's persona description and judges whether it applies to the current change. For example, `java-code-smell` is auto-added for `.java` changes because its description says it reviews Java code smells.

**Auto-detection priority** (when >6 built-in triggered): Security > Reliability > Architect > Performance > Specialist > Persona

**Auto-detection deduplication**: Reviewers already in the configured team are never added again.

> **Important**: The "max 6 additional" limit applies ONLY to built-in reviewers added by auto-detection. The following reviewers are **always loaded** and do NOT count toward this limit:
>
> - **Custom reviewers auto-detected via intelligent matching** — any reviewer under `references/reviewers/bundled/`, `~/.config/ultra-cr/reviewer/`, or `.reviews/ultra-cr/reviewer/` whose persona description matches the current change (e.g., `java-code-smell` for `.java` changes)
> - **Profiling Analysis** — auto-triggered by profiling keywords in user prompt/requirements (enters profiling-diagnostic mode)
> - Custom reviewers explicitly added via `--team={reviewer-id}:1`, natural language, or `.ultra-cr.yaml`
> - Reviewers explicitly specified in `.ultra-cr.yaml` or `--team`

## Custom Reviewers

You can create your own reviewer personas for domain-specific review needs. Custom reviewers are loaded from three locations (in priority order):

### Custom Reviewer Search Paths

| Priority    | Path                                                                       | Scope                         | Use Case                                                                  |
| ----------- | -------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| 1 (highest) | `~/.config/ultra-cr/reviewer/{reviewer-id}/`                       | Global (all projects)         | Shared custom reviewers across all your projects                          |
| 2           | `.reviews/ultra-cr/reviewer/{reviewer-id}/`                         | Project-level                 | Project-specific custom reviewers, committed to VCS                       |
| 3           | `${SKILL_ROOT}/references/reviewers/bundled/{reviewer-id}/` | Skill-bundled | Bundled reviewers shipped/added inside the ultra-cr skill itself |

All three paths use the **same directory convention**: each reviewer is a subdirectory whose name is the reviewer ID; every `.md` file at the directory's direct level is part of the persona; every `.md` file inside any of its subdirectories is a reference file. There is no per-path divergence in discovery or loading logic.

When Phase 4 resolves a reviewer ID that is NOT a built-in reviewer (holistic/specialist/persona/bundled), it searches these paths in order and uses the **first match found** (a match = a subdirectory named `{reviewer-id}` with at least one direct-level `.md` file). If no subdirectory is found, the reviewer ID is treated as an **ephemeral reviewer** — a persona is synthesized from the ID name automatically.

> **`~`** refers to the user's home directory (`$HOME` on Linux/Mac, `%USERPROFILE%` on Windows).

### Custom Reviewer Directory Convention (All Three Paths)

All three search paths above share **one** directory convention — there is no per-path divergence. Each reviewer is a **subdirectory** and is **fully self-contained**: the directory name is the reviewer ID; every `.md` file at the directory's direct level is part of the persona; every `.md` file inside any of its subdirectories is a reference file. The framework handles discovery and reference loading automatically:

```
{search-path-root}/                  ← any of the three roots (bundled/, ~/.config/ultra-cr/..., .reviews/...)
├── java-code-smell/            ← a reviewer subdirectory (directory name = reviewer ID) [bundled example]
│   ├── java-code-smell.md      ← persona file (direct-level .md; filename is free)
│   └── references/             ← reference files (any subdirectory name; .md inside)
│       ├── java-code-smell-checklist.md
│       └── ...
└── {your-reviewer-id}/              ← your custom reviewer subdirectory
    ├── persona.md                   ← persona file(s) at direct level (filename is free; multiple allowed)
    └── reference/                   ← (optional) reference files in any subdirectory (name is free)
        ├── reference-a.md
        └── reference-b.md
```

**To add a new custom reviewer** (works the same way under any of the three paths):

1. Create a `{reviewer-id}/` subdirectory under the chosen search-path root — the directory name is the reviewer ID. Place one or more persona `.md` file(s) at its direct level. These are the reviewer persona (normal markdown documents). Write the persona, focus areas, review approach, and any cross-review awareness in plain prose, just like `java-code-smell/java-code-smell.md`.
2. (Optional) Create any subdirectory inside `{reviewer-id}/` and place supporting reference files (`.md`) there. The framework **automatically loads ALL `.md` files** from ALL subdirectories (recursively) and attaches them to the reviewer's prompt — you do NOT need to declare which files to load or when. Neither the persona filename nor the reference subdirectory name matters; only the directory level distinguishes persona (direct-level files) from references (files in subdirectories). The reviewer persona body simply tells the reviewer how to use them.

**How the framework handles custom reviewers (no configuration needed)**:

- **Discovery**: The Tech Lead scans every **subdirectory** directly under each search-path root. Each subdirectory name is a valid reviewer ID. A subdirectory with no direct-level `.md` file is skipped (not a valid reviewer). This applies identically to the BUNDLED path, the user-global path, and the project-level path.
- **Reference loading**: When spawning a reviewer, the framework reads ALL `.md` files in ALL subdirectories of the reviewer's directory (recursively) and includes their full content in the reviewer's prompt. No declaration needed.
- **Cross-review routing**: If the reviewer's persona body contains a "Cross-Review Awareness" section (natural language describing which domain reviewers should validate its findings), the Tech Lead reads it and routes findings accordingly during Phase 6 (Discourse).
- **Triggering**: Custom reviewers ARE auto-triggered by intelligent matching. The Tech Lead reads each reviewer's persona description and judges whether it applies to the current change (file types, content). The reviewer's own self-description is the signal. You can also add any reviewer manually via `--team={reviewer-id}:1` or natural language.

> **Reference example**: `references/reviewers/bundled/java-code-smell/` is a complete, working example — a reviewer subdirectory containing a persona `.md` at its direct level, backed by a subdirectory of reference files. Copy it as the starting point for new reviewers.

### Custom Reviewer Auto-Trigger

Custom reviewers are auto-triggered by intelligent matching — the Tech Lead reads each reviewer's persona description and judges whether it applies to the current change. For example, `java-code-smell` is auto-added for `.java` changes because its description says it reviews Java code smells.

You can also add any reviewer manually at any time:

- **Via `--team`**: `--team={reviewer-id}:1`
- **Via natural language**: "add {reviewer-id} review", "include {reviewer-id} perspective"
- **Via `.ultra-cr.yaml`**: add the reviewer ID to the team config

Custom reviewers (auto-triggered or manually added) do **NOT** count toward the 6-reviewer auto-detection limit. Deduplication still applies: if a custom reviewer is already in the team config, it won't be added again.

### Creating a Custom Reviewer

Create a `{reviewer-id}/` subdirectory under any of the search paths above, then place a persona `.md` file (following the template below) at its direct level:

```markdown
# {Title} Reviewer

You are a **{Title}** conducting a code review. You have expertise in {domain}.

## Focus Areas

- **{Area 1}**: {Description}
- **{Area 2}**: {Description}
- **{Area 3}**: {Description}

## Review Approach

1. {Step 1}
2. {Step 2}
3. {Step 3}

## What You Look For

### {Category 1}
- {Check item}
- {Check item}

### {Category 2}
- {Check item}
- {Check item}

## Output Style

- {Style guideline 1}
- {Style guideline 2}

## Agency Reminder

You have **full agency** to explore the codebase. {Specific guidance on what to explore}. Document what you explored and why.
```

> **Reference example**: `references/reviewers/bundled/java-code-smell/` is a complete, working custom reviewer — a reviewer subdirectory containing a persona `.md` at its direct level, backed by a subdirectory of reference files. Copy it as the starting point for new reviewers.

### Using Custom Reviewers

Once created, use custom reviewers via:

**Natural language**: "add {reviewer-id} review", "include {reviewer-id} perspective"

**`--team` argument**: `--team=principal:2,{reviewer-id}:1`

**Config file** (`.ultra-cr.yaml`):

```yaml
team:
  principal: 2
  quality: 1
  {reviewer-id}: 1   # Custom reviewer from ~/.config/ultra-cr/reviewer/ or .reviews/ultra-cr/reviewer/
```

## Reviewer Agency

Each reviewer sub-agent has **full agency** to explore the codebase. They:

- Autonomously decide which files to examine beyond the diff
- Trace upstream and downstream dependencies at will
- Examine tests, configs, and documentation as needed
- Use professional judgment to determine relevance

Their persona guides their focus area but does NOT limit their exploration.

> **Important**: Reviewers must NOT pause the review to ask questions. Any uncertainties should be documented as "Clarifying Questions" in the reviewer output file. These questions will be collected and surfaced in the final review's "待澄清问题" section.

## Subagent Dispatch Contract

**Every reviewer instance runs as exactly one dedicated subagent.** This contract is the single source of truth for how reviewers (Phase 4), verification findings (Phase 5.5), and discourse responses (Phase 6) are dispatched. The three spawn sites in `references/workflow.md` reference this contract and add their site-specific mapping rules.

### The Three Rules

1. **1:1 mapping (Iron).** One reviewer instance = exactly one subagent. `--team=principal:2,quality:1` resolves to 3 reviewer instances → 3 subagents. No more, no less. A reviewer instance is a single `{type}-{n}` slot (e.g. `principal-1`, `principal-2`, `quality-1`).

2. **Host-compatible parallel dispatch.** Launch independent reviewers concurrently up to the host's capacity. If the host exposes sequential spawn calls, issue them without waiting for earlier reviewers; if capacity is full, queue remaining instances in batches. Record actual capacity and batches. Every declared instance must still run; message shape is not a correctness condition.

3. **Declared count = dispatched count.** The number of subagents dispatched MUST equal the number of instances resolved in Phase 3. Dispatching fewer (because "there are many reviewers") or more is a violation. Each spawn-site checkpoint enforces this.

### Wave Constraint

- **Non-diagnostic mode** (profiling-analysis reviewer NOT in team): one logical wave — dispatch concurrently within host capacity, batching when required.
- **Diagnostic mode** (profiling-analysis reviewer in team): two waves. Wave 1 = the profiling-analysis reviewer alone (produces `hotspot-inventory.md`). Wait for Wave 1 to complete. Wave 2 = ALL other reviewers dispatched concurrently within host capacity, with the hotspot inventory injected as scope.

### Reviewer subagents are read-only

Reviewer / verification / discourse subagents may read and explore project files and write only their assigned review artifacts. They MUST NOT apply refactors, edit product source, or run apply-class tools — reviewed project code is read-only.

### Forbidden behaviors (contract violations)

| ❌ Forbidden | ✅ Required |
|---|---|
| Role-playing a reviewer in the main Tech Lead context (no subagent dispatched) | Dispatch one subagent per reviewer instance |
| Waiting unnecessarily between independent reviewers | Launch concurrently within host capacity; queue remaining instances |
| Merging multiple reviewers into a single subagent | One subagent per `{type}-{n}` instance |
| Reducing the dispatch count because "too many reviewers" | Dispatch exactly the Phase 3 resolved count |

> These rules apply identically to Phase 5.5 (where the 1:1 unit is a *finding*, not a reviewer — see `workflow.md` Phase 5.5) and Phase 6 (where the 1:1 unit is a reviewer's discourse response).

## Configuration

### Dual-Mode: Config File + Arguments

**Mode 1: Config file** (`.ultra-cr.yaml`, optional, in project root):

```yaml
context: |
  Tech stack: TypeScript, React, Node.js

output_dir: .reviews   # Review result output root directory. Default .reviews. User-specified dir becomes {output_dir}/ultra-cr/result/{date}-{branch}/

team:
  principal: 2
  quality: 1
  # security: 1   # Auto-added for auth/API/data changes

rules:
  critical:
    - Security vulnerabilities
    - Breaking changes without migration

discourse:
  enabled: true   # Set false or use --quick to skip

verification:
  enabled: true          # Phase 5.5 Focused Verification (noise reduction). Default true. Set false or use --quick to skip.
  max_findings: 8        # Optional: cap how many findings get verified. Excess (lowest-confidence) enter Phase 6 as unverified. Unset = no cap.
  # risk_types:          # Optional: override the default high false-positive-risk problem types
  #   - concurrency
  #   - security-injection
  #   - cross-module-impact
  #   - resource-leak
  #   - state-machine
```

**Mode 2: Arguments** (override config):

```
/ultra-cr --team=principal:2,security:1 --quick --output-dir=./reports
```

**Resolution order**: `$ARGUMENTS` > `.ultra-cr.yaml` > natural-language detection > defaults. This applies to `team`, `scope`, and `output_dir` alike. For `output_dir`: `--output-dir` argument > `.ultra-cr.yaml` `output_dir` field > natural-language "put results to <dir>" detection > default `.reviews`.

### Reading Config

In Phase 1, check for `.ultra-cr.yaml`:

**Bash (Linux / macOS / Git Bash):**

```bash
cat .ultra-cr.yaml 2>/dev/null
```

**PowerShell (Windows):**

```powershell
if (Test-Path .ultra-cr.yaml) { Get-Content .ultra-cr.yaml -Raw }
```

If not found, use sensible defaults (principal:2, quality:1).

### Project Review Rules (CODEREVIEW.md)

Phase 1 also discovers `CODEREVIEW.md` in the project root (optional). When present, its content (issue filtering, problem classification/grading, problem trimming) is merged into `discovered-standards.md` and propagated to EVERY reviewer sub-agent as project context, so all reviewers apply the same rules. This file is independent of `.ultra-cr.yaml` and does NOT participate in the resolution order above.

> **Authoritative source**: `references/workflow.md` Phase 1 Step 1d/1f contains the complete discovery and merge procedure.

