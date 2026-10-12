# 运行与交接协议

## 操作

下列命令中的路径由 Leader 解析后替换；`pipeline.py` 使用安装位置下的绝对路径。preflight 只读，不启动模型，也不创建运行目录。

```sh
python3 /absolute/skill/scripts/pipeline.py preflight --repo /absolute/project
python3 /absolute/skill/scripts/pipeline.py init --repo /absolute/project --goal '任务目标' --dependencies-checked
python3 /absolute/run/skill/scripts/pipeline.py launch --run /absolute/run --task-id plan-module-a --role planner --prompt /absolute/planner-task.md
python3 /absolute/run/skill/scripts/pipeline.py launch --run /absolute/run --task-id build-module-a --unit module-a --role builder --prompt /absolute/task.md
python3 /absolute/run/skill/scripts/pipeline.py hook --run /absolute/run --name after-plan --key plan-v1 --context /absolute/context.json
python3 /absolute/run/skill/scripts/pipeline.py status --run /absolute/run
```

- preflight 搜索项目和用户的 `.agents`、`.claude`、`.coldx`、`.codex`、`.logoscode`、bangboo Skill 目录，以及 `CODEX_HOME/skills`。工具配置有其他根目录时，使用可重复的 `--skill-root`；init 必须传同样的根目录。
- 自动递归检查 `skill.json` 的 dependsOn。Leader 在启动前定点读取各 Skill 的依赖声明及必要相关段落，确认文档依赖；完整执行流程由负责角色在对应阶段读取，不提前把全部 Skill 正文加载到主会话。比如 grill-with-docs 要求 grilling 和 domain-modeling。依赖文档未提供路径时按相同搜索规则查找；任何必要依赖缺失立即结束。
- `--dependencies-checked` 是 Leader 对实际检查的记录，不是跳过检查选项。Main Agent 不受模型或宿主限制。可选 `--leader` 仅记录诊断标签，不选择模型、不校验身份；省略时记录 null。
- init 返回运行目录，保存本 Skill 的代码和协议快照到 run/skill，state.json 记录 helper 路径。此后统一调用该 helper 并读取快照内的协议，避免安装更新改变运行中任务的规则。变更命令会拒绝用其他版本 helper 操作该运行。旧运行没有快照时，保留旧 helper 到结案；不要在活跃任务中直接迁移协议。
- 脚本不修改项目、不操作 Git index、不提交。状态放在仓库外，避免工作记录污染 diff。baseline/ 保存起始 index/worktree patch 和未跟踪内容副本，用于保护原有 hunks。
- launch 在宿主工具中后台执行，自动监控进程、检查点和纠正；stdout 只输出状态变化事件，原始日志落盘。Leader 使用宿主完成通知等待，重连时可启动 `watch --run`；没有主动通知能力时只做宿主必要的最少等待调用，不另外轮询日志和 diff。默认单进程超时 3600 秒；Builder 还受共享模块预算约束；600 秒无有效检查点只提醒 Main Agent 探查，不终止任务，见 [执行控制](execution.md)。向用户报告有效状态变化、累计等待和下一处置条件，无变化时不重复播报。
- 跨 CLI 的外部子任务使用同一脚本、同一运行目录、不同 task-id。Planner 的挑战者使用该 Planner 会话的原生派生工具，等待完成后由 Planner 收集产物。验证任务由 Leader 按 Verifier 的任务卡分别派发，用 --after 绑定方案和实际验收记录；不嵌套在等待中的 Verifier 进程下。
- 所有 Planner 都是独立 coldx 会话，与 Main Agent 通过任务/结果文件交接；没有原生 Planner 优先或回退路径。挑战者属于 Planner 内部，使用其实际可用的原生派生能力。Main Agent 自身不需要派生工具。
- Planner 通过独立 `coldx exec -m gpt-6-astra -c 'model_reasoning_effort="medium"' --enable multi_agent` 启动；模型和思考强度固定，不继承 Leader。此开关仅作用于本次进程，不修改全局配置。Planner 和 e2e-Tester 的任务通过 stdin 传递，使用相同的结果文件协议。
- Skill 与模型选择通过实际路径和命令参数传递；Builder/Ultraviewer 不传 `-m` 或 `--variant`，沿用 logoscode 默认配置。
- 不默认启用危险跳过权限参数。无人值守进程若等待权限，报告阻塞，保留日志，由 Leader 在现有授权范围内解决；不把超时当完成。

## 任务文件

每次派工写任务文件。共同字段：task_id、parent_task_id（如有）、角色、目标、项目与运行目录、输入文件、允许修改范围、依赖、验收条件、输出文件。添加当前 Plan 路径与版本、基线 commit、已授权测试目标、用户原有改动清单。涉及仓库外产物时，Leader 先核对实际目标目录链上的 AGENTS.md，把适用规则和实际输出目录传给写入者；Planner 从一开始按最终 Plan 目录的语言与写作要求规划，Hook 按 hooks.md 检查并交付。Builder 使用 [任务卡模板](builder-task.md)，包含稳定的预算 unit、前置任务的实际验收记录、内联的已决策接口、不可变行为用例、首个可验证里程碑、精确读取范围和检查点路径。Plan 全文作为按需参考，不能要求 Builder 再次调查已决策内容。待完成的依赖标为 pending，不提前写成“已实现并提交”。

按需附 [角色任务](roles.md)，不要只发送 `/skill-name` 指令。执行者必须读取解析出的实际 Skill 文件及必要参考资料。外部 Agent 不一定能解析另一个工具的 slash 命令。

结果写到脚本指定路径：

