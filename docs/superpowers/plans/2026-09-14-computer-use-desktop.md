# Computer Use Desktop Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接出真实视觉兜底、可选缩图、短批次和本地条件等待，保留现有单步接口。

**Architecture:** runtime 统一原生数据投影、坐标与动作；CLI 负责公开参数和文件输出；E2E 直接复用 runtime。新增 observe，不改变旧 snapshot 的严格 AX 语义。

**Tech Stack:** Bun 1.3.14、TypeScript、Cua Driver 0.27.0、macOS arm64、PNG、系统 sips。

**Spec:** `docs/superpowers/specs/2026-09-14-computer-use-agentic-design.md`

## Global Constraints

- 同时阅读总计划 `2026-09-14-computer-use-agentic.md`。
- SDK 继续 lazy load，help/list/install 不加载 native。
- 不自动抢前台；不新增模型调用、代码审计或权限系统。
- 默认不缩图；保留同帧原图。图片坐标与窗口输入坐标不同，不默认乘 2。
- 任何未验证 SDK 能力必须作为 A1 阻塞项报告。
- 默认测试 desktop-free；计划中的真实操作只对明确指定的测试窗口进行。

> **接手状态（2026-09-16）：** 恢复检查点和当前主仓库 0.22.0 已整合到隔离分支；J1–J6 修复与验证见 `docs/verification/2026-09-16-takeover.md`。后续原生 Background 坐标与无 AX 画布已取得成功证据；真实取消发现的超时误分类已修复，完整原生矩阵仍待补测，见 `docs/verification/2026-09-16-native-acceptance.md`。真实模型性能验收尚未通过。勾选的实现任务不代表完整计划验收。

---

## 公共数据契约

以下声明放 `packages/computer-runtime/src/types.ts`；类型引用全部由同文件或已有声明提供。内部 NativeObservation 单独放 backend 文件，不输出到 api.d.ts。

```ts
export type ObservationMode = "auto" | "ax" | "image" | "both";
export type ChannelStatus = "usable" | "empty" | "degraded" | "truncated" | "unavailable";
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface ImageGeometry {
  sourceWidth: number;
  sourceHeight: number;
  sentWidth: number;
  sentHeight: number;
  inputBounds: Rect; // 该图片覆盖的窗口输入坐标矩形，不一定以屏幕原点起算
  windowBounds: Rect; // 用于变化检测
}
export interface Selector { text: string; match: "exact" | "contains"; role?: string }
export interface ObserveOptions {
  mode?: ObservationMode;
  maxDimension?: number;
  selector?: Selector;
}
export interface Observation {
  id: string;
  target: Target;
  capturedAt: number;
  epoch: string; // 每次driver生命周期不同
  revision: number; // 本地mutation启动即递增
  title: string;
  ax: { status: ChannelStatus; reason?: string; elements: AxElement[];
        total: number; returned: number; complete: boolean };
  image: { status: ChannelStatus; reason?: string; originalPath?: string;
           path?: string; frameValid?: boolean; geometry?: ImageGeometry };
}
export interface PointClick { observationId: string; x: number; y: number }
export type Condition =
  | { kind: "element_exists"; selector: Selector }
  | { kind: "element_value"; selector: Selector; value: string }
  | { kind: "window_exists" }
  | { kind: "focused_element"; selector: Selector };
export type BatchAction =
  | { kind: "click"; selector: Selector }
  | { kind: "click_point"; point: PointClick }
  | { kind: "type"; text: string; before?: Condition }
  | { kind: "key"; key: string; modifiers?: string[]; before?: Condition }
  | { kind: "scroll"; spec: ScrollSpec }
  | { kind: "wait"; condition: Condition; timeoutMs: number };
export interface BatchRequest {
  actions: BatchAction[];
  observe?: ObserveOptions;
  timeoutMs?: number;
  maxActions?: number;
}
export interface ActionReceipt {
  index: number;
  kind: BatchAction["kind"];
  status: "delivered" | "not_delivered" | "unknown" | "satisfied" | "not_run";
  error?: { code: string; message: string };
}
export interface BatchResult {
  status: "completed" | "interrupted" | "failed";
  steps: ActionReceipt[];
  observation?: Observation;
  observationError?: { code: string; message: string };
}
```

Computer 新增方法：

```ts
observe(target: Target, options?: ObserveOptions): Promise<Observation>;
clickPoint(target: Target, point: PointClick): Promise<void>;
batch(target: Target, request: BatchRequest): Promise<BatchResult>;
```

