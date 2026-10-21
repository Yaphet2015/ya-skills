# Architecture Impact Analysis

Integrated into Phase 2 of the Ultra CR workflow. Analyzes how code changes affect the broader architecture, replacing the standalone Code Review Map feature.

> **See also**: `references/graph-integration.md` — 完整的 graph 工具使用指南和能力边界说明。

## Purpose

Understand not just WHAT changed, but HOW the change ripples through the system:
- Which modules, services, or layers are affected?
- Does the change cross system boundaries?
- Are there upstream/downstream dependencies?
- Could this change break existing contracts?

## Analysis Strategy

**Graph 是指南针，不是显微镜。** 当 graph 可用时，结构定位优先使用 graph，grep 用于验证和补充 graph 不覆盖的区域。当 graph 不可用时，回退到纯 grep 流程。

| 数据源 | 定位 | 擅长 | 不擅长 |
|--------|------|------|--------|
| **Graph**（首选） | 结构定位 | 调用链追踪、影响半径、执行路径、测试覆盖 | XML/配置内容、语句级问题 |
| **Diff** | 变更分析 | 代码级变更细节、逻辑缺陷 | 依赖关系、影响范围 |
| **Grep/Read**（验证补充） | 细节深入 | SQL 注入、硬编码密钥、MyBatis XML | 调用链上下文、跨文件依赖 |

## Graph-First Analysis Steps（当 graph 可用时）

### Step 1: Detect Changes with Risk Scoring

```bash
detect_changes_tool(base=$BASE_SHA, changed_files=[<git diff --name-only 的文件列表>], detail_level="minimal")
```

- 输出: 变更函数/类列表，每个带风险评分(risk_score)，**并聚合受影响 flows、测试覆盖缺口**
- 用途: 识别高风险变更点，指导后续导航和 reviewer 重点关注
- **必须传 base=$BASE_SHA**: 使用 workflow.md Phase 1 已解析的比较起点（分支范围为 merge-base），使分析覆盖整个审查范围；默认 HEAD~1 只分析最后一个 commit，全量审查场景下严重失真
- **复用原则**: 该工具已聚合大部分结构信息，后续 Step 2/4 仅对 top-N 高风险函数补充查询（N 自适应：≤5 文件取全部，6-20 取 top-3，>20 取 top-5），避免逐文件重复调用

**交叉验证**: 对比 `git diff --name-only` 输出与 `detect_changes_tool` 结果。如果某变更文件在 git diff 中出现但 `detect_changes_tool` 未返回该文件的任何函数/类，标注"⚠️ 图谱未索引此文件中的函数，reviewer 需自行 Grep/Read 检查"。这防止 graph 数据缺失时遗漏文件。

### Step 2: Trace Impact Radius

**仅对 top-N 高风险函数**调用 graph 获取完整依赖图（N 自适应，见 Step 1；避免对每个变更文件都调用导致 token 超预算）：

```bash
get_impact_radius_tool(changed_files=[<top-N 函数所在文件>], base=$BASE_SHA, detail_level="minimal")
```

- 输出: 上游调用方（谁调用了我）、下游依赖（我调用了谁）
- 用途: 精确定位受影响的关联函数/文件
- **注意**: 该工具按 changed_files（文件级）分析，传 top-N 高风险函数**所在文件**
- **优势 vs grep**: graph 追踪到函数级调用链，grep 只能按文件级 import 匹配，且无法发现反射调用、动态代理等

### Step 3: Trace Affected Execution Flows

```bash
get_affected_flows_tool(changed_files=[<git diff --name-only 的文件列表>], base=$BASE_SHA)
```

- 输出: 从入口点到变更点的完整调用链
- 用途: 识别跨模块/跨层边界影响
- **必须传 changed_files**: 用 `git diff --name-only` 获取变更文件列表传入，否则返回全图 flows 而非"受本次变更影响的 flows"，数据会误导（曾出现 partial fallback）
- **注意**: 该工具无 `detail_level` 参数，不要传该参数；接受 base（全量审查传 $BASE_SHA）
- **优势 vs grep**: graph 追踪真实执行路径（如 HTTP → Controller → Service → Repository），grep 只能从 import 语句推断

### Step 4: Check Test Coverage Gaps

**仅对 top-N 高风险变更函数**（N 自适应，见 Step 1），检查测试覆盖（`detect_changes_tool` 已提供大部分测试缺口信息，此处仅补充高风险函数的精确匹配）：

```bash
query_graph_tool(pattern="tests_for", target="AuthService.login", detail_level="minimal")
```

