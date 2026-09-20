# 简化重构记录：2026-09-20

本轮实施盘点中的职责拆分与重复逻辑合并。统计基线是任务开始时的工作区，包含当时已有的未提交修改。

## 改动

- CLI：computer-use 与 computer-e2e 共用参数扫描器；computer-use 共用 JSON 输出、默认会话工厂和 batch 文件处理。session 路由与单次动作分发各有明确入口。
- PBench：从 authoring 提取工作区解析、Git 操作、文档生成与观察记录。capture/replay 共用 Git helper，两个观察文档共用渲染函数。测试按 capture/runs 拆分，共用按测试文件隔离的 fixture。
- 会话执行：host 提取 driver、batch 与状态恢复；exec 提取 worker 启动、RPC 分发和控制流读取。原模块继续负责请求生命周期。
- Runtime：提取驱动结果解析、取消/超时控制、自动租约；截图持久化归入 artifacts。合并 batch 的 key/type 前置检查，移除 20 步上限后不可达的 500 步检查。
- 协议：提取基础字段校验，保留原入口导出。

## 保留的边界

- runtime 与 wire 校验的字符串长度、未知字段规则不同，继续分别校验。
- 单次命令的每个会话仍各自持有租约；batch 命令原有的租约作用域保留。
- session batch 的文件读取/JSON 错误仍原样返回；单次 batch 仍使用结构化错误。增加回归测试，确认无效文件不会联系 host。
- 取消、动作送达分类、状态提交、fd 与进程组清理的规则保持原有顺序。
- 原有 83 个 PBench 测试名称全部保留。

## 规模

| 主文件 | 重构前 | 重构后 |
| --- | ---: | ---: |
| PBench authoring.ts | 1,541 | 855 |
| session host.ts | 1,567 | 1,074 |
| session exec-runner.ts | 1,450 | 935 |
| runtime session.ts | 1,410 | 1,086 |

主文件的减少包含迁移到新模块的代码。第一轮计入全部新模块后，`packages` 实现代码从 **19,886 行变为 19,975 行，净增加 89 行**。后续删减 **126 行**，当时为 **19,849 行，比任务开始少 37 行**。架构收敛后为 **19,737 行，比任务开始少 149 行**。职责拆分的接口与接线成本抵消了多数局部删减，**没有达到 ultra-simplify 的 40% 总行数减量目标**。

实现代码计数命令（排除声明文件；不含测试、生成构建产物与第三方代码）：

```sh
rg --files packages -g '*.ts' -g '!*.d.ts' | xargs wc -l
```

## 后续实际删减

此次修改 6 个实现文件，新增 134 行、删除 260 行，净减 126 行；没有新增模块或删除测试。

- 从各命令的允许旗标推导总清单，删除第二份手工维护的旗标列表。
- batch/exec 共用预算参数解析，分别保留 20/500 的动作上限。
- 命令分发直接传递已有请求，删除逐字段重建。
- session status/close 共用查找、元数据校验、关闭态处理和连接失败处理；cancel 保留原错误路径。
- batch 回执共用写入逻辑，删除未使用的错误参数；保留先持久化再标记完成的顺序。
- 删除 exec CLI 中计算后直接丢弃的哈希，去重仍由 host 执行。
- 协议解析合并相同条件分支和回复构建；删除 JSON 值校验后重复的字节检查，以及已限定长度的纯十进制字符串转 BigInt 的不可达失败分支。
- NDJSON 分帧使用 split，继续保留末尾未完整帧、UTF-8 校验和每帧字节上限。

## 架构收敛

用户确认继续实施后，集中处理执行流程和状态归属：

- 三个 batch 入口共用 runtime 的 `executeBatchSequence`。它拥有开始前检查、持久化后再检查、逐步 dispatch、回执和未执行尾部的生成顺序。删除 CLI、host、exec 中各自的循环。
- `standalone`、`hosted`、`script` 表示现存三种错误语义：独立命令仍由外层接管 dispatch 异常；host/script 保留 unknown 回执与尾部原因；script 保留全局动作索引。最终观察的错误语义不同，继续由各自调用方处理。
- `createJournalWriter` 统一事件序号管理。同一请求的写入串行执行，成功才递增；失败不消耗序号，也不阻止记录后续失败。原有 append/read/claim 接口和日志格式保留。
- `createExecDispatch` 拥有回执、观察记录和观察新鲜度。调用方每次只提交索引、方法和参数。移除逐调用的 context 接线、外部 mutation 回调和冗余的 scriptObserved 状态。预算、worker 生命周期和状态提交仍由 runner 管理。
- PBench 的 summary/metrics/events 和运行记录从 `saveRunState` 统一发布。保留写入顺序、字段与 blocked 路径。home 记录负责手动运行恢复，artifact 记录服务报告读取；这次没有改成多文件原子提交或事件溯源存储。

本轮实现代码 **19,849 → 19,737，净减 112 行**。新增回归测试覆盖日志耗时阻止后续 dispatch、回执写入失败、脚本动作索引、缺失 driver 状态的分类，以及日志失败后的序号恢复。未删除已有测试。

## 验证

- `bun run typecheck`
- `bun run test`：718 pass，17 skip，0 fail
- `bun run build`
- `bun run smoke`
- `git diff --check`

默认测试包含真实 Unix socket，需要允许本地 IPC。17 项测试按现有原生/打包测试条件跳过。
