# 执行控制与文件恢复

Main 和阶段主导者在首次派工前读取。命令均使用 state.helper 对应的本次协议快照。

## 小任务与阶段职责

Plan 按可独立交付的行为单元提供 [任务卡](builder-task.md)：已决策接口、允许文件、必要调用点、固定用例和首个可验证结果。缺少契约时返回 needs_decision，不能重新设计全部模块。扩大读取前明确未决问题，不重复调查来源仍有效的既有结论。

unit 是稳定模块 ID，用于任务归属和纠正作用域。同模块 Builder 串行；Builder 请求 Main 代派互不冲突的 worker；共享文件指定唯一写入者。Main 只接收派工元数据和阶段验收摘要；责任角色直接从文件读取完整结果、处理意见和整合产物。

删除累计时间、执行重试预算及 budget 命令。保留历史 attempt、验证修复最多 3 轮及连续 2 轮无进展停止规则。两次确认无进展的实现尝试也先诊断范围、契约、上下文、环境或执行异常，再提出有新证据的恢复方案，不能原样重复派工。缺少检查点本身不等于无进展。

## 结束当前轮次前的完整交接

Planner、Builder、Verifier、Ultraviewer、Hook 主导者每轮结束前都须写当前 attempt/handoff.md。其他角色请求代派时也须保存。文件应包含：

- 目标、验收条件、逻辑任务及阶段、已完成工作、停点和下一动作。
- 全部已确认结论、决策、依据、用户回答、约束、关键假设、拒绝方案与理由；区分已验证事实和待验证判断。
- 继续工作所需的上下文、代码符号、接口契约、调查发现、完整 Plan/报告及证据的路径和版本。
- 已派及待派任务、依赖、预期结果、待收集结果、问题及责任角色。
- 基线和当前 commit、用户已有修改、本次未提交改动归属、检查结果、当前纠正版本及确认情况。
- 恢复时的阅读顺序、待核对变化、处理新结果的方法，以及已执行完成、不可重复的动作。

保留全部必要上下文；短摘要不能代替完整交接。正文放 handoff，完整原始产物用路径和版本引用。artifact、任务卡及派工清单均先写完，再发布检查点：

```sh
python3 /absolute/helper.py checkpoint --run /absolute/run --attempt /absolute/attempt --summary '已核对接口与调用方' --next '收齐挑战结果后整合方案' --handoff /absolute/attempt/handoff.md --request /absolute/attempt/artifacts/dispatch.json --reference /absolute/project/source.ts --evidence /absolute/attempt/artifacts/findings.md
```

--request、--reference、--evidence 均可重复。reference 是需要恢复时核对的来源文件，可在项目中；evidence 和所有流程输出须在本次 logs/reports。检查点保存 handoff、请求、任务卡和来源哈希，记录已完成事实、下一动作及工作区 fingerprint。普通里程碑可仅写 evidence 检查点；发布派工或结束主导者轮次必须有完整 handoff。

然后写 result.json；请求派工用 needs_decision，Main collect 后才读 requests。已收集的任务、回执、交接与请求保持不可覆盖；新一轮用新 attempt。单纯重复摘要不计新进展。

## 恢复与中断

Main 收齐子任务终态后，用原 task-id、role、unit 和 --continue-from 建立新 attempt；prepare 输出 recovery.json 路径。是否支持 resume 不影响恢复要求：先读原交接、检查点和原始材料，再读本批结果和最新纠正。recovery 标记变化的来源与工作区，责任角色判断哪些结论需要补查。

发布请求时结束当前轮次，不持有执行槽等待子任务。Main 不反复读日志和源码，只用宿主完成通知及必要等待调用。原生任务状态未知时先核对宿主、Git 和产物；不能把旧文件或日志当作任务已停止的证据。确认代理已结束后：

```sh
python3 /absolute/helper.py reconcile --run /absolute/run --task-id build-owner --agent-ended --reason '宿主确认代理已取消，已核对 Git 与已有产物'
```

reconcile 记录中断，不杀进程、不撤销改动。已有完整 checkpoint 可在核对后 --continue-from 恢复；未保存完整上下文时先以 --retry 编写明确的恢复任务，基于最近有效检查点与实际现场重建上下文，并记录无法确认的部分。已完成的 commit、测试或报告不重放。

## 纠正必须确认

任务卡在 attempt 内不可变。Main 使用独立纠正账本，不能追加旧任务卡冒充消息：

```sh
python3 /absolute/helper.py correct --run /absolute/run --unit attachments --task-id build-owner --issue occupancy --message '保留空引用的占用行为，并提供回归证据'
python3 /absolute/helper.py ack --run /absolute/run --attempt /absolute/attempt --issue occupancy --revision 1
```

指定 --task-id 时仅约束该任务和重试，省略时约束整个 unit。Builder 在编辑、测试、提交和交付前读取当前纠正并 ack；原生消息只提醒其读文件，ack 才表示实际收到。新 revision 使旧确认失效。误发用 retract，须匹配当前 revision、写原因并保留历史；已验收或撤回的版本不能再次撤回，重新发布继续递增。

确认不代表修复。结果草稿附处理证据：

```json
{"corrections":{"occupancy":{"revision":1,"evidence":["/absolute/attempt/artifacts/occupancy-test.log"]}}}
```

提交前写结果草稿，再执行 `gate --run ... --attempt ...`；未确认当前版本或无处理证据不能通过。提交后补全 commit、检查结果和最终 status。gate 不拦截任意 Git 命令，Builder 须遵守该路径。

## 验收与补交

Main 按阶段主导者的验收摘要、责任角色结论和证据索引放行，有矛盾再定点读取 diff 或原始证据；不能用 completed 或测试总数代替语义验收。

```sh
python3 /absolute/helper.py accept --run /absolute/run --task-id build-owner
```

accept 核对任务、依赖的实际验收记录、当前纠正、产物哈希和工作区。未处理纠正或变化的证据阻止验收。--after 必须引用真实已验收任务，不能绕开失败或未完成的依赖。稳定模块可提前独立审查，最终补齐集成覆盖；变化后只复验受影响部分。

并行工作可能在某个子任务交付后继续改变工作区。阶段主导者核对当前现场和受影响行为，将复核依据写文件，并提供下面的 JSON；fingerprint 从 status 读取。Main 仅传复核文件路径执行 `accept --task-id ... --review /absolute/recheck.json`。脚本继续校验原回执、产物和纠正，复核不能掩盖被覆盖的旧证据。

```json
{"attempt":"/absolute/child-attempt","fingerprint":"当前工作区 fingerprint","evidence":["/absolute/owner-attempt/artifacts/integration-review.md"]}
```

代码和证据已成立，仅回执缺失、格式、说明或 ack 需要补正时：

```sh
python3 /absolute/helper.py prepare --run /absolute/run --task-id build-owner --unit attachments --role builder --redeliver --prompt /absolute/run/tasks/receipt-fix.md
```

Main 优先续接记录的真实原生 agent；不支持或无法续接时，在新任务卡记录原因及短交接，并新建代理。补交只修本次新 result，不改代码、不提交、不重跑测试、不覆盖旧回执和证据。每 unit 最多两次补交，单独识别 delivery；不维护时间或实现重试预算。workspace 或旧证据变化阻止验收，应回到实现诊断，不能靠补交隐藏变化。