- 输出: 关联的测试函数列表（或空，表示无测试）
- 用途: 识别无测试覆盖的高风险变更，指导 Testing reviewer 重点关注
- **target 命名**: 使用图谱节点名（限定名，不带括号 `()`），如 `AuthService.login` 而非 `AuthService.login()`。若返回空，先用 `semantic_search_nodes_tool` 确认节点名
- **优势 vs grep**: graph 精确匹配测试函数与被测函数的调用关系，grep 可能误匹配同名方法

### Step 5: Grep Verification for Graph 未覆盖区域

graph 完成结构定位后，用 grep 补充 graph 不覆盖的依赖：

**Bash (Linux / macOS / Git Bash):**
```bash
grep -rl "changedRepositoryNamespace" --include="*.xml" src/main/resources/
grep -rl "changedBeanName" --include="*.xml" --include="*.yml" --include="*.properties" src/main/resources/
```
**PowerShell (Windows):**
```powershell
Get-ChildItem -Path src/main/resources/ -Recurse -Include *.xml | Select-String -Pattern "changedRepositoryNamespace" -List | Select-Object -ExpandProperty Path
Get-ChildItem -Path src/main/resources/ -Recurse -Include *.xml,*.yml,*.properties | Select-String -Pattern "changedBeanName" -List | Select-Object -ExpandProperty Path
```

- 用途: 发现 MyBatis XML 映射、Spring 配置引用等 graph 不覆盖的依赖
- 这是 graph 的补充，不是替代

### Step 6: Assess Boundary Impact

基于 graph 追踪的调用链，评估边界影响：

| Question | If Yes... |
|----------|-----------|
| Does the change cross a module boundary? | Flag for Architect review |
| Does this modify a public API or interface? | High risk — breaking change potential |
| Does this change data flow or state management? | Test coverage critical |
| Does this add a new dependency? | Evaluate necessity |
| Does this change configuration or environment? | Verify no side effects |

graph 的 `get_affected_flows_tool` 和 `get_impact_radius_tool` 可以直接回答前三个问题，无需手动推断。

### Step 7: Trace Data Visibility & Read-Side Impact

这是一个通用影响分析维度，适用于任何涉及共享状态写入的变更（KV/缓存/DB/事件发布/全局变量/跨实例同步），与语言无关。目的不是针对某种特定场景，而是补全"调用链/影响半径/测试缺口"之外的一个常被遗漏的维度：**变更改变了某个共享状态的可见性后，消费该状态的读取方行为是否变化**。

回答以下结构化问题（基于 Step 1-6 已有信息，无需新增 graph 工具调用）：

| Question | How to answer | If Yes... |
|----------|---------------|-----------|
| 变更是否新增/改变/移除了对共享状态的写入？ | 从 diff 识别写入点（KV set/缓存 put/DB write/event publish/全局赋值/同步调用） | 进入下一问；否则本维度无风险，跳过 |
| 写入是否是**条件写入/过滤写入**（排除了某个子集）？ | 检查写入路径是否有 `if`/`where`/`exclude` 等过滤条件 | 标注为高风险——过滤写入是读取侧回归的最常见根因 |
| 哪些读取入口消费这个状态？ | graph: `get_impact_radius_tool`(Step 2) 已返回的下游依赖中找读取方；或 `query_graph_tool(pattern="callers_of")` 反查读取入口；grep: 搜索状态 key/读取函数的引用 | 列出所有读取入口 |
| 变更前后，该状态对读取方是"查得到/查不到"？ | 推断：变更是否让原本查不到的状态变得可查（如新增写入/新增跨实例同步），或反之 | 若可见性发生变化，标记读取入口为风险点 |

**输出到 context.md 导航提示**：若识别到可见性变更的共享状态及其读取入口，在导航提示中列出（写入点 → 读取入口 → 可见性变化方向），供 behavior-regression reviewer（若在团队中）或 architect/backend reviewer 重点追踪。若无共享状态写入变更，本维度不产生导航提示。

**注意**：本维度只做结构级定位（"哪个写入点、哪些读取入口、可见性是否变化"），不做代码级判断（"读取分支是否真的回归、不变量是否真的破坏"）——后者由 reviewer 读代码完成。这正是 graph（导航）与 reviewer（分析）的分工。

### Step 8: Categorize Impact Level

| Impact Level | Criteria | Action |
|-------------|----------|--------|
| **Low** | Internal change, no boundary crossing | Standard review |
| **Medium** | Affects one other module or internal API | Additional review focus |
| **High** | Crosses multiple boundaries, changes public API | Architect review required |
| **Critical** | Breaking change, affects external consumers | Blocker potential |

