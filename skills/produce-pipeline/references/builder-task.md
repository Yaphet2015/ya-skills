# Builder 任务卡与交付

Planner 为每个可独立验收的结果填写一张卡，Leader 保留已决策契约派发；调整时限等执行元数据时记录原因。契约未定时先返回 Planner，不能把设计工作隐含交给 Builder。

## 任务卡

```text
task_id / unit / repo / run:
目标：一个可验证结果
Plan：绝对路径、版本/哈希、相关条款（全文按需读取）
基线与原有改动：起始 commit、不可覆盖的文件/hunks
前置验收：实际 task-id、accepted_at、已交付接口；未满足时标 pending
已决策契约：直接写出接口签名、输入/输出、状态归属及关键约束
允许修改：文件及唯一写入者；并行子任务各自的文件
必要读取：绝对路径 + 符号或行段 + 要核对的问题
来源：接口摘要对应的 commit/文件哈希、已验证事实与证据路径、尚未解决的问题
固定行为：输入/动作 → 预期结果 → 对应测试或证据
首个行动：直接实施或验证哪个已确定的行为
首个里程碑：预期补丁、具体阻塞诊断或测试结果；检查点路径
预算：准备/实现/测试/恢复时间估计、执行器实测记录或“无基线估算”、本次 --timeout
测试：授权命令、适用用例、已通过且可复用的证据
交付：代码/commit、行为证据、剩余问题、指定 result.json
```

任务卡以内联的局部契约为准。先核对相关来源的版本/文件哈希；发生变化时读取受影响符号，确认接口仍成立，有具体缺口才扩大读取。默认不复制完整源码到卡片。先读取所列符号和相邻必要上下文，不整份读取大型测试文件、全量 Plan 或历史报告。扩大读取前说明具体未决问题；已有且来源仍有效的决策不再调查；源文件有变化不等于整个 Plan 失效。缺少契约时返回 needs_decision，并指出缺口。子工作者只接收其文件范围、共享契约和行为用例。

## 执行与恢复

新会话先读 [执行控制](execution.md)，按任务中提供的 helper、attempt 和 unit 写 checkpoint、ack、gate。同会话补交只读新指令和当前纠正，不重复加载完整协议。压缩前保存已完成事实、有效证据和下一动作；恢复先读该检查点，不重新搜索计划路径。遵守任务权限，缺少工具或权限返回 blocked。

Builder 负责代码检查、simplify、相关测试和本地 commit，不 push；子工作者不操作共享 Git index。交付 summary 简短说明结果和未解决问题，原始测试日志与详细报告用绝对路径引用，避免将全文返回 Leader。结果最小结构：

```json
{
  "task_id": "任务指定的 ID",
  "status": "completed",
  "summary": "完成范围、关键验证、剩余问题的短结论",
  "artifacts": ["/absolute/run/behavior-evidence.md"],
  "commits": [],
  "corrections": {}
}
```

status 可为 completed、needs_decision、needs_changes、blocked。必填 task_id、status、summary、artifacts；有纠正时按 execution.md 填 revision 和 evidence 并实际 ack。测试失败不能写 completed。只有 Leader 验收后才可作为后续任务的已接受依赖。

仅说明补交时，使用本次新 result 路径；复用原代码和有效测试证据，不能覆盖旧回执、改代码、提交或重跑测试。发现实现缺陷则返回 needs_changes，交 Leader 安排实现修复。