老 click/snapshot/waitFor 不改签名。focus condition 只有实际 SDK 证据可实现时才支持；否则返回 `unsupported_condition`。不将 AX selected 或“刚点过”伪装成焦点状态。before 是显式可选断言，不把未实现的焦点检查强加给所有 type/key。

## Task A1：锁定原生能力和编译执行证据

**Files**
- Read：SDK README、dist/native/cua_driver_contract.d.ts、`packages/computer-runtime/src/{cua-backend,session,sdk}.ts`
- Create：`scripts/probes/computer-use-agentic.ts`
- Create：`scripts/probes/computer-exec-compiled.ts`
- Create：`docs/verification/2026-09-14-computer-use-agentic-primitives.md`

**Interfaces**：产出坐标变换、帧有效性、后台拒绝、焦点支持及 compiled 执行的证据表；不直接修改产品接口。

- [x] 记录 SDK 精确版本及字段；以下是已确认的绑定形状，不是原生成功证据：

```ts
const position = new sdk.ClickPosition.Coordinates({ x: 10, y: 20 });
const input = sdk.ClickInput.new({
  target: new sdk.ActionTarget.Window({ pid, windowId }),
  position, deliveryMode: sdk.InputDeliveryMode.Background,
});
```

- [x] 为探针增加显式 `--pid`、`--window`、`--allow-input`。无 allow-input 只读；无目标不启动 driver。输出 windowBounds、screenshotScale、截图像素尺寸、screenshotFrameValid，不输出密码或完整应用内容。（守卫与隐私投影 desktop-free 已测；真实窗口下的字段取值见下一条，未验证）
- [ ] 在指定测试窗口测 1x/2x 截图、非零窗口原点、window-target 坐标、背景输入。任何不支持都记录 driver 原始错误，不用 foreground 重试。（历史探针含前台污染且仅证明后台 AX-token/typeText；未激活窗口的像素坐标 Background 成功与前台不变性仍未验证，见 verification §4.5）
- [x] 验证 AX 不完整但 image 有效能否取到；验证 `focused_element` 是否有真正可用的 SDK 状态，不把 selected 当焦点。（maxElements 截断时截图与 windowBounds 有效；契约无 focused 字段 → unsupported_condition）
- [x] 编译探针验证捕获 JS 字符串、await 和 IPC，无需桌面：

```ts
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const state = { count: 1 };
await new AsyncFunction("state", "state.count += await Promise.resolve(2)")(state);
if (state.count !== 3) throw new Error("compiled JS execution failed");
```

Run：`bun build --compile --target=bun-macos-arm64 --outfile=/tmp/yk-exec-probe scripts/probes/computer-exec-compiled.ts && /tmp/yk-exec-probe`。
- [x] 额外探针：同一 executable 子进程 socket 往返、无限循环进程可被 TERM/KILL 回收；先在私有临时目录执行，不用源码 cwd 的 preload。
- [x] 记录已验证/未验证/阻塞。没有测试窗口时只能完成静态和 compiled 无桌面部分，不宣称 A1 完成。（证据：`docs/verification/2026-09-14-computer-use-agentic-primitives.md`；A1 未完成）
- [ ] 提交仅探针和证据文件：`git commit -m "test: verify computer-use native and compiled contracts"`。

## Task A2：新增独立观察通道与按需取图

**Files**
- Modify：`packages/computer-runtime/src/{types,cua-backend,observe,session,index}.ts`
- Create：`tests/computer-observation.test.ts`
- Create：`tests/helpers/computer-fixtures.ts`

**Interfaces**
- Backend 新增 `observe(target, { accessibility: boolean, screenshot: boolean }): Promise<WindowStateOutput>`，WindowStateOutput 使用SDK的type-only导入，不加载native。
- `NativeObservation` 为 SDK `WindowStateOutput` 类型加元数据（仅 type import，不加载native），定义在 cua-backend.ts：

```ts
export type NativeObservation = WindowStateOutput & {
  observationId: string; capturedAt: number; epoch: string; revision: number;
};
```

session 在 Backend.observe 返回的SDK结果上注入这些元数据，生成 NativeObservation；不可让Backend自行生成与session无关的revision。
- `projectObservation(raw: NativeObservation, options: ObserveOptions): Observation` 将单次原始结果规范化；保存图片与补齐path在session层完成。若用type alias从SDK导入，不能把NativeObservation加入生成公开api列表。
- `Computer.observe` 按 mode 控制读路径：ax 不取图；image 不要求 AX；both 同次读取；auto 先 AX，不足时再取图并以第二帧作为最新观察。

- [x] 建 helper `makeNativeObservation(overrides)` 返回固定 target、1280×800 图像 metadata、两项 AX 元素；使用合成 PNG，不访问桌面。每个 test 自己的 epoch、目录和计数器独立。
- [x] 写失败测试：