graph 的 `detect_changes_tool` 风险评分可以直接辅助判断：risk_score >= 7 通常对应 High/Critical。

### Step 9: Generate Navigation Tips for Reviewers

将 graph 分析结果转化为**导航提示**（只告诉 reviewer "该查哪里"，不做代码级判断），写入 `context.md`：

```markdown
## 架构影响分析

### 知识图谱导航（结构级定位）

#### 高风险变更点
- `AuthService.login()` 风险评分 8/10 — 认证核心路径
  → 导航: 上游被 AuthController, MobileAuthController, TokenRefreshService 调用
  → 导航: 下游依赖 UserRepository, LdapClient, AuditLogService
  → ⚠️ graph 不覆盖 UserRepository 的 MyBatis XML 映射
  → 建议: Security reviewer 检查上游认证流程；Architect 检查下游容错
  → 建议: Grep/Read 检查 UserMapper.xml 的 SQL 参数化

#### 受影响执行路径
- HTTP → AuthController → AuthService → UserRepository（认证主路径）
- Token 刷新 → TokenRefreshService → AuthService → LdapClient（刷新路径）

#### 测试覆盖缺口
- ⚠️ `TokenRefreshService.refresh()` 无测试覆盖
- ✅ `AuthService.login()` 有测试覆盖 (AuthServiceTest)

#### 边界跨越
- controller → service 层：认证逻辑变更
- service → 外部系统(LdapClient)：外部调用稳定性风险

#### 共享状态可见性变更（仅当 Step 7 识别到时出现）
- 写入点 `SomeWriter.write` (path/file.go:NNN) 新增/改变对共享状态 {KV/cache/event} 的写入{（过滤了某子集）}
- 读取入口 `SomeReader.lookup` (path/file.go:NNN) — 变更后可查到该状态（原查不到）{或反之}
- 可见性变化: 查不到 → 查得到 → 读取方分支可能从"缺席回退"切到"已就绪处理"{或反之}
- → 建议: behavior-regression reviewer（若在团队）追踪读取分支变化；否则 architect/backend 追踪

### Graph 未覆盖区域（需 Grep/Read 补充）
- MyBatis XML 映射文件
- Spring 配置文件（yml/properties）
- 非代码资源
```

## Grep-Only Analysis Steps（当 graph 不可用时）

完全保持现有流程，不做任何改动。

### Step 1: Identify Changed Files

根据已解析的审查范围（staged / current-branch / branch:REF / commit:SHA / range:SHA1..SHA2），
使用对应的 git diff 命令获取变更文件列表。分支范围复用 workflow.md Phase 1 已固定的 BASE_SHA 和 REVIEW_SHA；all-branches 对每个已记录的分支范围分别执行：

**Bash (Linux / macOS / Git Bash):**
```bash
# staged 范围
git diff --cached --name-only
git diff --cached --stat

# current-branch 范围
git diff "$BASE_SHA..$REVIEW_SHA" --name-only
git diff "$BASE_SHA..$REVIEW_SHA" --stat

# branch:REF 范围
git diff "$BASE_SHA..$REVIEW_SHA" --name-only
git diff "$BASE_SHA..$REVIEW_SHA" --stat

# commit:SHA 范围
git diff SHA~1..SHA --name-only
git diff SHA~1..SHA --stat

# range:SHA1..SHA2 范围
git diff SHA1..SHA2 --name-only
git diff SHA1..SHA2 --stat
```
**PowerShell (Windows):**
```powershell
# staged 范围
git diff --cached --name-only
git diff --cached --stat

# current-branch 范围
git diff "$BASE_SHA..$REVIEW_SHA" --name-only
git diff "$BASE_SHA..$REVIEW_SHA" --stat

# branch:REF 范围
git diff "$BASE_SHA..$REVIEW_SHA" --name-only
git diff "$BASE_SHA..$REVIEW_SHA" --stat

# commit:SHA 范围
git diff "SHA~1..SHA" --name-only
git diff "SHA~1..SHA" --stat

# range:SHA1..SHA2 范围
git diff "SHA1..SHA2" --name-only
git diff "SHA1..SHA2" --stat
```

### Step 2: Trace Dependencies

For each changed file:

