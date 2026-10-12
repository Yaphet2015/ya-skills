# code-review-graph 集成指南

Ultra CR 与 code-review-graph 知识图谱的集成参考。

## 核心定位

**Graph 是指南针，不是显微镜。**

- **Graph → 快速定位"该查哪里"**（导航加速器）
- **Diff → 分析"改了什么"**（主要分析源）
- **Grep/Read → 深入"具体怎么写的"**（细节分析）

三层协作，互不替代。Graph 让 reviewer 更快到达正确的文件面前，但发现 SQL 注入、代码味道、逻辑 bug 仍需读代码。

## 能力边界

> 完整的能力边界说明参见 本文末尾 §Knowledge Graph Integration。
> 以下为快速参考。

### Graph 能做的（结构级）

- 调用链追踪（callers_of / callees_of）、影响半径、执行路径
- 测试覆盖匹配（tests_for）、跨层边界违规检测
- 过深调用链检测、循环依赖检测、模块间导入关系
- 架构热点定位（hub_nodes：总度数最高节点，变更爆炸半径大）
- 架构瓶颈定位（bridge_nodes：betweenness centrality，断裂致多区域失联）
- 意外耦合检测（surprising_connections：跨社区/跨语言/边缘直连 hub，grep 做不到）

### Graph 做不到的（细节级，必须靠 Diff/Grep/Read）

- MyBatis XML SQL 注入（XML 不在图谱中）
- 语句级 bug（null 检查、逻辑错误）、硬编码密钥
- 配置文件分析（yml/properties 不在图谱中）
- 代码味道检测、并发安全问题、注解参数/字符串常量中的安全风险

## 工具速查

| 工具 | 用途 | 推荐参数 | 导航/分析 |
|------|------|---------|-----------|
| `list_graph_stats_tool` | 可用性检测（区分 server 不可用 / 图未构建） | 无参数 | 导航 |
| `get_minimal_context_tool` | 入口上下文（~100 token，stats+risk+建议工具，Phase 2/3 复用） | task=..., base=$FIRST_COMMIT^, changed_files=[...] | 导航 |
| `get_architecture_overview_tool` | 架构概览 | detail_level="minimal" | 导航 |
| `detect_changes_tool` | 风险评分变更分析（聚合受影响函数/flows/测试缺口） | base=$FIRST_COMMIT^, changed_files=[...], detail_level="minimal" | 导航 |
| `get_impact_radius_tool` | 爆炸半径（上游/下游依赖，文件级） | changed_files=[top-N 函数所在文件], base=$FIRST_COMMIT^, detail_level="minimal" | 导航 |
| `get_affected_flows_tool` | 受影响执行路径 | changed_files=[...], base=$FIRST_COMMIT^（⚠️ 无 detail_level） | 导航 |
| `query_graph_tool(pattern="callers_of")` | 上游调用方 | target=函数名, detail_level="minimal" | 导航 |
| `query_graph_tool(pattern="callees_of")` | 下游依赖 | target=函数名, detail_level="minimal" | 导航 |
| `query_graph_tool(pattern="tests_for")` | 测试覆盖 | target=函数/类名, detail_level="minimal" | 导航 |
| `query_graph_tool(pattern="imports_of")` | 模块导入 | target=模块名, detail_level="minimal" | 导航 |
| `query_graph_tool(pattern="children_of")` | 文件内函数/类列表 | target=文件名, detail_level="minimal" | 导航 |
| `semantic_search_nodes_tool` | 语义搜索 | query=关键词, detail_level="minimal" | 导航 |
| `get_review_context_tool` | 精简源码片段 | changed_files=[...], base=$FIRST_COMMIT^, include_source=True, max_lines_per_file=200, detail_level="minimal" | 导航→分析过渡 |
| `get_knowledge_gaps_tool` | 结构级弱点（孤立节点/无测试热点/单文件社区） | 无参数 | 导航 |
| `find_large_functions_tool` | 超长方法定位 | file_path_pattern=..., min_lines=200 | 导航 |
| `get_hub_nodes_tool` | 架构热点（总度数最高的节点，变更爆炸半径大） | top_n=10（⚠️ 无 detail_level） | 导航 |
| `get_bridge_nodes_tool` | 架构瓶颈（betweenness centrality，断裂致多区域失联） | top_n=10（⚠️ 无 detail_level，>5000 节点用采样近似） | 导航 |
| `get_surprising_connections_tool` | 意外耦合（跨社区/跨语言/边缘直连 hub，grep 做不到） | top_n=15（⚠️ 无 detail_level） | 导航 |
| `traverse_graph_tool` | token 预算受控的 BFS/DFS 图遍历 | query=..., mode=bfs, depth=1-6, token_budget=2000 | 导航 |
| `refactor_tool(mode="dead_code")` | 孤儿代码检测（无调用方/测试/导入，非入口点） | mode="dead_code", file_pattern=变更路径（⚠️ 仅检测，apply_refactor_tool 审查中禁用） | 导航 |