```ts
const raw = makeNativeObservation({ degraded: true, degradedReason: "ax_partial" });
const view = projectObservation(raw, { mode: "both" });
expect(view.ax.status).toBe("degraded");
expect(view.image.status).toBe("usable");
expect(view.ax.complete).toBe(false);
```

还测 ax 模式 0 次截图、auto 的 usable AX 不截图、image 模式不因 AX 错误失败、空图/frameValid=false 不得 usable、权限异常仍抛出、selector 过滤保留 total/returned。
- [x] Run `bun test tests/computer-observation.test.ts`，确认失败是新能力缺失。（red→green 14/14）
- [x] 最小实现：raw 层不统一 throw degraded；旧 snapshot 包装器继续严格拒绝。`elementsComplete !== true` 不声称 complete；返回隐私清洗后的 AX。
- [x] 图片路径由现有 artifacts 模块保存，默认无缩放时只写一份；完整读取失败不能捏造空成功。
- [x] Run `bun test tests/computer-observation.test.ts tests/computer-runtime.test.ts tests/computer-use-act.test.ts && bun run typecheck`。（全绿）
- [ ] 提交：`git commit -m "feat: separate AX and image observation validity"`。

## Task A3：同帧缩图、坐标映射和观察凭据

**Files**
- Create：`packages/computer-runtime/src/{coordinates,observation-store}.ts`
- Modify：`packages/computer-runtime/src/{artifacts,session,index}.ts`
- Create：`tests/{computer-coordinates,computer-observation-store,computer-screenshot-scale}.test.ts`

**Interfaces**

```ts
export function mapImagePoint(point: Point, geometry: ImageGeometry): Point;
export interface ObservationStore {
  save(value: Observation): Promise<void>;
  get(id: string): Promise<Observation>;
  invalidate(target: Target): Promise<void>;
}
export function createObservationStore(root: string): ObservationStore;
export function resizeScreenshot(originalPath: string, maxDimension: number,
  signal?: AbortSignal): Promise<{ path: string; width: number; height: number }>;
```

观察目录属于用户 cache；原图、派生图、metadata mode=0600。ID 只能 UUID，路径只能由 store 根据 ID 生成，拒绝路径遍历。save 使用临时文件+rename。

- [x] 写映射失败测试：

```ts
const g: ImageGeometry = {
  sourceWidth: 2880, sourceHeight: 1800, sentWidth: 1440, sentHeight: 900,
  inputBounds: { x: 0, y: 0, width: 1440, height: 900 },
  windowBounds: { x: 80, y: 40, width: 1440, height: 900 },
};
expect(mapImagePoint({ x: 500, y: 300 }, g)).toEqual({ x: 500, y: 300 });
```

该例在输入单位为逻辑点时不是乘 2，防止把原始像素误当输入坐标。A1 决定 inputBounds 的实际单位。
- [x] Run `bun test tests/computer-coordinates.test.ts` 确认 red。
- [x] 实现纯函数并测非整数缩放、非零 inputBounds 原点：

```ts
// 在 finite、positive dimensions 和 0<=point<size 校验之后
return {
  x: g.inputBounds.x + point.x * g.inputBounds.width / g.sentWidth,
  y: g.inputBounds.y + point.y * g.inputBounds.height / g.sentHeight,
};
```

不提前舍入；仅在 SDK 要求整数时由 adapter 最后舍入并再次校验边界。
- [x] 写 store 测试：过期60s、窗口变形、同 ID 不同目标、失效标记、缺文件、损坏 JSON 都不能用于点击。跨进程 get 能找到前一个 CLI 保存的 metadata；跨epoch的记录只可经A4新帧验证后使用，不直接信任也不 blanket 拒绝所有跨命令观察。
- [x] SessionOptions 增加可注入 `observationStore?: ObservationStore` 和 `artifactsDir?: string`；默认使用用户cache，测试只用临时目录。
- [x] resize 测试注入进程 runner：默认不缩图不 spawn；显式缩图使用 `spawn('/usr/bin/sips', ['-Z', String(maxDimension), originalPath, '--out', outputPath])`，传 signal/timeout，校验输出 PNG 实际尺寸；失败不拿原图假装缩图成功。
- [x] 用内嵌合成 PNG 测真实 sips 生成（只在 macOS），其他平台明确 skip 该项；所有映射和 store 测试跨平台运行。
- [x] Run 上述三个 test 文件和 `bun run typecheck`（全绿；按本轮指令保持未提交） `feat: preserve screenshot geometry and observation provenance`。

## Task A4：视觉点击与投递语义

