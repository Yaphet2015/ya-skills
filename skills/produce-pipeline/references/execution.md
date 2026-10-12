# 执行控制

Leader 和 Builder 在首次实施前读取。本页定义运行控制；角色和模型仍按 SKILL.md。所有命令使用 init 保存的 `run/skill/scripts/pipeline.py`。

## 小任务与预算

Plan 按可独立交付的行为单元提供任务卡，采用 [Builder 任务卡](builder-task.md)。每卡只要求一个可验证结果，直接写出已决策接口、允许文件、必要调用点和固定行为用例，不能只给整份 Plan 链接。Builder 先读卡中的局部契约；需要扩大读取范围时，先写明尚未解决的问题。不要整份读取大型测试文件或历史报告来“熟悉项目”。

模块 ID 作为 `--unit`。同模块拆成存储、调用方、测试等任务，或替换会话，仍沿用同一 unit；不能为重置预算创建新模块。一个 unit 的外部 Builder 串行运行，Builder 可派生共享此次预算的原生工作者。

默认每 unit 累计运行 3600 秒，失败后最多重试 3 次；完成的子任务和说明补交都消耗时间。实现失败、异常退出和需要技术决策的返工消耗实现重试预算；缺失或无效交付、未确认纠正标为 delivery，补交单独计数，见下文。Builder 的单次 `--timeout` 不能超过该 unit 的剩余时间。10 分钟没有有效检查点时，执行器发出 inspection_needed 事件，任务保持运行，由 Main Agent 探查；该阈值不触发终止，也不计为失败。预算在 Plan 阶段按风险、工作量和测试时长确定，例如：

```sh
python3 /absolute/run/skill/scripts/pipeline.py budget --run /absolute/run --unit attachments --seconds 3600 --idle-seconds 600 --max-retries 3 --reason 'Plan A: two commits and attachment regressions'
python3 /absolute/run/skill/scripts/pipeline.py launch --run /absolute/run --unit attachments --task-id build-owner --role builder --prompt /absolute/task.md
```

预算参数省略时保留原值，首次创建才使用默认值；命令返回 before/after/changed，失败不改写预算。预算调整保留原因与历史，不能删除历史尝试。已有执行后扩大预算，或从连续无进展恢复，`budget` 必须附 `--evidence /absolute/diagnosis.md` 提供新的诊断证据；旧证据不能反复续期。用尽后先结案为阻塞；只有新增有效证据支持新的执行方案时，Leader 才能记录预算调整并恢复，不能仅以“尚未完成”自动续期。Plan 的总时间预算另外覆盖规划、Hook 和所有验证子任务；模块限制不替代总预算。Planner 参考同一执行器历史尝试的准备、实施与测试耗时，另列恢复余量；无可靠基线时标为估算，不套固定损耗比例。卡片时限与实际 --timeout 必须一致，Leader 调整时在新 attempt 派发信息中记录原因。

两次连续被确认无进展的实现尝试，不再自动派新 Builder。仅缺少 checkpoint 的提醒不算无进展失败。先区分：范围过大、未决契约、上下文丢失、进程退出、环境失败。重试卡必须说明上一轮停点、保留成果、本次改变和预期的新信号。同样输入、同样等待不算恢复方案。验证阶段原有的 3 轮修复上限仍独立生效。

## 自动监控与精简输入

`launch` 内部持续检查进程退出、累计运行时限和检查点提醒阈值。只有实际运行时限耗尽才按 timeout 回收进程组；检查点超期只通知 Main Agent。标准输出是简短 JSON 事件，只在启动、有效检查点、检查点超期提醒、纠正确认变化和终态变化时输出；原始模型日志保留在 attempt/run.log。Leader 不运行逐分钟 `sleep → status → tail → diff` 循环。

启动后使用宿主的后台任务与完成通知机制等待该次调用；独立任务可继续推进。需要重连已有运行时，后台运行一个 `watch --run /absolute/run`，它自动检查 launcher 锁和状态变化；launcher 失联时核验工作进程身份和已记录的嵌套工作进程，仍存活时继续观察。所有任务结束且无已确认存活的工作进程后退出；失联且身份未知时等到 watcher 时限，报告人工核查。watch 不启动模型、不杀历史 PID，也不替代 launch 的超时控制。不要同时启动多个 watcher，或同时订阅 launch 与 watch 的重复事件。宿主没有主动通知能力时，只使用它要求的最少次数等待/取回调用；无新事件就继续等待，不追加源码、日志或 diff 检查。

`status` 默认只返回任务终态、短错误、检查点、纠正版本/确认情况及模块剩余时间。恢复或收到异常事件时调用一次；只有具体问题需要取证才用 `status --task-id build-owner --verbose`。不要把完整 execution、Plan、报告或 diff 当心跳读入主会话。