注意: 所有 graph 工具都是"导航"性质——它们告诉你位置和关系，不告诉你代码有没有 bug。发现 bug 是 Diff/Grep/Read 的工作。
注意: `get_affected_flows_tool` 没有 `detail_level` 参数，调用时不要传该参数，否则会报错。
注意: `get_hub_nodes_tool` / `get_bridge_nodes_tool` / `get_surprising_connections_tool` / `traverse_graph_tool` **均无 `detail_level` 参数**，无法压缩输出，必须用 `top_n` / `token_budget` 控制成本，且**严格条件触发**（仅 risk_score >= 0.7 时）。
注意: 涉及变更范围的工具（detect_changes/get_impact_radius/get_affected_flows/get_review_context/get_minimal_context）**必须传 base=$FIRST_COMMIT^ 和 changed_files**，否则默认只分析最后一个 commit（HEAD~1），全量审查场景下数据严重失真。
注意: `hub_nodes`/`bridge_nodes`/`surprising_connections` 是**全图静态分析**（不随本次变更变化），返回结果需与本次变更做**交集过滤**后才有针对性，否则是与本次变更无关的噪声。交集过滤用 `git diff --name-only` 变更文件列表匹配节点的 `file` 字段为主（因 `detect_changes_tool` minimal 模式不返回 `changed_functions`），辅以 `review_priorities` 函数名匹配。

## context_savings 元数据

`detect_changes_tool`、`get_review_context_tool`、`get_impact_radius_tool`、`query_graph_tool` 的返回**自带 `context_savings` 字段**：
```json
"context_savings": {"estimated": true, "saved_tokens": 12932, "saved_percent": 94}
```
基于 4 chars/token 估算（保守、标注 estimated）。Graph Usage Log 应记录此字段以量化 graph 的 token 节省效果。小变更时 `saved_percent` 可能为 0 或负（graph context 反而比直读大），此时文案兜底为"本次变更较小，图谱开销与直读相当"。

## Graph 优先原则

当 graph 可用时，**结构定位类任务优先使用 graph**：

| 任务 | Graph 优先 | Grep 补充 | 原因 |
|------|-----------|-----------|------|
| 追踪"谁调用了这个函数" | `query_graph_tool(callers_of)` | `grep -r "import.*file"` | graph 精确到函数级，grep 只能按文件级 |
| 追踪"这个函数调用了谁" | `query_graph_tool(callees_of)` | 读 import 语句 | graph 自动追踪，grep 需逐文件分析 |
| 判断"有没有测试" | `query_graph_tool(tests_for)` | `grep -rl "test.*ClassName"` | graph 精确匹配，grep 可能漏或误匹配 |
| 判断"影响范围多大" | `get_impact_radius_tool` | `grep -r "ClassName"` | graph 给出完整依赖链，grep 只有文本匹配 |
| 判断"跨了哪些层" | `get_affected_flows_tool` | 目录结构推断 | graph 追踪真实调用链，目录推断不可靠 |
| 搜索"SQL注入风险" | ❌ graph 不覆盖 | `grep -E '\$\{' --include="*.xml"` | XML 不在图谱中 |
| 搜索"硬编码密钥" | ❌ graph 不覆盖 | `grep -iE 'password|secret|key'` | 语句级问题，graph 无法感知 |
| 搜索"配置引用" | ❌ graph 不覆盖 | `grep -rl "beanName" --include="*.xml"` | 配置文件不在图谱中 |

