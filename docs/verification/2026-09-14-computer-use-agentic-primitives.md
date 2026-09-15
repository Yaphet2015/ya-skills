# Computer-Use 桌面基础 Task A1：原生能力绑定与编译执行证据

日期：2026-09-14。计划：`docs/superpowers/plans/2026-09-14-computer-use-desktop.md` Task A1（总计划 `2026-09-14-computer-use-agentic.md` §5）。
工作树：`/Users/phaethon/workspace/personal/worktrees/ya-skills/pi-worktree-b804e5e6-f754-47e2-a01e-ff6b3abaa184-0`，分支 `pi-subagents/worker-Implement-ONLY-Task-A1-...`，基线 `4989043`。
授权边界：本轮**没有授权任何真实桌面目标**——未启动原生 driver，未枚举/检查/操控任何真实窗口。本文件只记录实际执行过的验证；静态类型检查与绑定形状**不是**原生成功证据。

## 0. 结论一览

| 项 | 状态 |
|---|---|
| 静态 SDK 版本/字段清点（README + `cua_driver_contract.d.ts`） | **已验证（静态）** |
| 探针守卫（无目标不启 driver、无 allow-input 只读、隐私白名单投影） | **已验证（desktop-free，18 测试）** |
| 编译后执行捕获 JS 字符串（AsyncFunction + await + 共享 state） | **已验证（真实编译二进制）** |
| 同一 executable 子进程 Unix socket IPC 往返 | **已验证（真实编译二进制）** |
| 无限循环子进程 SIGTERM 回收 + SIGTERM 被忽略时 SIGKILL 兜底 | **已验证（真实编译二进制）** |
| 1x/2x 截图、非零窗口原点、window-target 坐标点击、背景输入拒绝语义 | **未验证（等待测试窗口授权）** |
| AX 不完整但 image 有效的原生可取性 | **未验证（等待测试窗口授权）** |
| `focused_element` 是否有可用 SDK 状态 | **静态否定倾向 + 未验证**（见 §2.4） |
| 新 session 宿主的 macOS 权限归属（探针结论 4） | **未验证（属 B1 前置，本轮无桌面）** |
| **A1 整体完成度** | **未完成**：仅静态与 compiled 无桌面部分完成，不宣称 A1 完成 |

## 1. 基线门禁（本工作树，实施前）

| 门禁 | 结果 |
|---|---|
| `bun install`（bun 1.4.0，系统 PATH） | PASS；workspace 依赖落位，`packages/computer-runtime/node_modules/@trycua/cua-driver@0.27.0` + `@trycua/cua-driver-darwin-arm64@0.27.0` |
| `bun run typecheck` | PASS（exit 0） |
| `bun test`（默认 desktop-free） | PASS：**307 用例 / 301 pass / 6 skip / 0 fail / 1142 expect**；6 skip 均为既有 `YK_CU_NATIVE_TESTS=1`（1 项）与 `YK_RELEASE_TESTS=1`/打包产物（5 项）门控，未执行 |

工具版本：系统 bun `1.4.0`（`/Users/phaethon/.bun/bin/bun`）；仓库基线为 `packageManager: bun@1.3.14`。编译证据同时用两版验证（§4），编译主证据使用钉住的 1.3.14。

## 2. 静态 SDK 证据（允许的只读检查）

来源：`packages/computer-runtime/node_modules/@trycua/cua-driver/package.json`、`dist/native/cua_driver_contract.d.ts`、`dist/native/cua_driver_sdk.d.ts`、包内 `README.md`。本节是**类型声明与文档事实**，不是原生行为验收。

### 2.1 精确版本

- `@trycua/cua-driver` **0.27.0**（`package.json` `version`；`main: ./dist/index.js`，re-export `./native/index.js` → contract + sdk 两个生成模块）。
- 可选原生包 `@trycua/cua-driver-darwin-arm64` **0.27.0**（内容：`libcua_driver_sdk.dylib`、`cua_driver_node_runtime.node`、copy-mode `@ubjs/node` 0.31.0-3 NOTICE）。

### 2.2 输入/目标绑定形状（contract.d.ts，已确认的绑定形状）