**Files**
- Modify：`packages/computer-runtime/src/{types,cua-backend,session,actions}.ts`
- Create：`tests/computer-point-click.test.ts`
- Modify：`tests/computer-runtime-budget.test.ts`

**Interfaces**
- Backend 新增 `clickPoint(target: Target, point: Point): Promise<ToolResultLike>`，内部用 SDK Coordinates + Window + Background。
- Session 的 Computer.clickPoint 取 observation、验证 target/TTL/几何/本地 revision，换算后下发。
- 跨命令视觉点击需新帧验证：重新取相同设置的窗口frame/image，比较几何及原始PNG的SHA-256。不同则 `stale_observation`；不将 snapshotId 相等假定为跨driver保证。
- 第一版不新增像素解码依赖，因此PNG编码变化也可能造成保守误拒绝。该限制写入文档并纳入实机指标；后续若要换成像素级比较，必须另有证据支持，不能在本任务静默放宽。

- [x] 写失败测试：失效观察不下发；有效观察经过 mapImagePoint；后台拒绝不触发 foreground；click 返回普通 ActionResult 不被误解析为 ToolResult refusal。

```ts
const calls: Point[] = [];
const session = createSessionWithBackend(fakeBackendFactory({
  clickPoint: async (_target, point) => { calls.push(point); return { isError: false }; },
}), { observationStore: store });
await expect(session.computer.clickPoint(target,
  { observationId: expiredId, x: 5, y: 5 })).rejects.toThrow(/stale_observation/);
expect(calls).toEqual([]);
```

`fakeBackendFactory` 在 A2 helper 新增：接收 Partial<Backend>，默认所有副作用记录到测试本地数组；不给真实 driver fallback。
- [x] Run `bun test tests/computer-point-click.test.ts` 确认 red。
- [x] mutation 启动即失效已有观察；clickPoint 先检查自己的输入观察，再失效。AX 点击继续 fresh lookup。支持 visual click→type，但第二次 visual click 需要新观察。
- [x] 修正当前 action 包装器把所有非 timeout 异常都标 not_delivered 的过度断言：已知拒绝才 not_delivered，未知原生异常保守 unknown。初始化/验证阶段未下发则 not_delivered。
- [x] 在 session 记录在途 promise（timeout/unknown 均 poison；Promise.race 不再解除），超时后 poison；不能因 Promise.race 返回就对同 driver 发新观察。清理等待或失败有明确状态。
- [x] Run `bun test tests/computer-point-click.test.ts tests/computer-runtime-budget.test.ts tests/computer-runtime.test.ts && bun run typecheck`。（全绿）
- [ ] 提交 `feat: add evidence-bound background coordinate clicks`。

## Task A5：有限 Batch、本地等待和请求记录

**Files**
- Create：`packages/computer-runtime/src/{batch,conditions,request-journal}.ts`
- Modify：`packages/computer-runtime/src/{types,session,index}.ts`
- Create：`tests/{computer-batch,computer-conditions,computer-request-journal}.test.ts`

**Interfaces**
- `validateBatch(value: unknown): BatchRequest` 在任何 driver 调用前验证全部 actions、字符串长度、有限坐标、预算和数量。
- `runBatch(computer: Computer, target: Target, request: BatchRequest, signal?: AbortSignal): Promise<BatchResult>`。
- `evaluateCondition(condition: Condition, observation: Observation): boolean`；focused_element 无支持则抛 unsupported_condition。
- `createRequestJournal(root: string): RequestJournal` 创建日志接口；方法为 `claim(id: string, hash: string): Promise<"new" | "existing" | "conflict">`、`append(id: string, event: RequestEvent): Promise<void>`、`read(id: string): Promise<RequestRecord>`。
- RequestEvent 定义为 `{ seq: number; time: number; type: "request_started" | "action_started" | "action_finished" | "request_finished"; payload: Record<string, unknown> }`；decoder校验各type的payload。RequestRecord为 `{ hash: string; status: "running" | "completed" | "failed" | "interrupted" | "unknown"; events: RequestEvent[]; result?: unknown }`，result按操作类型解析。
- 存储事件为 SSOT，同 ID 单写者，atomic mkdir 占有 request；进程死亡的 started 记 unknown，不重新 claim。B 按session私有目录复用该模块，不另写第二套去重。
- JSON 线上 windowId 为十进制字符串，转换集中一个 codec；传给 Computer 才为 bigint。

- [x] 写失败测试：