Leader 的工作上下文以任务依赖、验收条款、已决策接口、短交付和未解决问题为主。运行中不追踪 Builder 的每次读文件和代码修改。详细代码核对由 Builder/Ultraviewer 完成；Leader 放行时核对行为证据和责任角色结论，遇到矛盾再定点打开对应差异或原始证据，保留最终放行责任。

收到 inspection_needed 后，Main Agent 核对当前工具调用、任务所属进程与子进程、权限等待、近期测试输出和必要的改动证据。明确区分“准备执行 typecheck”和“typecheck 已启动”。任务在正常执行时继续等待并要求 Builder 在合适时记录检查点；忘记记录时补记真实证据；确认卡住或异常后才决定干预。检查期间不因提醒自动停止任务。相同缺失区间不重复播报；有效检查点清除提醒，之后再次超期才产生新的探查周期。若只是再次观察到同一事实，不伪造检查点来清除提醒。

状态优先级：终态/退出错误 → launcher 失联（interrupted）→ 待探查提醒/未确认纠正 → 有效检查点。状态另列 launcher_state 和 worker_state；工作进程 alive 不改写既有终态。身份由 PID、启动标识和进程组核验；PID 复用、权限不足、缺失身份记录或无法确认归属的残留进程显示 unknown。旧日志中的 thinking 和单纯进程存活都不能覆盖失败结论。检查点摘要重复、时间流逝不会生成新事件。

确认失联任务的进程及副作用已核对后，显式记录恢复依据：

```sh
python3 /absolute/run/skill/scripts/pipeline.py reconcile --run /absolute/run --task-id build-owner --processes-checked --reason 'Owned processes ended; inspected Git diff and artifacts; no duplicate side effects'
```

命令不会杀历史进程，也不代替现场检查。已确认所属工作进程仍存活时拒绝 reconcile；unknown 时必须现场检查并记录依据，不能只凭 PID 消失或日志陈旧推断结束。终态失败直接按已记录原因处理，不用 reconcile 改写它。恢复前先检查是否已经生成 commit、测试或报告；不能重放完成的操作。

对用户报告状态变化、已验收产物、累计无进展时间和下一处置条件。不要每分钟重复“继续监控”，也不能仅凭进程存在就声称“正常推进”。

## 可恢复的检查点

执行器把绝对运行路径、任务路径、结果路径、unit 和时限附在启动任务中。Builder 在首个有效诊断、补丁或测试里程碑后，以及上下文压缩前写检查点：

```sh
python3 /absolute/run/skill/scripts/pipeline.py checkpoint --run /absolute/run --attempt /absolute/run/tasks/build-owner/attempt-0001 --summary 'Owner contract verified against its callers' --next 'Implement the owner union and regression' --evidence /absolute/run/owner-contract.md
```

检查点记录当前 fingerprint、证据哈希、已完成事实和下一动作。只有工作区内容变化或新的证据内容才更新进展时间；重复摘要、改文件名、轮询日志不延长预算。原始 Agent 日志和控制文件不能作为有效进展证据。证据真实性由 Leader 核对，文件存在不等于诊断成立。

恢复先读原任务、最近检查点和当前纠正，核对 Git；只补读下一动作所需的符号或行段。不要重新寻找已提供的路径。长时间测试应在启动前配置合适时限，保存真实测试进展；不能用心跳文件让无进展任务永远存活。

## 纠正必须确认

任务卡在单次 attempt 内不可变；重试可使用记录了停点和调整原因的新卡，旧卡保留。脚本保存启动哈希；改写启动卡会阻止完成和验收。Leader 不追加旧卡来冒充消息，使用独立纠正账本：

```sh
python3 /absolute/run/skill/scripts/pipeline.py correct --run /absolute/run --unit attachments --task-id build-owner --issue quick-occupancy --message 'Preserve draft-reference occupancy, including an empty or missing snapshot; prove with regression evidence'
```

`--task-id` 只约束目标任务及其重试，适合下游实施指令；省略时约束整个 unit，保留旧命令语义。新 task 可提前发布纠正，但已存在 task 必须属于该 unit。影响整个 unit 契约的纠正仍会阻止相关上游依赖放行，须先修复并重新验收上游，不能删除 --after 绕过。

误发纠正使用 `retract --run /absolute/run --unit attachments --issue quick-occupancy --revision 1 --reason '误发原因'`。撤回必须匹配当前版本，记录原因并保留历史；已验收或已撤回版本不能再次撤回。重新发布同 issue 会递增 revision，使旧确认失效。同 issue 不允许更换作用域，应撤回并使用新 issue。验收只关闭当前任务适用的纠正。