- `InputDeliveryMode { Background = 0, Foreground = 1 }`；`ClickButton { Left = 0, Right = 1, Middle = 2 }`。
- `ClickPosition.Coordinates`：`new ClickPosition.Coordinates({ x: number, y: number })`（enum 变体构造器 + `inner` 只读字段）；`ClickPosition.Element({ elementToken: string })`。
- `ActionTarget.Window({ pid: number, windowId: bigint })`；`ActionTarget.Desktop({ displayId: string })`（`display_id="primary"` 为可移植桌面目标；其它显示器会显式拒绝而非静默换坐标系）。README 明确：**Window ID 是 bigint，不得转 number**。
- `ClickInput = { target, position, deliveryMode, session?, button?, count? }`，工厂 `ClickInput.new({ target, position, deliveryMode })`（`create`/`new` 同构）。
- `GetWindowStateInput = { pid, windowId, session?, query?, includeAccessibilityTree?, includeScreenshot?, screenshotOutFile?, maxElements?, maxDepth?, maxDimension? }`。

### 2.3 观察/等待输出形状

- `WindowStateOutput = { pid, windowId, snapshotId?, appName?, windowTitle?, treeMarkdown?, elements?, elementCount?, totalElementCount?, returnedElementCount?, filteredElementCount?, elementsComplete?, degraded?, degradedReason?, truncated?, truncationReason?, screenshotWidth?, screenshotHeight?, screenshotScale?, screenshotMimeType?, screenshotFilePath?, screenshotFrameValid?, windowBounds?, images: SnapshotImage[] }`。
- `WindowBounds = { x, y, width, height }`（全 number；**原点与单位语义未实测**，见 §5 待授权项）。`ElementFrame = { x, y, w, h }`。
- `SnapshotImage = { mimeType, dataBase64 }`；README：图片只进 MCP envelope，不进 structuredContent。
- `VerifyStateInput = { target?, session?, timeoutMs?（bigint，有界等待，0 = 单次采样）, stableSamples?（bigint，连续满足样本数）, includeScreenshot? }`；谓词 `ElementPredicate = { selector: ElementSelector{ role?, labelContains? }, exists?, valueEquals?, enabled?, selected? }`——**没有 focus 谓词**。doc 注明“元素遍历非全平台穷尽，absence 不可证明，`exists:false` 按拒绝处理”。
- `DriverMetadata = { driverVersion, contractVersion, toolsListSchemaVersion, capabilityVersion, mcpProtocolVersion, pid, embedded, hostBundleId? }`；`currentMacOsPermissionStatus(): { accessibility, screenRecording }` 为 SDK 直接导出。
- `CuaDriver.create(undefined)`（同进程，无 daemon）、`CuaDriver.connect(socketPath)`（daemon 模式，同一方法面）均存在；`shutdown()` 幂等、`uniffiDestroy()` 释放句柄。

### 2.4 焦点状态的静态否定倾向

`WindowElement = { elementIndex: bigint, role, depth, elementToken?, label?, value?, valueDescription?, enabled?, selected?, inWebContent?, actions?, parentIndex?, frame?, min?, max? }` ——**没有通用 `focused` 字段**；谓词面也只有 `selected`。与总计划 §2 的规划期结论一致：`selected ≠ focused`，`focused_element` 条件在拿到可用 SDK 状态前应按计划返回 `unsupported_condition`，不得用 selected 伪装。原生确认仍待测试窗口（§5）。

### 2.5 README 关键事实（与 B 计划相关，静态）