```json
{
  "task_id": "build-module-a",
  "status": "needs_decision",
  "summary": "模块接口存在冲突；需要总 Planner 给出统一契约。",
  "artifacts": ["/absolute/run/interface-notes.md"],
  "questions": [{"id": "compat", "audience": "leader", "question": "请将接口冲突交总 Planner 整合。", "recommendation": "按已确认行为约束统一接口"}],
  "commits": [],
  "evidence": [],
  "session_id": null
}
```

结果必须包含 task_id、status、summary、artifacts（绝对路径数组）。其余按任务填写。summary 使用简短结论；大型 diff、测试输出、报告放 artifacts，通过路径引用。脚本检查基础格式及文件存在，Leader 负责内容验收。`completed` 不自动放行下一阶段。

Builder 的纠正确认、`result.corrections` 和 `accept` 门槛见 execution.md。任务文件在单次 attempt 内不可变；新 attempt 可携带记录调整原因的新任务卡。新指令放在独立的纠正账本，不能覆盖原任务卡来冒充实时消息。

Planner 与其他外部 Agent 一样，通过结果文件返回问题。Leader 按问题 ID 路由并将结论记录到 decisions.md：交互体验问用户，规划和跨模块技术争议交 Planner，计划内实现细节交 Builder，测试证据问题交 Verifier。Leader 决定派工和阶段放行，不代替责任角色重新设计。结论返回发问者。若 CLI 无可验证的会话恢复方式，使用原任务、已有产物和答案创建替代会话；明确告知已完成动作，禁止重复提交。Builder/Ultraviewer 的 session ID 由执行器从 CLI JSON 事件捕获，不能用 Agent 自报值、编造值或“最近会话”。仅补交说明时使用 execution.md 的 --redeliver，不开启完整的新实现任务。

## Leader 的状态账本

Leader 在运行目录维护 `progress.json`，原子替换写入。外部 Agent 只写自己任务产物，不修改此账本。

记录：current_stage、outcome、模块关系与 BFS 判断、plan_path、plan_version、Plan 内容 SHA256、已接受任务及 commit、Hook 完成记录、verify_attempt、repair_round（初次实现为 0）、连续无进展次数、未解决问题 ID、新增证据路径、当前验证对应的仓库 fingerprint。Plan 阶段确定本次总时间预算与各 unit 的分配；总预算用尽也进入收尾。模块耗时和失败次数直接读取 `status.units`，不能另写一份归零计数；区分无进展、执行异常、验收返工和验证修复原因。

阶段放行由 Leader 控制：

| 当前状态 | 下一步 |
| --- | --- |
| 初始化完成 | Before Plan → 独立 Planner 判断复杂度/BFS → 模块规划与整合 |
| Plan 通过 | After Plan → Before Impl → Builder |
| Impl 通过 | After Impl → Before Verify → Verifier |
| Verify 通过 | After Verify → Before Finish → 成功 |
| Verify 有问题且修复预算未用尽 | After Verify → repair_round 加 1 → Before Impl |
| 达到 3 轮或连续 2 轮无进展 | After Verify → Before Finish → 失败 |
| 首次实现耗尽时间/重试预算 | 保留已验收结果 → Before Finish → 阻塞；未进入 Verify 则不能伪造 After Verify 成功报告 |
| 任意阶段阻塞 | 记录阻塞；可解决则恢复，否则 Before Finish → 阻塞 |
| Hook 失败 | 不成功结案；只重试 Hook |

“无进展”指未减少未解决问题且未获得新增有效诊断证据；记录问题 ID、证据与理由。不能通过改写问题名称重置次数。

## 恢复和证据有效期

恢复时运行一次 status，默认返回精简摘要；定点诊断才用 --task-id 和 --verbose。需要持续观察时后台启动一次 watch，不由模型逐分钟调用 status。默认只展示每个 task-id 的最新尝试，历史尝试仍保留且计入预算。脚本保存执行前后 HEAD、fingerprint、起止时间、PID、进程启动标识/进程组、退出码、日志、结果和交付文件哈希。终态优先于日志内容；running 记录已无 launcher 锁则报告 interrupted，watch 继续观察身份已核验的所属进程并单独显示 worker_state；身份未知时报告 unknown。需要核对进程所有权和副作用，不能推断后台子进程也已消失。fingerprint 包含 staged、unstaged 和未跟踪文件内容；不包含被 Git 忽略的文件。因此 ignored 的构建产物或测试环境变化仍由 Leader 单独判断。

同任务正在运行时，文件锁阻止重复执行。嵌套 launch 继承父尝试标识并共享最外层外部阶段的进程组；超时使整个外部阶段失败，最外层 launcher 回收进程组，不依赖全机扫描或历史 PID。正常或异常退出也清理残留后台子进程。子 Agent 必须通过同一脚本启动外部任务并等待回收，不能自行脱离进程组后台运行。进程被杀后 execution.json 可能仍显示 running；先检查记录的进程及父子关系、日志和 Git，不能仅凭 PID 杀进程或重跑。用 `--retry` 创建新的尝试目录前，Leader 必须确认原执行已结束并核对已产生的副作用。已完成任务不因 hook 失败而重放。

Verify 和报告必须同时绑定 Plan 版本/哈希、仓库 fingerprint、测试环境及证据。Plan 或代码变更使受影响结果失效；status 的 workspace_changed_since_result 仅是机械提示，不代替此判断。

用户已有改动默认不动。需编辑同一文件时由 Builder 分离 hunks，提交前审查 staged diff；不能安全分离则返回 blocked。固定起始 commit 后，用 `git diff <起始commit> HEAD` 审查本次提交，同时核对工作区变化与初始快照，避免把原有脏改动计入本次成果。