## Token 效率规则

1. **始终使用 `detail_level="minimal"`** — 除非 minimal 输出明显不足以定位问题
2. **批量查询** — 对多个变更文件，优先用 `detect_changes_tool` 一次获取所有风险评分，而非逐文件查询
3. **导航提示而非原始输出** — 给 reviewer 注入的是导航提示（方向指引），不是 graph 的原始查询输出
4. **Graph 缩小范围，Diff/Grep 做精准分析** — 先用 graph 定位关键文件，再用 Grep/Read 深入，比全仓库 grep 扫描高效得多
5. **控制导航提示 token 预算** — 每个 reviewer 的导航提示控制在 500-800 token 以内，只包含与该 reviewer 角色相关的导航信息
6. **工具调用软预算 ≤8 次** — 单次审查 graph 工具调用总数不超过 8 次（含 list_graph_stats + get_minimal_context + detect_changes + ...）。code-review-graph 官方目标 ≤5 calls / ≤800 tokens，ultra-cr 因多 reviewer 场景放宽到 8 次。接近预算时，Phase 3 Step J 的 hub/bridge/surprising 可 skip（记录原因到 Graph Usage Log）。统计口径：每个 `_tool` 调用计 1 次，skip 不计入实际调用但需记录。

## 典型协作流程

### 场景: Java 项目认证模块变更

```
1. Tech Lead 用 graph 导航:
   detect_changes_tool → AuthService.login() 风险评分 0.82（0-1 浮点数，>=0.7 为高风险）
   get_impact_radius_tool → 上游: AuthController, MobileAuthController
                       下游: UserRepository, LdapClient
   get_affected_flows_tool → HTTP → AuthController → AuthService → UserRepository

2. Tech Lead 生成导航提示给 Security reviewer:
   "AuthService.login() 在认证核心路径，风险评分 0.82（安全敏感+无测试+跨社区调用）
    上游: AuthController, MobileAuthController → 检查认证流程完整性
    下游: UserRepository → ⚠️ graph 不覆盖 MyBatis XML，需 Grep/Read 检查 SQL 参数化
    下游: LdapClient → 检查外部调用容错"

3. Security reviewer 按导航深入:
   Grep/Read → AuthController.java → 发现缺少 CSRF token 验证
   Grep/Read → UserMapper.xml → 发现 ${name} 拼接 → SQL 注入
   Grep/Read → LdapClient.java → 发现缺少连接超时配置

4. graph 导航让 reviewer 节省了全仓库搜索的时间，
   直接定位到 3 个关键文件，Grep/Read 发现了 3 个细节级问题。
```

## 降级检查清单

当 graph 不可用时，确保以下行为与无 graph 版本一致：

- [ ] Phase 1: discovered-standards.md 标注图谱不可用
- [ ] Phase 2: 影响分析使用 grep -r 追踪依赖
- [ ] Phase 3: 自动检测使用 grep -ilE 扫描关键词
- [ ] Phase 3: 无风险评分，无测试覆盖缺口分析，无 hub/bridge/surprising 检测（均依赖 risk_score >= 0.7 触发，无 risk_score 即不触发）
- [ ] Phase 4: reviewer context 不包含导航提示和探索指南，无 dead_code 检测
- [ ] Phase 4: reviewer 使用 Grep/Glob/Read 探索 codebase
- [ ] context.md 的 Graph Usage Log 仅写一行"graph 未启用，本次审查未使用图谱工具"
- [ ] Phase 8 不展示 Graph 使用汇总，仅提示"全程使用 grep"
- [ ] 所有输出文件格式不变
- [ ] IRON LAW 不受影响

## Graph 查询失败处理

> 完整的降级策略参见 SKILL.md §Graceful Degradation。