- implicit session 复用至 shutdown/显式结束/**五分钟无活动**——B 的两分钟空闲上限仍然保守合理。
- “不支持的后台路径不得自动触发 foreground 重试”（README 原文义务，与探针/产品策略一致）。
- macOS 权限归属：daemon/SDK 请求记在**宿主进程**；经 gateway/`open`/`NSWorkspace` 启动会改变 responsibility chain——这正是探针结论 4（session 宿主权限归属）需要实机验证的原因，本轮未验证。
- `startSession` 可选；`connect(socketPath)` 暴露同一方法面（B 的同用户 daemon/宿主形态的 SDK 侧依据，静态）。

## 3. 守卫探针：`scripts/probes/computer-use-agentic.ts`（desktop-free 已验证部分）

守卫矩阵（`tests/computer-use-probe-guard.test.ts`，18 pass / 0 fail，全部 desktop-free）：

| 守卫 | 证明 |
|---|---|
| 无参数 = no-target：`driverStarted:false`，exit 0，**不 import SDK** | `parseProbeArgs([])` → `no-target`；CLI 子进程实测输出 `{"mode":"no-target","driverStarted":false}` exit 0 |
| `--pid`/`--window` 必须成对、正整数/十进制 bigint | 8 组非法参数全部 `invalid` 且 `driverMustStart=false` |
| 无 `--allow-input` → 只读 | target 请求 `inputAuthorized=false` 且无 `click` 字段；click 坐标无 allow-input → exit≠0，理由含 `--allow-input` |
| `--allow-input` 无目标 → invalid | 拒绝 |
| `--click-x/--click-y` 需 allow-input 且成对、非负有限 | 拒绝非法组合 |
| 隐私白名单投影 | `projectWindowState` 只输出 windowBounds、screenshot{width,height,scale,mimeType,frameValid}、AX 计数/complete/degraded/truncated 与 snapshotId/windowTitle；**elements、label、value、treeMarkdown、图片字节全部丢弃**（fixture 含 Password/hunter2/余额文本/图片 bytes 断言不出现在序列化输出） |
| driver 启动仅限已验证 target | `driverMustStart(request) === (request.kind === "target")`，SDK 动态 import 只在 target 分支内可达 |

原生路径（本轮**未执行**）：`--pid P --window W` 后才 `import SDK → CuaDriver.create → getWindowState(includeAccessibilityTree+includeScreenshot[, maxDimension])`；`--allow-input --click-x/--click-y` 才构造 `Coordinates + ActionTarget.Window + Background` 的 `ClickInput`；driver 拒绝按原始错误记录，**永不 foreground 重试**；finally `shutdown()` + `uniffiDestroy()`；60s 硬上限自回收。运行输出 windowBounds、screenshotScale、截图像素尺寸（screenshotWidth/Height）、screenshotFrameValid，不输出密码或完整应用内容。

## 4. 编译执行证据：`scripts/probes/computer-exec-compiled.ts`（真实编译二进制）

编译命令（钉住仓库基线 1.3.14）：

```sh
/tmp/cua-bun-probe.qRsltZ/bun-1.3.14/bun-darwin-aarch64/bun --version   # → 1.3.14
/tmp/cua-bun-probe.qRsltZ/bun-1.3.14/bun-darwin-aarch64/bun build \
  --compile --target=bun-macos-arm64 --outfile=/tmp/yk-exec-probe \
  scripts/probes/computer-exec-compiled.ts                             # exit 0
```

运行（私有临时目录为 cwd，清洗环境：`env -u NODE_PATH -u NODE_OPTIONS -u BUN_INSTALL PATH=/usr/bin:/bin`，PATH 上无 bun/node）：

```text
run cwd: /tmp/yk-exec-probe-run-2NktUl
probe bun 1.3.14 exec /private/tmp/yk-exec-probe main /$bunfs/root/yk-exec-probe compiled=true
PASS compiled-js-execution state.count=3
probe private dir /var/folders/.../T/yk-exec-probe-qJukMf mode=0o700 socketLen=78
PASS ipc-socket-roundtrip exec=/private/tmp/yk-exec-probe workerExit=0 out="WORKER_OK nonce=58638"
PASS infinite-loop-term signal=SIGTERM groupReaped=true
PASS infinite-loop-sigkill-fallback termIgnoredSurvived=true signal=SIGKILL groupReaped=true
probe cleanup dirRemoved=true
exit: 0
```

逐项含义：

1. **捕获 JS 字符串执行**：编译二进制内 `new AsyncFunction("state", "state.count += await Promise.resolve(2)")(state)` 使 `{count:1}` → `count=3`——动态代码构造、`await`、跨闭包共享对象均可用（C 计划 exec 的最小内核）。
2. **同一 executable socket IPC 往返**：父进程（编译二进制本身）在 0700 私有目录建 Unix socket，spawn **自身**（realpath 后的 `/private/tmp/yk-exec-probe`，detached+独立进程组，cwd=私有目录）为 worker；worker 发 `{"type":"ping","nonce":<worker pid>}`，父回 `pong` 同 nonce，worker 校验回显一致后 exit 0。socket 路径 78 字符（< 100 断言，避开 sun_path 上限）。
3. **无限循环 TERM 回收**：`spin` 子进程 `while(true){}`，250ms 后对**进程组** SIGTERM → 子进程 `signal=SIGTERM`；`kill(-pid,0)` 得 ESRCH（组已回收）。
4. **SIGKILL 兜底**：`spin-ignore-term` 子进程安装吞掉 SIGTERM 的 handler——SIGTERM 后 2s 存活（`termIgnoredSurvived=true`），升级 SIGKILL → `signal=SIGKILL`，组回收。
5. **无源码 cwd preload**：父进程运行 cwd 与所有子进程 cwd 都是私有临时目录（源码检出目录从不作为 cwd）；运行目录无 bunfig/node_modules。外部复核：`pgrep -fl yk-exec-probe` → 无残留进程；temp 目录无 `yk-exec-probe-*` 残留。

交叉版本：系统 bun 1.4.0 编译的同一探针（`/tmp/yk-exec-probe-14`）同样 4/4 PASS、exit 0（`probe bun 1.4.0 ... compiled=true`）。未编译 dev 直跑（`bun scripts/probes/computer-exec-compiled.ts`，bun 1.4.0）也 4/4 PASS，用于快速迭代，不作为编译证据。

## 4.5 实机原生证据（2026-09-15 追加；含前台污染披露）

第二轮运行获得了真实窗口证据。**协议披露**：本轮早期使用了会干扰用户前台的操作（`open` 无 `-g` 启动、System Events keystroke、显式 `set frontmost`、SDK Foreground/GlobalInput 对比点击）。用户已明令禁止；此后所有真实输入仅允许 SDK Background 路由且须证明不改变前台焦点。下表区分"无污染 Background 证据"与"含激活污染的证据"。

### 4.5.1 未改变用户前台的证据（目标窗口从未被激活；只读或 Background 输入）

本节只保留未激活目标和只读/已确认后台路由的证据。probe20 的坐标命中不属于本节，见 §4.5.2；不能用它证明非抢焦点的坐标输入。

| 事实 | 证据 |
|---|---|
| **坐标单位：`ClickPosition.Coordinates` 的换算按截图像素、窗口局部、左上原点解释** | 越界拒绝消息把传入 (598,750) 换算为 "window-local point (299.0, 375.0) pt"（÷2）；这只证明 driver 的坐标解释和换算算术，不证明未激活窗口上的命中 |
| Retina：screenshotScale=2，截图像素=2×窗口点 | fixture 480×352pt → 960×704px；Calculator 230×408pt → 460×816px |
| windowBounds 与 ElementFrame 均为**屏幕全局点坐标**（左上原点） | AXWindow 元素 frame == windowBounds；(300,368) 窗口内复选框 frame (323,439) |
| **windowBounds 仅在 includeScreenshot=true 时返回** | includeScreenshot:false → windowBounds=undefined、screenshotWidth=undefined（两次独立验证） |
| maxDimension 生成缩放 PNG，windowBounds（点）不变 | maxDimension=240 → 240×176px，windowBounds 仍 480×352pt，frameValid=true |
| maxElements 截断：total 被钳制、`elementsComplete=false` 为不完整信号（truncated 标志**不**置位） | maxElements=2 → total=2/returned=2/complete=false/truncated=undefined（真实树 69 元素） |
| getWindowState 两个通道都关 → DriverError.InvalidArguments | "window observation requires accessibility or screenshot capture" |
| 越界后台坐标点击被拒（DriverError.Tool，含点换算值），无前台重试 | (10000,10000) 拒绝；原始错误保留 |
| **AX-token Background 点击在从未激活的后台窗口上送达** | fixture2（app Regular 但从未 frontmost）：ClickPosition.Element+Background → 复选框 false→true，route=Accessibility；这不是 Coordinates 路由证据 |
| **Background typeText 在从未激活的后台窗口送达** | AX 路由 deliveredCount=1，AXTextField 值变 "PROBE-42" |
| SDK ToolResult 结构：typeText 返回 `{text, action:{effect,route,delivery:{mode,deliveredCount}}, isError:false}`；坐标点击返回 `{effect:2(Unverifiable), route, delivery:{mode}}` 无 deliveredCount | probe10 完整 dump |
| 契约无任何 focused 字段（WindowElement/ElementPredicate 均无） | 静态确认；`focused_element` 维持 unsupported_condition |

### 4.5.2 含激活污染的证据（仅作参考，不作为无前台影响能力的证明）

- probe18/19/20 在显式激活目标 app 后执行；其中 probe20 的“像素单位 + Background 命中”发生在已激活窗口上，属于污染证据，不能证明后台非抢焦点能力。坐标单位结论本身由越界拒绝的换算算术独立支撑（不依赖该次激活）。
- SDK Foreground 模式（route=GlobalInput 全局事件注入）的行为已测但**策略永久禁止**再用于测试。
- System Events keystroke 曾用于处理我自己实例的对话框 — 已停止。

### 4.5.3 待验证（需用户重新授权严格 Background 协议）

1. 像素坐标 Background 点击对"从未激活"窗口是否送达（SyntheticEvents 路由 vs AX 命中路由的分流条件）。
2. 会话宿主子进程的 macOS TCC 权限归属（B1 前置）。
3. Foreground/GlobalInput 路由行为 — 永不执行（策略禁止）。

### 4.5.4 产品实现决定（由 4.5.1 推出）

- `mapImagePoint`：sent 像素 → 窗口局部**点**（`inputBounds` 单位=点，原点=窗口左上全局点）。adapter 再乘以观察的 `sourceWidth/inputBounds.width`（=screenshotScale）得到驱动像素输入并取整、校验边界。
- 图片几何只在截图通道有效时可得（windowBounds 随截图返回）。
- AX 完整性以 `elementsComplete===true` 为准；false 即不完整（不依赖 truncated 标志）。

## 5. 未验证/待授权清单（A1 剩余项）

下表为 §4.5.3 之前的原始清单；其中前三项已由 §4.5.1 的实机证据解决，保留历史记录。

| 项 | 阻塞原因 | 解锁动作 |
|---|---|---|
| 1x/2x 截图与 Retina 像素关系、`screenshotScale` 实值 | 需真实窗口 | **已验证**（§4.5.1） |
| `windowBounds` 原点/单位（A3 `mapImagePoint` 的 inputBounds 单位判定） | 需真实窗口（非零原点窗口） | **已验证**（§4.5.1：全局点坐标） |
| window-target 坐标点击（Background `Coordinates`）与拒绝原始错误 | 需真实窗口 + `--allow-input` 授权 | **部分验证**：越界拒绝和坐标单位已测；未激活窗口的成功送达仍阻塞（§4.5.2） |
| AX 不完整（degraded/truncated）时 image/windowBounds 是否仍有效 | 需真实窗口 | **已验证**（§4.5.1：maxElements 截断时截图与 windowBounds 有效） |
| `focused_element` 可用性 | 静态已否定（§2.4） | 维持 `unsupported_condition`；无 SDK 状态可用 |
| 新 session 宿主 macOS 权限归属（探针结论 4） | 属 B1 前置且需实机 | 待严格 Background 协议授权 |

## 6. 局限与残余风险

- 本机 bun 1.4.0 ≠ 仓库基线 1.3.14；编译证据已双版本验证，但 CI/发布 runner 仍以 1.3.14 为准。
- socket 往返只验证了单连接、ping/pong、行分隔 JSON；B 计划的并发、背压、半包重组未在本探针范围。
- TERM 对纯 JS 死循环有效；对原生阻塞（Rust FFI 调用中）的回收语义未验证（无桌面授权下无法制造原生调用）。
- 探针的 SDK 解析在 dev 模式取 `packages/computer-runtime/node_modules` 相对路径（探针专用，非产品路径）；产品编译模式仍走 `sdk.ts` 的 sidecar 绝对路径逻辑，未改动。
- 未提交：按本轮运行指令，改动保持 uncommitted/unstaged；计划 A1 的“提交仅探针和证据文件”勾选框未勾。

## 7. 复现

```sh
bun install && bun run typecheck && bun test          # 基线 + 新 guard 测试
bun test tests/computer-use-probe-guard.test.ts       # 18 pass
bun scripts/probes/computer-use-agentic.ts            # no-target，driver 不启动
# 编译执行探针（见 §4 命令；私有临时目录为 cwd 运行）
```
