# Computer-E2E 基础层验收记录（foundation plan Task A7）

日期：2026-09-13。分支 `feat/computer-use`（工作树 `/Users/phaethon/workspace/personal/ya-skills-cu`）。
计划：`docs/superpowers/plans/2026-09-13-computer-e2e-foundation.md`。本文件只记录**实际执行过的验证**；未执行项明确标注。

## 1. 分层验收表

| 层级 | 结果 | 证据 |
|---|---|---|
| 纯单元/契约（假 backend + 真实子进程，无桌面） | **PASS** | `bun test`：295 pass / 0 fail / 1 skip（skip = `YK_CU_NATIVE_TESTS=1` 门控的 Finder 只读探测，未授权执行） |
| 类型检查 | **PASS** | `bun run typecheck` exit 0 |
| 发布包打包 | **PASS** | `bun run package:release -- --version 0.18.0` exit 0；产物 `dist/release/ya-skills/{yk,skills,runtime}` |
| 发布包闭环（PATH=/usr/bin:/bin，无 node/npm/bun） | **PASS** | `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts`：3 pass / 0 fail —— install → run（外部 TS + 相对导入 + 恶意 package.json）→ 失败 exit 1 / skip exit 2 → history → report；无 node_modules；sdkVersion=null |
| Node 目标构建 + smoke | **PASS** | `bun run build`、`bun run smoke` exit 0（仅验证既有 help/catalog；Node 不支持 e2e 外部 TS，按设计拒绝） |
| 独立只读评审 | **PASS（修复后）** | oracle 评审发现 B1/B2/R1 + N1–N8；B1/B2/R1/N1/N2/N3/N5 已修复并回归（commit `9c82335`），N4 已写入文档，N6 见 §4，N7/N8 记录为已知无害冗余 |
| **真实桌面动作**（用户授权：Cowork dev 主窗口，pid 50447 / windowId 12850） | **PASS（scroll 为设计内拒绝）** | 见 §1b 真机台账 |
| **真实 Homebrew 安装** | **未执行** | 需另行授权；且当前 tap 若仍缺 runtime-aware 安装块则正式 brew 交付仍被阻断（`scripts/update-ya-skills-formula.py` 会拒绝更新并要求先更新 tap） |

## 1b. 真机动作台账（2026-09-14，打包 yk，用户授权的 Cowork dev 窗口）

| 动作 | 命令要点 | 结果 |
|---|---|---|
| doctor | 打包 yk，SDK 0.27.0 同进程 | PASS（ok:true，双权限 true） |
| apps / windows / perceive | 定位 Electron dev pid 50447；10 窗口中唯一 `LogosCowork`（12850），按歧义规则显式 `--window` | PASS（286 元素；截图 0600 落 `~/Library/Caches/ya-skills/computer-use/`） |
| 降级拒绝 | 窗口被遮挡时 perceive | PASS：`degraded_snapshot` 明确报错，未自动激活；用户露出窗口后恢复 |
| **click** | 后台点击「收起侧边栏」 | PASS：286→165 元素，按钮标签翻转为「展开侧边栏」；再点击还原（286、标签复原、4 个会话项回归） |
| **type** | 先后台点击 composer 聚焦，再 `--type "cuv7"` | PASS：AX `value == 'cuv7'`（投递+后置断言） |
| **key** | `--key Backspace` ×4 | PASS：草稿清空，value 回到 placeholder 镜像态（label===value） |
| **scroll** | 侧栏列表处 `--scroll down --amount 3` | **设计内拒绝**：`action_refused: Background scroll is unavailable for Electron/Chromium windows on macOS.`——诚实失败，非崩溃非假成功。前台变体（需 `--activate`）未执行，遵守"未经明确要求不前台"策略 |
| 截图读图 | `perceive --shot` + gpt-5.6-luna(max) 子代理读图 | PASS：视觉确认侧栏展开、composer 仅 placeholder、无 `cuv7` 残留、无弹窗/异常；顶栏 `LogosCowork (v1.2.0·预发环境)` |
| 不重放纪律 | 超时未知投递场景 | 未在真机制造（不对用户窗口人为制造超时）；单元/监督层已覆盖（poison + refused 续体回归测试） |