- **单个工具调用失败**: 对失败部分回退到 grep，在 context.md 中标注
- **全部工具不可用**: 视为 graph 不可用，走完整降级路径
- **工具超时**: 跳过该查询，回退到 grep，记录超时事件
- **Graph 返回不完整数据**: 标注"graph 未覆盖"，提示 reviewer 用 Grep/Read 补充
- **Graph 数据过期**: 导航提示标注"graph 数据可能过期，请注意验证"

## Knowledge Graph Integration

When the code-review-graph MCP tools are available in the project, Ultra CR automatically uses them as a **navigation accelerator** — quickly locating "where to look" so reviewers reach the right files faster.

> **See also**: `references/graph-integration.md` — 完整的 graph 工具使用指南和能力边界说明。

### Core Principle: Graph Is a Compass, Not a Microscope

| Layer                           | Tool      | Best At                                                        | Not Best At                                 |
| ------------------------------- | --------- | -------------------------------------------------------------- | ------------------------------------------- |
| **Structural navigation** | Graph     | Call chains, impact radius, test coverage, boundary violations | Statement-level issues, XML/config content  |
| **Change analysis**       | Diff      | Code-level changes, logic defects                              | Dependency relationships, impact scope      |
| **Detail analysis**       | Grep/Read | SQL injection, hardcoded keys, MyBatis XML                     | Call chain context, cross-file dependencies |

**Graph tells reviewers WHERE to look. Diff/Grep/Read tells them WHAT's wrong.**

### What Graph Can Do (Structural-Level)

- `get_minimal_context_tool` — Ultra-compact entry context (~100 tokens: stats + risk score + suggested next tools). ALWAYS call this first per code-review-graph's official rule; result reused across Phase 2/3
- `list_graph_stats_tool` — Lightweight availability check; distinguishes "server unavailable" vs "graph not built" (empty/null stats)
- `query_graph_tool(callers_of/callees_of)` — Trace call chains precisely, including indirect dependencies; detect deep call chains (>5 levels) and circular dependencies
- `get_impact_radius_tool` — Calculate blast radius of a change
- `get_affected_flows_tool` — Identify affected execution paths across module boundaries
- `detect_changes_tool` — Risk-scored change analysis (aggregates affected functions, flows, test gaps in one call)
- `query_graph_tool(tests_for)` — Precise test coverage matching (grep cannot reliably do this)
- `query_graph_tool(imports_of)` — Trace inter-module import relationships
- `get_knowledge_gaps_tool` — Structural weaknesses: isolated nodes, untested hotspots, thin communities, single-file communities
- `find_large_functions_tool` — Locate oversized methods (>200 lines) for decomposition audits
- `get_hub_nodes_tool` — Architectural hotspots (highest total degree); changes to hubs have disproportionate blast radius. **Condition-triggered** (risk_score >= 0.7), with intersection filtering against the change set
- `get_bridge_nodes_tool` — Architectural chokepoints (betweenness centrality); if they break, multiple code regions lose connectivity. **Condition-triggered** + intersection filtering
- `get_surprising_connections_tool` — Unexpected architectural coupling (cross-community/cross-language/peripheral-to-hub); grep cannot detect this. **Condition-triggered** + intersection filtering (highest token cost, skip first when budget tight)
- `refactor_tool(mode="dead_code")` — Orphan code detection for deletion/refactor scenarios (no callers/tests/importers, not entry points). **Detection only** — `apply_refactor_tool` is forbidden in review (read-only). Watch for false positives (reflection/SPI/framework annotations)
- `traverse_graph_tool` — Token-budgeted BFS/DFS traversal for understanding full call context (available to reviewers in exploration guide)
- `get_architecture_overview_tool` — Community-based architecture overview with cross-community coupling warnings (disk-offload mode compensation)

### What Graph Cannot Do (Detail-Level, Must Use Diff/Grep/Read)

- MyBatis XML SQL injection (`${}` vs `#{}`) — XML is not in the graph
- Statement-level bugs (missing null checks, logic errors) — Requires reading code
- Hardcoded secrets/keys — Requires reading code content
- Configuration file analysis — yml/properties are not in the graph
- Code smell detection — Requires reading full method implementations
- Concurrent safety issues — Requires analyzing statement-level synchronization logic
- Annotation parameters / string constant security risks — Requires reading code content

