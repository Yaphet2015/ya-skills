# Hook 约定

只执行任务指定的一个 Hook。使用运行 state.json 的 project、run_id、repo；上下文提供阶段、尝试次数、Plan 版本、Git 范围、结果和证据。所有已配置 Hook 用 bangboo GLM-5.3 max。

## 输入

context JSON 必须有 stage、attempt（正整数）、plan_version、git_range、outcome、evidence（文件路径数组）。另外按 Hook 提供 plan_path、plan_hash、review_path、coverage_path、progress_path、说明文件路径等必要输入。读取实际文件，不凭摘要编造结果。可用 output_dir 指定已按目标目录规则选定的绝对输出目录；重试沿用记录的实际目录。

未配置的 before-plan、before-impl、after-impl、before-verify 记录 noop。可通过 hook 的 --prompt 指定额外任务，使用相同执行协议。Hook key 是逻辑阶段尝试或 Plan 版本；重试沿用 key 并加 --retry，下一轮用新 key。

## 目标目录规则

写入仓库外的产物前，必须读取目标目录及其父目录链上的 AGENTS.md；不能假设从代码仓库启动的 Agent 会自动加载桌面目录规则。脚本在派发 Hook 时将已存在的适用规则全文和路径附入任务；提供 output_dir 时还包含该子目录链上的规则。Planner 也会收到 Plan 根目录规则，提前按要求准备最终 Plan。

先按规则选择目录，再检查新选定子目录链上的 AGENTS.md，之后才创建或写入文件。只读当前目标的祖先链，不扫描无关分支。读取失败则 blocked，不能当作没有规则。较近目录规则覆盖较远目录规则；用户明确要求优先。

下文路径是没有额外目录约定时的默认布局，不能覆盖 AGENTS.md。例如目标目录要求“日期前缀＋分支名”，就在该目录下使用 `<YYYYMMDD>-<分支目录名>/<运行ID>/`，报告再加 `attempt-<次数>/`；分支名中的路径分隔符转换为短横线，日期使用运行开始日期。已有分支目录时复用，并检查是否确属当前分支，避免命名冲突。脚本传入实际分支名（detached HEAD 使用 commit 标识）和日期，不能凭项目名猜分支。

语言、句式和结构同样属于交付约束，适用于正文、标题、图注和报告界面文案；代码、命令及真实标识符保持原样。源 Plan 不符合目标写作规则时交 Planner 修订正式版本，不在保存 Hook 中擅自改写技术决策或压缩内容。AGENTS.md 没有要求时不添加额外格式流程。

结果除实际 artifacts 外，补充 instruction_paths（实际读取的规则文件路径）和 output_dir。Leader 逐项核对目录命名、语言、内容及版本后验收；只检查文件存在不足以放行。

## after-plan

保存完整、可执行的最终 Plan。无额外目录约定时使用：

`~/Desktop/cowork-plan/<项目>/<运行ID>/plan.md`

同时保存不可覆盖的 `plan-v<版本>.md`。plan.md 是最新版本副本。相同版本重试先比较内容；内容相同视为已完成，不重复生成。版本相同但内容不同则 blocked，要求 Leader 增加版本。不能总结压缩原 Plan。

## after-verify

读取实际 show-pr Skill 和参考资料，使用本次固定 Git 范围、Plan、coverage、ultrareview 和验证证据生成报告。此工作流指定使用 show-pr 和桌面根目录，覆盖 show-pr 默认输出位置与默认基线约定；具体子目录和写作规范仍遵循目标 AGENTS.md。失败的验证尝试也报告真实状态。

无额外目录约定时输出：

`~/Desktop/cowork-report/<项目>/<运行ID>/attempt-<次数>/report.html`

图文 JSON、中间文件及证据副本保存在同一尝试目录。执行 show-pr 的 validator 和 renderer；报告自包含、离线可读。已有测试证据需包含实际命令、结果和来源；不要仅为报告重跑无变化的测试，不得把未运行或未捕获的结果写为已验证。未执行项在覆盖说明中标明。报告生成不得修改产品代码。

同一次重试检查已有产物及验证结果，修复失败部分，不重复此前实现、提交或测试副作用。

## before-finish

保存：

`~/Desktop/cowork-retrospective-<项目>-<运行ID>.md`

总结最终成功/失败/阻塞状态、各阶段产出与耗时、关键决策、修复轮次、失败原因和流程待优化点。优化建议必须来自本次事实，注明依据；不自动改其他 Skill。链接 Plan 和报告，缺失则如实说明。

## 输出与失败

遵循 protocol.md 的结果 JSON。completed 的 artifacts 必须包含上述实际输出文件；Leader 检查实际目标目录规则、文件存在、内容、版本、报告验证结果和证据绑定后才接受 Hook。

写入失败、依赖缺失、证据不足或渲染失败返回 blocked，并保留已完成产物。Hook 失败阻止成功结案。重试仅处理失败 Hook，不重新实施项目。沙箱拒绝桌面路径时明确报告，不悄悄把临时路径冒充指定交付路径。