命令返回 issue 和 revision，但返回值只代表已发布。Builder 在读取新纠正后执行：

```sh
python3 /absolute/run/skill/scripts/pipeline.py ack --run /absolute/run --attempt /absolute/run/tasks/build-owner/attempt-0001 --issue quick-occupancy --revision 1
```

Builder 在开始编辑、测试、提交和交付前检查纠正账本，只处理未验收、未撤回且作用域为本 task 或整个 unit 的条目。若宿主支持同会话消息，Leader 通知其读取账本；否则等待受控检查点。下一个检查点或交付事件仍未确认时，Leader 将其报告为未送达；执行器在检查点超期时提醒 Main Agent 探查，不能放行依赖任务。确需替换会话时，先核对并停止本次拥有的执行，再把最新纠正作为新尝试的启动输入；预算保持不变。

确认仅表示收到，不表示修好。Builder 在 `result.json` 中记录处理证据：

```json
{
  "corrections": {
    "quick-occupancy": {
      "revision": 1,
      "evidence": ["/absolute/run/quick-occupancy-test.log"]
    }
  }
}
```

这是完整结果对象的附加字段。提交前先写包含此字段的结果草稿，然后执行 gate；提交后补齐最终 commit、检查结果和 status：

```sh
python3 /absolute/run/skill/scripts/pipeline.py gate --run /absolute/run --attempt /absolute/run/tasks/build-owner/attempt-0001
```

未确认当前版本、缺少处理证据时 gate 失败。执行器在结束时再次检查，问题未处理则结果记 needs_changes。新纠正发布后旧版本确认失效。gate 不拦截任意 Git 命令，Builder 必须遵守上述提交路径。

## 验收与提前审查

Leader 核对固定行为用例、每个必修项和 Builder/Ultraviewer 的证据结论；有矛盾时定点检查对应 diff。不能仅凭 completed 或测试总数放行。关键用例在实施前确定，修改预期必须给出原需求依据。报告中的数量以实际测试输出为准，交付后不要覆盖原证据。

完成语义验收后执行：

```sh
python3 /absolute/run/skill/scripts/pipeline.py accept --run /absolute/run --task-id build-owner
```

命令核对当前纠正版本、交付文件哈希和仓库 fingerprint，记录 accepted_at 并关闭已验证的纠正。产物或工作区变化时先复核受影响证据。仅说明/回执需要补正时使用下面的补交入口；代码需要修复则按实现重试处理。不要修改旧结果来绕过门槛。accept 的机械校验不能判断测试断言是否正确，Leader 的语义验收不可省略。

后续任务的每项前置依赖必须通过可重复的 `launch --after <task-id>` 声明（例如 `--unit attachments --task-id build-views --after build-owner`）。脚本在启动前检查前置任务的最新尝试是否已验收，并绑定该验收记录；依赖在运行中重做或证据变化会阻止交付和验收。任务卡还须引用实际接口。前置工作未完成时只能准备 pending 卡，不能把预计成果写成事实。独立模块稳定后可提前派 Ultraviewer 审查固定 Git 范围，复用其有效证据；最终 Verify 仍补齐覆盖矩阵和跨模块集成。不要每个小提交都重跑全量审查和报告 Hook。

简化任务记录：删除的独立状态/搬运/同步责任、新增的派生或适配逻辑、保留的行为及证据。代码行数和测试数量只作辅助信息。

## 仅补交说明或回执

代码和测试证据已成立，仅 result.json 缺失/格式错误、说明过时或纠正确认遗漏时，用原 task-id、原 unit：

```sh
python3 /absolute/run/skill/scripts/pipeline.py launch --run /absolute/run --task-id build-owner --unit attachments --role builder --redeliver --prompt /absolute/receipt-fix.md --timeout 300
```

提示只写待修正字段、纠正版本及有效证据路径。执行器从 logoscode 的 JSON 事件捕获实际 session ID，用 `--session` 续接原会话；不使用“最近会话”。新尝试有独立任务和结果文件，旧交付/证据哈希须保持不变。补交不能修改代码、提交或重跑测试；工作区 fingerprint 变化或旧证据被覆盖会阻止验收，不自动回滚。实际需要改代码时回到实现流程。

每 unit 最多两次补交，共享累计时间，单独记在 `delivery_attempts`，不计入实现重试数；重复创建普通任务也不能无限绕过 delivery 失败限制。补交仍检查依赖、纠正确认和证据。原会话不可恢复或旧运行未捕获 ID 时，必须提供 `--fresh-session-reason '具体原因'`，并附短交接（已完成事实、有效证据、待补字段），才可建立替代会话；不因一次续接失败就自动重做实现。