### Integration Points

| Phase     | Graph Usage                                                                                                                                                                                                                                                                                       | Fallback (No Graph)                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Phase 1   | Detect availability via`list_graph_stats_tool` (distinguish server-unavailable vs graph-not-built) + `get_minimal_context_tool` for reusable global context                                                                                                                                   | Skip, proceed normally                                 |
| Phase 2   | `detect_changes_tool` + `get_impact_radius_tool` + `get_affected_flows_tool` + `query_graph_tool(tests_for)` + `get_review_context_tool`(disk-offload) + `get_architecture_overview_tool`(disk-offload) → navigation tips                                                            | `grep -r` dependency tracing (unchanged)             |
| Phase 3   | Risk-based reviewer selection +`query_graph_tool(tests_for)` coverage gaps + `get_knowledge_gaps_tool` + `get_hub_nodes_tool`/`get_bridge_nodes_tool`/`get_surprising_connections_tool` (condition-triggered, risk_score >= 0.7, intersection-filtered) + `find_large_functions_tool` | `grep -ilE` keyword scanning (unchanged)             |
| Phase 4   | Inject navigation tips (incl. hub/bridge/surprising hits) + graph exploration guide (incl.`traverse_graph_tool`) + `refactor_tool(dead_code)` for deletion scenarios into reviewer context                                                                                                    | No injection, reviewers use Grep/Glob/Read (unchanged) |
| Phase 5-7 | No graph integration                                                                                                                                                                                                                                                                              | N/A                                                    |
| Phase 8   | Display Graph Usage Log summary (incl.`context_savings` token savings + structural findings counts)                                                                                                                                                                                             | Show "全程使用 grep" only                              |

### Token Budget & Condition Triggering

- **Soft budget**: ≤8 graph tool calls per review (code-review-graph official target is ≤5; ultra-cr relaxes to 8 for multi-reviewer scenarios). When approaching budget, skip `get_surprising_connections_tool` first (highest cost), then `refactor_tool(dead_code)`, preserve hub/bridge/knowledge_gaps.
- **Condition triggering**: `hub_nodes`/`bridge_nodes`/`surprising_connections`/`knowledge_gaps`/`find_large_functions` only fire when `detect_changes_tool` shows `risk_score >= 0.7`. `refactor_tool(dead_code)` only fires when diff has >50 deleted lines or >30% deletion ratio.
- **Intersection filtering** (mandatory for static-analysis tools): `hub_nodes`/`bridge_nodes`/`surprising_connections` are whole-graph static analysis — results MUST be intersected with the change set to obtain change-relevant findings. Use `git diff --name-only` file list to match node `file` fields (primary), and `detect_changes_tool` minimal's `review_priorities` (top-3 function names) to match node `name` fields (secondary), since minimal mode does NOT return `changed_functions`. Unmatched results are noise and must be discarded.
- **`context_savings` utilization**: `detect_changes_tool`/`get_review_context_tool`/`get_impact_radius_tool`/`query_graph_tool` returns include a `context_savings` field (`{estimated, saved_tokens, saved_percent}`). Record this in the Graph Usage Log's "Saved Tokens" column and surface the aggregate in Phase 8 summary to quantify graph ROI.

### Graceful Degradation

- Graph availability is detected once in Phase 1, result stored in `discovered-standards.md`
- When graph is unavailable, all phases behave **identically to v1.1.0** — no degradation in quality
- **IRON LAW is unaffected** regardless of graph availability — all iron laws hold in both modes
- When a graph query partially fails, the failed portion falls back to grep, with a note in `context.md`
- When a graph query times out, skip that query, fall back to grep, record the timeout event
- When graph returns incomplete data, annotate "graph 未覆盖" in navigation tips, reviewers supplement with Grep/Read
- When graph data is stale (project modified but graph not updated), annotate "graph 数据可能过期" in navigation tips
- When all graph tools are unavailable, treat as graph-not-available, use full grep-only flow
- Graph does not replace Diff/Grep/Read — it accelerates navigation, then reviewers use Diff/Grep/Read for detail analysis