副作用清理：草稿已清空、侧栏已还原、未发送任何消息、未创建会话（点击「新建会话」一次，业务上空会话未入列表，无残留证据）。焦点观察：click/type 均为 Background 投递；typing 生效说明后台点击建立了窗口焦点而无激活。

## 2. 门禁原始记录（2026-09-13T15:11:56Z，干净 dist 重建）

```text
typecheck: 0
full-suite: 0 (286 pass 6 skip 0 fail)   # 6 skip = native 门控 1 + 打包断言 5（dist 未建时跳过）
package:release: 0
release-loop: 0 (3 pass)
node-build: 0
smoke: 0
```

评审修复后最终态（`9c82335`）：295 pass / 1 skip / 0 fail；release-loop 3 pass / 0 fail；package/build/smoke 0。

## 3. 关键修复台账（评审阻断项）

| 项 | 内容 | 回归测试 |
|---|---|---|
| B1 | session close 失败经 fd3 发 `hook_finished(session-close, failed)`，清理失败不可能归约为 exit 0 | 事件归约单元测试 + 闭环 |
| B2 | SIGINT/SIGTERM → 对**在跑** worker 进程组 SIGTERM（有界 SIGKILL 宽限），不再只跳过下一文件 | `stopSignal` 中断 hang 用例，断言 pid ESRCH、summary 非通过 |
| R1 | per-case AbortController + computer 代理守卫：超时 case 的僵尸续体被拒绝，不在 afterAll 期间投递动作 | 僵尸续体回归测试（refused=1, acted=0） |
| N1 | 零用例 run 归约为 exit 2 | 单元测试 |
| N2 | 删除从未填充的 `CaseResult.actionOutcome`（接口不撒谎） | api.d.ts 再生成 diff |
| N3/N5 | 排空计时器清理；api.d.ts 再生成写入临时路径后 diff | — |
| N4 | 父进程被 SIGKILL 时 worker 配置（含 params）可能残留于 0700 run 目录 → 已写入 docs/SKILL | 文档 |

## 4. 已知未闭环项（诚实清单）

- N6：计划 A3 的“help/list/install SDK importer 次数为 0”的**进程级计数**测试未实现；结构性等价证据存在（SDK 动态导入仅存在于 `sdk.ts`；纯 suite `sdkVersion=null` 有测；编译级 hostile-fake-dep `--help`/`list` 探测有测）。接受为计划-实现偏差。
- N7：session `waitFor` 双重 guard 冗余（行为正确）。
- N8：close 时 backend 尚未就绪的迟到赋值窗口（进程随即退出，实际影响有限）。
- bunfig preload 信度模型：按用户 2026-09-13 裁定接受（见 `docs/research/2026-09-13-compiled-e2e-loader.md`），SKILL/docs 已披露。
- 真实 UI 与 Homebrew：见 §1 未执行项。

## 5. 交接（第二份计划消费）

- 产物根：`/Users/phaethon/workspace/personal/ya-skills-cu/dist/release/ya-skills/`
- `YK_BINARY`：`/Users/phaethon/workspace/personal/ya-skills-cu/dist/release/ya-skills/yk`
- yk 版本：`0.18.0`；`--version` 校验通过；yk 可执行 SHA256 前缀 `4960d3accf5f7321`（完整值随每次 `metadata.ykExecutableSha256` 记录于 run）
- apiVersion：`1`（`skills/computer-e2e/references/api.d.ts`，由源生成）
- runtime sidecar：`runtime/computer-use/node_modules/@trycua/cua-driver@0.27.0` 等（打包断言通过）
- Cowork 消费计划：`/Users/phaethon/workspace/temu/cowork-e2e/docs/superpowers/plans/2026-09-13-cowork-e2e-consumer-migration.md`
- 注意：产物目录是**本地构建**，未发布、未 brew 安装；tap 更新不自动执行。

## 6. 待用户决定

1. ~~真实桌面动作授权~~ —— 已完成（§1b）。
2. 是否补测前台 scroll（`--activate`，会短暂抢焦点）——默认不做。
3. 是否进入 Cowork 消费计划（Task B1）。
