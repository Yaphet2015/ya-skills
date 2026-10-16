# 运行与交接协议

## 统一目录

根目录是 `~/.ya-skills/ultra-produce/`。初始化一次生成所有绝对路径，写入 state.json；所有角色及 Hook 使用这些路径。

```text
logs/<run-id>/
  state.json / progress.json / decisions.md
  baseline/                       # 起始 patch、用户未跟踪内容
  skill/                          # 本次协议快照，含 helper
  units/<unit>/corrections.json
  tasks/<task-id>/attempt-0001/
    task.md / execution.json / result.json
    handoff.md / checkpoint.json / recovery.json
    artifacts/                    # 完整分析、挑战、日志、测试证据、渲染中间文件
reports/<project>/<branch>/<run-id>/
  plan.md / plan-v1.md / plan-v2.md
  verify-r1/report.html
  verify-r2/report.html
  retrospective.md
```

project 取根项目声明：package.json 的 name、pyproject.toml 的 project.name 或 tool.poetry.name、Cargo.toml 的 package.name、go.mod 的 module。monorepo 默认使用根项目；明确指定子项目时用 `init --project-file /absolute/subproject/package.json`。缺失名称或多个名称冲突时，用 `--project-name` 明确指定，不回退目录名。记录名称来源。branch 取实际分支，detached HEAD 用 detached-短commit。两个名称均编码成单个路径段，例如 feature/a → feature%2Fa。run-id 使用 UTC 时间与随机后缀，运行后路径固定。

内部产物全部放 logs，正式交付放 reports；产品代码和项目测试仍在目标仓库。写入前读目标目录祖先链的 AGENTS.md，使用已指定的统一布局并遵守内容与语言规则。默认根目录可用 init 的 `--root`（兼容 `--state-root`）整体替换，主要用于隔离测试；不得按角色分别指定根目录。

## 启动和派工

Main 是唯一调用原生创建、消息、等待、续接和结束工具的角色。其余角色和被调用 Skill 通过文件请求代派。宿主无需多层派生，也无需支持 resume。模型和 Provider 使用宿主默认值或用户指定值。

```sh
python3 /absolute/skill/scripts/pipeline.py preflight --repo /absolute/project
python3 /absolute/skill/scripts/pipeline.py init --repo /absolute/project --goal '任务目标' --dependencies-checked
```

preflight 只读检查 Git、Python 和指定 Skill，搜索项目及用户的 .agents、.claude、.coldx、.codex、.logoscode、bangboo Skill 根目录及 CODEX_HOME/skills；额外根用重复的 `--skill-root`，init 传同样根目录。自动递归检查 skill.json 的 dependsOn。Main 定点读取各 Skill 的必要依赖声明，确认任务工具、共享文件访问与原生派生实际可用，才传 --dependencies-checked。缺失依赖即结束，不安装、替代或跳过；ultra-cr 不能改成 ultrareview。

init 保存仓库外的基线和协议快照，返回 logs 下的运行目录。此后使用 state.helper 对应的快照脚本；新版本不操作旧协议运行，旧运行继续用原快照收尾。

```sh
python3 /absolute/run/skill/scripts/pipeline.py prepare --run /absolute/run --task-id plan --role planner --prompt /absolute/run/plan-task.md
# Main 用原生工具启动 subagent：读取 prepare 返回的 task 路径；只传路径，不展开正文。
python3 /absolute/run/skill/scripts/pipeline.py bind --run /absolute/run --attempt /absolute/attempt --agent-id actual-native-id
# 收到宿主完成通知后：
python3 /absolute/run/skill/scripts/pipeline.py collect --run /absolute/run --attempt /absolute/attempt
```

prepare 创建独立 attempt，检查依赖并冻结 task.md；bind 记录工具实际返回的 ID，不能使用 Agent 自报值或“最近会话”。collect 校验回执、交接和输出文件，只输出 task_id、角色、状态及路径等元数据。completed 不自动验收。状态是文件注册状态，不能据此猜测代理是否存活；Main 用宿主工具核对。

普通实施子任务用 worker，独立挑战用 challenger；其余角色是 planner、builder、ultraviewer、verifier、e2e-tester、hook。Builder 要求 --unit，模块内 Builder 串行；互不冲突的 worker 可并行且不操作 Git index。前置任务用重复的 `--after task-id`，须有实际验收记录。

## 任务文件和回执

每次派工保留：task_id、parent_task_id、角色、目标、项目与运行目录、输入、允许修改范围、依赖、验收条件和输出路径。附 Plan 路径与版本、基线 commit、授权测试目标、用户已有改动。Builder 用 [小任务卡](builder-task.md)，内联已决策契约、固定用例、精确读取范围及首个可验证里程碑；不要求重做模块设计。待完成依赖标 pending。