1. **Upstream** — What code calls or depends on this?
   **Bash (Linux / macOS / Git Bash):**
   ```bash
   grep -r "import.*from.*changed-file" --include="*.ts" --include="*.tsx" -l
   grep -r "require.*changed-file" --include="*.js" -l
   ```
   **PowerShell (Windows):**
   ```powershell
   Get-ChildItem -Recurse -Include *.ts,*.tsx | Select-String -Pattern "import.*from.*changed-file" -List | Select-Object -ExpandProperty Path
   Get-ChildItem -Recurse -Include *.js | Select-String -Pattern "require.*changed-file" -List | Select-Object -ExpandProperty Path
   ```

2. **Downstream** — What does this file depend on?
   - Read the changed file's imports/requires
   - Identify external service calls
   - Note database queries or API calls

3. **Shared types** — Are there shared interfaces, types, or schemas?
   - Check if changed types are used elsewhere
   - Identify contract changes (API, database schema)

### Step 3: Assess Boundary Impact

Ask these questions for each change:

| Question | If Yes... |
|----------|-----------|
| Does this change cross a module boundary? | Flag for Architect review |
| Does this modify a public API or interface? | High risk — breaking change potential |
| Does this change data flow or state management? | Test coverage critical |
| Does this add a new dependency? | Evaluate necessity |
| Does this change configuration or environment? | Verify no side effects |

### Step 3b: Trace Data Visibility & Read-Side Impact

与 Graph-First 流程的 Step 7 等价的通用维度（graph 不可用时用 grep 完成）。适用于任何涉及共享状态写入的变更，与语言无关。

回答以下结构化问题：

| Question | How to answer (grep-only) | If Yes... |
|----------|---------------------------|-----------|
| 变更是否新增/改变/移除了对共享状态的写入？ | 从 diff 识别写入点（KV set/缓存 put/DB write/event publish/全局赋值/同步调用） | 进入下一问；否则跳过 |
| 写入是否是**条件写入/过滤写入**？ | 检查写入路径是否有过滤条件 | 标注为高风险 |
| 哪些读取入口消费这个状态？ | `grep`/`Select-String` 搜索状态 key/读取函数的引用，列出读取入口 | 列出所有读取入口 |
| 变更前后，该状态对读取方是"查得到/查不到"？ | 推断变更是否改变了可见性 | 若变化，标记读取入口为风险点 |

若识别到可见性变更，在下方 Step 5 的 impact summary 中补充"共享状态可见性变更"子节；否则不产生。

### Step 4: Categorize Impact Level

| Impact Level | Criteria | Action |
|-------------|----------|--------|
| **Low** | Internal change, no boundary crossing | Standard review |
| **Medium** | Affects one other module or internal API | Additional review focus |
| **High** | Crosses multiple boundaries, changes public API | Architect review required |
| **Critical** | Breaking change, affects external consumers | Blocker potential |

### Step 5: Generate Impact Summary

Include in `context.md`:

```markdown
## 架构影响分析

### 按模块分类的变更文件
- **auth/**: 3 个文件变更
- **api/**: 1 个文件变更
- **shared/types/**: 2 个文件变更

### 依赖影响
- `auth/middleware.ts` 被 2 个模块中的 5 个文件导入
- `shared/types/auth.ts` 变更可能影响 API 契约

### 边界跨越
- auth → api: API 中间件新增认证头
- shared/types: Auth 类型修改，潜在下游影响

### 共享状态可见性变更（仅当 Step 3b 识别到时出现）
- 写入点 `SomeWriter.write` (path/file:NNN) 新增/改变对共享状态 {KV/cache/event} 的写入{（过滤了某子集）}
- 读取入口 `SomeReader.lookup` (path/file:NNN) — 变更后可查到该状态（原查不到）{或反之}
- 可见性变化: 查不到 → 查得到 → 读取方分支可能从"缺席回退"切到"已就绪处理"{或反之}
- → 建议: behavior-regression reviewer（若在团队）追踪读取分支变化；否则 architect/backend 追踪

### 风险评估
- **高**: Auth 类型变更可能破坏 API 消费者
- **中**: 新中间件影响请求流

### 建议 Reviewer 关注方向
- Architect: 审查边界跨越和契约变更
- Security: 审查认证流程变更
```

## Integration with Review Flow

The impact analysis feeds directly into:

1. **Phase 3 (Tech Lead Analysis)**: Uses impact findings to identify risk areas and select reviewers
2. **Phase 4 (Spawn Reviewers)**: Impact analysis included in reviewer context as navigation tips
3. **Reviewer guidance**: Each reviewer receives relevant impact findings with "该查哪里" directions

This replaces the standalone Code Review Map by making architectural analysis an integral part of every review, rather than a separate workflow.