```ts
const order: string[] = [];
const computer = fakeComputer({
  type: async () => { order.push("type"); },
  key: async () => { order.push("key"); throw new ComputerError("command_timeout", "key timeout", "unknown"); },
});
const result = await runBatch(computer, target, { actions: [
  { kind: "type", text: "abc" }, { kind: "key", key: "Return" },
  { kind: "type", text: "must not run" },
] });
expect(order).toEqual(["type", "key"]);
expect(result.steps.map(s => s.status)).toEqual(["delivered", "unknown", "not_run"]);
```

helper fakeComputer 实现 Computer 所有方法，observe 返回 A2 fixture，单独统计 observeCount，其他默认 no-op；没有真实 SDK 路径。
- [x] 测两步正常结束只回一次最终观察；点击内部 AX 查询不计为 LLM 观察。最终观察失败保留 delivered receipts，不回滚状态。
- [x] 测完整预校验：第三步无效导致第一步也不执行；5步默认上限和显式20上限；参数错误不启动 native。
- [x] Run `bun test tests/computer-batch.test.ts tests/computer-conditions.test.ts tests/computer-request-journal.test.ts` 确认 red。（red→green）
- [x] 实现串行 executor：失败填满剩余 not_run；unknown 不在 poisoned session 继续取图；最终读取仅在 driver idle 且可用时进行。每步 timeout 不得超出总 deadline。
- [x] wait 本地轮询新 AX，不回 LLM；element_value 必须唯一匹配；degraded/truncated 不作为 condition 成功；focused_element unsupported 明确失败。type/key 的 before 存在时必须满足，不存在时不伪称焦点已验证。
- [x] Journal 测两个进程相同 request-id 只有一个执行、同ID不同hash冲突、截断尾行和sequence错误 fail loud、reply 丢失后返回已有终态。
- [x] Run 三个 tests、runtime-budget 回归和 typecheck（全绿；保持未提交） `feat: execute bounded action batches with partial receipts`。

## Task A6：CLI、E2E 消费端及文档同步

**Files**
- Modify：`packages/functions-computer-use/src/{args,commands,index}.ts`
- Create：`packages/functions-computer-use/src/{batch-command,observe-command}.ts`
- Modify：`packages/functions-computer-e2e/src/{types,worker}.ts`
- Modify：`scripts/generate-computer-e2e-api.ts`
- Regenerate：`skills/computer-e2e/references/api.d.ts`
- Modify：`skills/computer-use/SKILL.md`、`docs/computer-use.md`、`README.md`
- Create：`tests/{computer-use-batch-cli,computer-api-generation}.test.ts`
- Modify：`tests/computer-use.test.ts`

**Interfaces**：总计划的 observe、point-act、batch 命令；所有新结果 schemaVersion=1，旧单步 JSON 不换结构。

- [x] 写解析失败测试：

```ts
expect(() => parseRequest("act", ["--pid", "1", "--click-x", "2", "--click-y", "3"]))
  .toThrow(/observation/);
expect(() => parseRequest("act", ["--pid", "1", "--type", "x", "--key", "Return"]))
  .toThrow(/exactly one/);
```

补旧 `--x/--y` 只用于 scroll；新 click 用 click-x/click-y，避免静默改变已有 flags。
- [x] Run CLI tests 确认 red。
- [x] 新文件只负责 command orchestration；动作与 selector 共享逻辑下沉 runtime，旧 clickPredicate 可委托 shared selector，不在新 CLI 复制。
- [x] JSON 文件读取和 hash 固定发生在调用 driver 前。batch CLI 基于 RequestJournal 去重，结果 failed/interrupted 为非零 exit，stdout/stderr 契约明确；既有 post_action_observe_failed 保留。
- [x] API 生成器纳入本计划类型及嵌套依赖，生成后用独立 `tsc --noEmit --skipLibCheck false` 编译一个 import 类型/调用新方法的 fixture；若简易提取器截断 multiline union，只改生成提取逻辑，不手改产物。
- [x] 更新 E2E action kind（含 click_point），history reduction 保持开放 payload/正确计数；capture 旧语义保留，新视觉案例可调用 computer.observe，不偷偷改现有 AX dump。
- [x] skill 改为“确定动作短批次，未知状态先观察”；给 click→type、visual click→type、失败不可重放三个完整示例。不再说“每轮只能一个动作”，也不声称自动数值置信度。
- [x] Run `bun scripts/generate-computer-e2e-api.ts && bun test tests/computer-use-batch-cli.test.ts tests/computer-api-generation.test.ts tests/computer-use.test.ts tests/computer-e2e-suite.test.ts tests/computer-e2e-history.test.ts && bun run typecheck`。
- [ ] 提交 `feat: expose visual observation and batch CLI`；A 交付时列出原生验证结果，A1 未完成不进入 B。
