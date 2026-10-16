# Hook 约定

Main 通过原生 subagent 代派已配置 Hook，只执行任务指定的一个 Hook。读取 state.json 的 project、branch、run_id、logs 和 reports，使用冻结的绝对路径；模型沿用宿主或用户配置。

## 输入与派工

context JSON 必须有 stage、attempt（正整数）、plan_version、git_range、outcome、evidence（文件路径数组）；按任务补充 plan_path、plan_hash、review_path、coverage_path、progress_path 等。读取实际文件，不能从摘要编造结果。output_dir 如提供，必须等于本次 Hook 的统一目标目录。

未配置的 before-plan、before-impl、after-impl、before-verify 记录 noop。`hook --run ... --name ... --key ... --context ...` 为已配置 Hook 准备任务，Main 按返回路径创建原生 subagent 并 bind；结束后 collect 和 accept。--prompt 可配置额外 Hook 任务。key 是逻辑轮次或 Plan 版本；失败只重试同 key 的失败部分，新轮次用新 key。

## 目标目录规则

正式产物统一位于 `state.reports`，即 `~/.ya-skills/ultra-produce/reports/<project>/<branch>/<run-id>/`。内部报告、分析、完整交接、输入 JSON、中间文件、原始日志和证据位于 Hook attempt/artifacts 等本次 logs 目录。产品源码仍属于目标仓库。

写入前读取目标目录及祖先链上的 AGENTS.md。脚本附入实际可读取的规则全文和路径；使用用户要求的统一布局，并遵循内容、语言和写作规则。读取失败返回 blocked。已有写作规范不允许在保存时擅自压缩或改变技术决策；不符合要求时交原责任角色修订。报告 instruction_paths 和 output_dir，Main 验收实际产物及规则适用情况。

## after-plan

将完整、可执行的最终 Plan 保存为：

- `state.reports/plan.md`：最新完整副本。
- `state.reports/plan-v<版本>.md`：不可覆盖的版本。

同版本重试先比较，内容相同则复用；同版本内容不同则 blocked，须增加版本。不能总结压缩原 Plan。Plan 有实质变化保留旧版本，并重新运行本 Hook。

## after-verify

读取实际 show-pr Skill 及参考资料，用本次固定 Git 范围、完整 Plan、coverage、ultrareview 和测试证据生成：

`state.reports/verify-r<attempt>/report.html`

本工作流明确指定 show-pr 及统一报告目录，覆盖其默认路径和基线约定。执行 validator 与 renderer，产物自包含、离线可读。生成所用 JSON、中间文件及原始证据放当前 Hook attempt/artifacts；报告包含展示所需的内容或内嵌资产，不能依赖 logs 才能离线打开。

成功、失败、中断或缺少环境均报告真实状态。已有证据保留实际命令、结果和来源；不要为了报告重跑未变化的测试。未运行或未捕获的结果不能写成已验证。报告生成不得修改产品代码。重试只补失败部分，不重放实现、提交或测试副作用。

## before-finish

保存 `state.reports/retrospective.md`：最终成功/失败/阻塞状态、阶段产物、实际耗时、关键决策、修复轮次、失败原因和流程可改进处。建议须有本次事实依据，不自动修改其他 Skill。链接正式 Plan 和报告，缺失如实说明。实际耗时可根据任务时间戳汇总，不恢复预算账本。

## 输出与失败

遵循 protocol.md 的 result.json。completed 的 artifacts 包含正式产物，附实际 instruction_paths、output_dir；结束前按 execution.md 发布完整 handoff/checkpoint。最终回复只含 task_id、status 和回执路径。

Main 检查实际路径、内容、版本、报告验证结果与证据绑定，再 accept。文件存在不等于语义验收。写入失败、依赖缺失、证据不足或渲染失败返回 blocked，保留已完成产物；Hook 失败阻止成功结案，重试只处理失败 Hook。