执行者读取实际 [角色任务](roles.md)、已解析的 Skill 文件和必要参考，不仅发送 slash 指令。结果写指定 result.json：

```json
{
  "task_id": "challenge-a",
  "status": "completed",
  "summary": "完整分析保留在文件里；此字段不回传 Main。",
  "artifacts": ["/absolute/run/tasks/challenge-a/attempt-0001/artifacts/challenge.md"],
  "questions": [],
  "commits": [],
  "evidence": [],
  "corrections": {}
}
```

必填 task_id、status、summary、artifacts，状态为 completed、needs_decision、needs_changes 或 blocked。artifacts 必须是本次 logs 或 reports 内存在的绝对文件路径。问题用 questions 标记 audience=user（未定交互体验）或 leader（技术问题路由、派工及权限）；按 ID 记录 decisions.md，结论交回原角色。技术争议归 Planner，实现细节归 Builder，测试证据问题归 Verifier。

**每个 subagent 的最终回复只能包含 task_id、status、result.json 路径。** 完整过程、问题、代码差异和报告不复制回 Main。Main 的阶段验收只读责任角色的验收摘要和证据索引，矛盾时再定点取证；原始完整结论仍须保存。

summary 保持简短，完整分析放 artifacts。阶段验收时 Main 用 `brief --run ... --attempt ...` 显式读取最多 600 字符的结论和每页 10 项的问题 ID／产物索引；用 --offset 翻页。用户选择等问题按 ID 用 `brief --question-id ...` 定点读取；文本超长时标明 truncated，交原角色提供短问题或定点核对文件。子任务 collect/status 通知始终不含 summary 和问题正文。

## 文件代派与恢复

阶段主导者在当前 attempt 的 artifacts 写任务卡和派工文件：

```json
{
  "tasks": [{
    "task_id": "challenge-a",
    "role": "challenger",
    "prompt_path": "/absolute/owner-attempt/artifacts/challenge-task.md",
    "after": []
  }]
}
```

需要模块归属时附 unit。主导者先按 [执行与恢复](execution.md) 发布完整 handoff 和 checkpoint（--request 指向派工文件），再写 needs_decision 回执结束本轮，释放执行槽。Main 收集回执后：

```sh
python3 /absolute/helper.py requests --run /absolute/run --attempt /absolute/owner-attempt
python3 /absolute/helper.py prepare --run /absolute/run --task-id challenge-a --role challenger --prompt /absolute/owner-attempt/artifacts/challenge-task.md --parent-attempt /absolute/owner-attempt
```

requests 仅返回任务 ID、角色、路径和依赖，不打印任务正文。Main 仍负责调用原生工具并 bind。子任务完整结果由原主导者直接读文件；Main 只收简短通知。逻辑父子关系记录 parent_task_id、parent_attempt；宿主实际代理均为 Main 的同层代理。重试子任务保留逻辑归属。

本批全部结束（失败也须有真实终态）后：

```sh
python3 /absolute/helper.py prepare --run /absolute/run --task-id plan --role planner --prompt /absolute/run/continue-plan.md --continue-from /absolute/owner-attempt
```

prepare 检查原交接及派工输入未被覆盖、所有请求已产生结果，生成新 attempt/recovery.json。Main 可续接原生会话，也可直接新建，只传新任务路径。新主导者先读 recovery.json、原 handoff、checkpoint、必要原始产物和子任务回执，再核对现场继续；结论不依赖宿主会话历史。来源文件变化单独列出，不能静默复用。恢复失败或异常退出的处理见 execution.md。

## 验收和状态

Main 维护 progress.json：阶段、最终状态、BFS 及模块关系、Plan 版本/哈希、已验收任务与 commit、Hook 记录、verify_attempt、repair_round、连续无进展次数、未解决问题 ID、新证据与仓库 fingerprint。代理只写自身产物。预算账本移除，任务历史及验证停止条件保留。

初始化 → Before Plan → Plan → After Plan → Before Impl → Impl → After Impl → Before Verify → Verify → After Verify。需修复时返回 Impl/Verify；最多 3 轮修复，连续 2 轮无进展提前停止；成功或终止均执行 Before Finish。preflight 失败直接结束。Hook 失败只补失败部分，不能重放已完成实现、commit 或测试。

恢复或异常时读一次 `status --run`，定点用 --task-id 或 --parent-task-id；输出不含分析正文。通过宿主完成通知等待，无通知能力时仅使用宿主必要的等待调用，不逐分钟轮询日志、源码和 diff。

证据绑定 Plan 版本、Git 范围、工作区与测试环境。Plan 或代码变动时复核受影响部分，忽略文件中的构建产物和环境变化另行判断。用户已有 hunks 和未跟踪文件不得覆盖、回退或混入提交。
