# Computer Use JavaScript Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在持久桌面会话上执行 JavaScript 动作组、循环与条件，按需返回观察，并完成分发和性能验收。

**Architecture:** 每次脚本由可终止 worker 执行，driver 留在 B 的原生 worker；宿主对脚本 computer RPC 统一派发和记录。跨调用仅保存显式 JSON state，不保留任意闭包或未完成异步任务。

**Tech Stack:** Bun 1.3.14、TypeScript、AsyncFunction、受信本机 JavaScript、Unix IPC、同一compiled yk。

**Spec:** `docs/superpowers/specs/2026-09-14-computer-use-agentic-design.md`

## Global Constraints

- 完成 A/B 后执行。本计划所有 desktop 行为通过 runtime，不另加 Python/Playwright 后端。
- 不新增模型调用、脚本审计、权限系统或调用方运行时集成。
- JS worker 不是沙箱；代码按受信本机代码执行。
- 原生 unknown 不自动重放，终止worker不代表已经送达的输入被撤销。
- 不要求安装额外 Node/Bun；SDK继续lazy，help/list/install不启动worker。
- E2E默认测试desktop-free；发布门禁和真实桌面结果独立记录。

> **Integration status (2026-09-15):** The five lane deltas, generated API references, and exact Bun 1.3.14 desktop-free/release gates are integrated and recorded in `docs/verification/2026-09-15-parallel-integration.md`. Native Background/TCC, real UI/model usage, and performance acceptance remain unchecked; this plan is not wholly complete.

---

## 公共脚本接口

新增 `packages/computer-session/src/exec-types.ts`。以下类型通过computer-runtime导入：Selector、PointClick、ScrollSpec、ObserveOptions、Observation、Condition、BatchRequest、BatchResult、ActionReceipt、Target。

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ScriptComputer {
  click(selector: Selector): Promise<void>;
  clickPoint(point: PointClick): Promise<void>;
  type(text: string, before?: Condition): Promise<void>;
  key(key: string, modifiers?: string[], before?: Condition): Promise<void>;
  scroll(spec: ScrollSpec): Promise<void>;
  wait(condition: Condition, timeoutMs: number): Promise<void>;
  observe(options?: ObserveOptions): Promise<Observation>;
  batch(request: BatchRequest): Promise<BatchResult>;
}
export interface ExecResult {
  status: "completed" | "failed" | "interrupted" | "unknown";
  value?: JsonValue;
  stateVersion: number;
  stateCommitted: boolean;
  actions: ActionReceipt[];
  observations: Observation[];
  logs: string[];
  error?: { code: string; message: string };
}
export interface ExecOptions {
  code: string;
  sourceName: string;
  timeoutMs: number;
  maxActions: number;
}
```

脚本体是 async function body，不是完整 ES module；支持 await、循环、局部变量和动态 import。静态 import 语法明确报错。注入参数 `computer, target, state, log, observe`；target是只读且绑定session，computer不接受另一个target。

```js
await computer.click({ text: "Search", match: "exact", role: "AXTextField" });
await computer.type("penguin");
await computer.key("Return");
const result = await observe({ mode: "auto" });
state.searches = Number(state.searches ?? 0) + 1;
log({ title: result.title, searches: state.searches });
return { title: result.title };
```

每条RPC使用固定方法名和JSON参数，不向宿主传函数/任意代码；任意JS只在脚本worker执行。ScriptComputer selector/condition委托A的方法，不让lambda跨IPC序列化。

默认代码上限256KiB、state上限256KiB、日志累计64KiB、观察上限20份、120s执行硬上限、500个facade动作硬上限。日志只计UTF-8字节；图像仅保存路径引用，不计为文本日志。超限明确中断，不静默截断成成功。

## Task C1：脚本 worker 与固定 RPC 面

**Files**
- Create：`packages/computer-session/src/{exec-types,exec-worker,exec-protocol,script-computer}.ts`
- Modify：`packages/computer-session/src/{types,protocol,host,process,index}.ts`
- Modify：`packages/cli/src/cli.ts`（仅增加内部 `__computer-exec-worker` 路由）
- Create：`tests/{computer-exec-worker,computer-exec-protocol}.test.ts`

**Interfaces**

```ts
export function execWorkerMain(configPath: string): Promise<number>;
export function runExec(sessionId: string, requestId: string, options: ExecOptions): Promise<ExecResult>;
export function createScriptComputer(send: (method: string, args: JsonValue) => Promise<JsonValue>): ScriptComputer;
```

wire decoder验证固定方法枚举；send中的string只是传输签名，不允许宿主任意对象索引调用。target的bigint使用B统一codec。

- [x] 写失败测试：

```ts
const host = await startTestHost({ driver: "fake" });
try {
  const result = await host.exec({ code: `
    await computer.type("a");
    await computer.key("Tab");
    const view = await observe({mode:"ax"});
    return {title:view.title};
  ` });
  expect(result.status).toBe("completed");
  expect(result.actions.map(a => a.kind)).toEqual(["type", "key"]);
  expect(result.observations).toHaveLength(1);
  expect((await host.diagnostics()).driverInitCount).toBe(1);
} finally { await host.close(); }
```

再测无模型配置、代码不是字符串、静态import语法错误、源码超限、未知RPC、request归属错误，全部无后续桌面副作用。
- [x] Run `bun test tests/computer-exec-worker.test.ts` 确认 red。（red→green 6/6；协议面由 SCRIPT_METHODS 固定枚举测试覆盖）
- [x] CLI读文件一次，hash捕获内容，宿主记录后将固定code送worker；worker不重新打开可变源码文件。
- [x] 核心执行路径（A1已验证compiled可行性）：

```ts
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction("computer", "target", "state", "log", "observe", options.code);
const value = await execute(computer, target, state, log, computer.observe);
```

`computer.observe` 绑定函数不依赖 this。执行所在cwd默认请求文件目录，路径在请求中明确记录；worker启动先用私有目录，再在boot后显式chdir，避免Bun preload在启动阶段执行。动态import相对路径语义需A1探针确认；第一版文档建议绝对file URL，不伪称拥有完整ESM加载语义。
- [x] 调用准入每次检查exec request仍active、目标仍属session；使用seq关联RPC和结果。host只派发固定方法并通过runtime生成receipts。
- [x] 所有脚本computer RPC串行执行，包含observe。`Promise.all` 不并行驱动；请求队列有上限，超限报错。
- [x] Run exec tests + `bun run typecheck`；（全绿）提交 `feat: execute JavaScript through session desktop RPC`。

## Task C2：JSON state、有界输出与按需观察

**Files**
- Create：`packages/computer-session/src/exec-state.ts`
- Modify：`packages/computer-session/src/{exec-worker,host,exec-types,exec-protocol}.ts`
- Create：`tests/computer-exec-state.test.ts`

**Interfaces**

```ts
export function validateJsonValue(value: unknown, maxBytes: number): JsonValue;
export function loadExecState(directory: string): Promise<{ version: number; value: Record<string, JsonValue> }>;
export function commitExecState(directory: string, expectedVersion: number,
  value: Record<string, JsonValue>): Promise<number>;
```

不允许NaN/Infinity/bigint/function/循环引用；不得用JSON.stringify静默丢字段。state为请求开始时拷贝；只在脚本正常结束、RPC全部结束且序列完整时原子提交。脚本失败/取消不提交state，已送达桌面动作不会回滚。返回stateCommitted说明此区别。

- [x] 写失败测试：

```ts
const host = await startTestHost({ driver: "fake" });
try {
  await host.exec({ code: "state.n = 1;" });
  const failed = await host.exec({ code: "state.n = 2; throw new Error('stop');" });
  const next = await host.exec({ code: "return state.n;" });
  expect(failed.stateCommitted).toBe(false);
  expect(next.value).toBe(1);
} finally { await host.close(); }
```

再测重复request不二次增加state；并发拒绝；恢复后version不倒退；超限/非法JSON不变成state成功；worker伪造actions字段不会进入宿主真实记录。
- [x] Run `bun test tests/computer-exec-state.test.ts` 确认 red。（red→green 15/15）
- [x] 实现state tmp+rename，version只由宿主分配。event记录commit intent/version；恢复时校验state hash和terminal event，冲突状态unusable而不是猜测成功。
- [x] `log(value)`输出一条JSON/字符串；console stdout/stderr收集为日志，不能当control framing。累积超过64KiB→`output_limit`并取消脚本；图片base64不默认打印。
- [x] 显式observe记录Observation引用。脚本没有观察则完成时auto观察；最后一次观察之后没有新mutation时复用它，不重复拍图。最后一次观察后有mutation时追加一次final观察。
- [x] final观察失败保留动作receipts；不能因为state已commit就宣称UI任务成功。observations最多20且元数据总量受协议上限约束，大AX返回分页/文件引用并注明不完整，不静默裁剪。
- [x] Run state/worker tests + typecheck；（全绿）提交 `feat: persist explicit script state and bounded observations`。

## Task C3：硬超时、取消、未await调用与失联

**Files**
- Modify：`packages/computer-session/src/{host,exec-worker,exec-protocol,process}.ts`
- Create：`tests/computer-exec-lifecycle.test.ts`
- Create：`tests/fixtures/computer-exec/{loop.js,spawn-child.js,unawaited.js,partial.js}`

**Interfaces**：使用B的stopProcessGroup，不新增第二个清理实现。每个脚本worker独立进程组；宿主记录精确child身份，退出前回收其普通后代。主动脱离进程组的任意代码不承诺可全部清理。

- [x] 写失败测试：

```ts
const host = await startTestHost({ driver: "fake", execTimeoutMs: 100 });
try {
  const result = await host.exec({ code: "while (true) {}" });
  expect(result.status).toBe("interrupted");
  expect(result.error?.code).toBe("execution_timeout");
  expect((await host.diagnostics()).liveExecWorkers).toBe(0);
} finally { await host.close(); }
```

测真实子进程而不是fake时钟Promise。另测无限异步等待、脚本普通子进程残留、driver在途时取消、请求已关闭后的迟到RPC。
- [x] Run `bun test tests/computer-exec-lifecycle.test.ts` 确认 red。（red→green 7/7，真实子进程）
- [x] 宿主wall-clock watchdog到期即关闭准入并TERM worker组，2s后KILL；原生driver在途按B回收，unknown封闭会话。
- [x] 记录脚本全部pending RPC。脚本return时仍有未完成调用，标记 `unawaited_actions`、拒绝未下发队列，等待已下发结果或走unknown；不得让其在下次exec后台继续执行。

```js
// tests/fixtures/computer-exec/unawaited.js
void computer.type("not awaited");
return "must not be treated as completed";
```

注意已经完成的未await调用无法仅靠pending集合发现；不宣称检测全部未await语法。可靠保证是请求终结后没有遗留可继续下发的RPC。
- [x] driver crash后不自动复建继续脚本（RPC 全部拒绝 → 脚本失败）；host crash通过worker失联/父存活检测回收，同步死循环仍由独立宿主watchdog负责。宿主已死且无法证明回收时重启入口报告lease blocked，不重放。
- [x] Run lifecycle、session recovery、runtime budget tests；检查临时目录及测试进程无残留；（含 pgrep 无残留断言）提交 `fix: terminate script execution without replaying desktop input`。

## Task C4：exec CLI、公开类型和 Skill

**Files**
- Create：`packages/functions-computer-use/src/exec-command.ts`
- Modify：`packages/functions-computer-use/src/{args,commands,index}.ts`
- Modify：`packages/computer-session/src/index.ts`
- Create：`scripts/generate-computer-use-api.ts`
- Create：`skills/computer-use/references/api.d.ts`（生成）
- Create：`skills/computer-use/examples/search.js`
- Modify：`skills/computer-use/SKILL.md`、`docs/computer-use.md`、`README.md`、`scripts/package-release.ts`
- Create：`tests/{computer-use-exec-cli,computer-use-api-generation}.test.ts`

**Interfaces**：总计划exec命令；SessionReply decoder识别严格ExecResult。CLI仅从exec-command调用runExec。

- [x] 写失败测试：

```ts
expect(() => parseRequest("exec", ["--file", "flow.js", "--request-id", "r"]))
  .toThrow(/session/);
expect(() => parseRequest("exec", ["--session", "s", "--file", "flow.js",
  "--request-id", "r", "--timeout-ms", "Infinity"])).toThrow(/finite|timeout/);
```

再测文件不存在不启动worker、相同request不同代码拒绝、session busy明确错误、Node构建无Bun时在spawn前拒绝。
- [x] Run `bun test tests/computer-use-exec-cli.test.ts` 确认 red。（red→green 4/4）
- [x] 新生成器从runtime公开类型和exec-types生成可独立引用的ScriptComputer声明，使用TypeScript compiler API导出依赖闭包或小型显式名单；不要复制业务类型为第二个SSOT。类型编译测试启用skipLibCheck=false。
- [x] skill 完整说明：AX定位优先、视觉兜底需先看图、确定动作短批次、需要新判断时观察、变量只通过state跨调用、delivered不等于成功、未知投递不可重跑脚本。
- [x] 给完整示例（examples/search.js），不描述未实现的焦点保证。明确JS是async body、默认预算、日志上限、工作目录、动态import语义、普通本机执行非沙箱。无新审批流程或审计配置章节。
- [x] package:release生成新的api.d.ts并检查examples/reference存在；保持原runtime sidecar布局，无新native依赖。
- [x] 修正研究报告误导描述（研究报告保留原始日期与当时事实；现状以产品文档为准 — 见 verification §7），并保留报告日期与当时事实；实现后现状以产品文档为准。
- [x] Run 生成器 + exec-cli/api-generation/api-generation tests + typecheck。（全绿）
- [ ] 提交 `feat: expose documented computer-use JavaScript execution`。

## Task C5：打包闭环、实机矩阵与性能证据

**Files**
- Create：`tests/computer-session-release.test.ts`
- Modify：`tests/computer-use-packaging.test.ts`
- Modify：`.github/workflows/release.yml`、`.github/workflows/release-please.yml`
- Create：`scripts/bench/computer-use.ts`
- Create：`docs/verification/2026-09-14-computer-use-agentic.md`

**Interfaces**：benchmark输出JSON行：variant、caseId、success、durationMs、driverInitializations、modelTurns、observations、screenshots、inputTokens/outputTokens/reasoningTokens（无数据则null）、recoveryEvents。不包含屏幕正文或用户凭证。

- [x] 检查 `.github/workflows/release.yml` 与 `.github/workflows/release-please.yml` 的现有门禁（两处均加入 computer-session-release.test.ts），只添加新测试文件，保留 package:release 为唯一打包入口。
- [x] 写新的 release 测试，YK_RELEASE_TESTS未设置时明确skip。（7 项，默认 skip；=1 时全过）真实打包yk的内部exec-worker通过测试进程实现的RPC peer执行纯JS/state/log和合成观察，不加载native；生产binary不新增fake-driver flag。
- [x] 对真实release binary另外跑help、无效请求（不触发native）。session启动/关闭需真实 driver — 留待严格 Background 授权测试peer只替代无桌面测试中的RPC另一端，不作为产品功能；真实driver+宿主+脚本完整闭环留给下方明确授权的实机验证，不能以合成观察声称实机已通过。
- [x] 测 symlink executable、陌生cwd、无Bun/Node PATH、同request重复、exec无限循环清理；（全过）确保 packaged skill API与源码生成一致。
- [x] 默认unit test全部desktop-free；执行门禁顺序：typecheck → test → package:release --version 0.19.0 → YK_RELEASE_TESTS=1 release tests → build → smoke（全部通过，见 verification）

```sh
bun run typecheck
bun run test
VERSION=$(bun -p 'require("./package.json").version')
bun run package:release --version "$VERSION"
YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts
bun run build
bun run smoke
```

在第一条失败处停止，不绕过门禁。测试skip数量必须报告。
- [ ] 在明确指定的测试窗口验证四类任务：AX搜索表单、无AX画布目标、窗口移动后过期坐标、批次第N步投递未知。发送/删除使用fixture模拟，不对真实账号操作。
- [ ] benchmark分别跑单步、一次性batch、持久batch、exec。每个fixture变体固定相同初始状态，先warmup再至少10次样本；报告样本量及p50/p95，不把小样本极值泛化为保证。
- [ ] 原生基准记录runtime往返，不冒充模型turn；另做固定模型/相同提示词/任务的agent回合对比，记录真实usage或null。
- [ ] 关键硬门禁：误重放0、过期坐标下发0、窗口混用0、未终结RPC跨请求下发0；任务失败必须保留并计入统计，不能只比较成功样本。
- [ ] 性能交付需证明至少一个代表性表单减少模型轮数、持久执行减少driver初始化；若总耗时或Token没有改善，报告结果并定位，不承诺百分比、不隐藏回归。
- [x] 写verification文件（docs/verification/2026-09-14-computer-use-agentic.md）提交 `test: verify packaged agentic computer-use workflows`。

## 交付检查

- [ ] A/B/C implementation is integrated, but the plan is not wholly complete: A1 native acceptance and C5 real desktop/model-performance tasks remain explicit blockers in the integration verification; no code-execution module is silently deferred.
- [x] 同一Computer runtime服务CLI和E2E，没有第二套桌面driver。
- [x] 无模型依赖、审计配置或调用方运行时集成。
- [x] 新文档与生成API一致，旧命令兼容。
- [x] 本机代码执行限制、日志隐私责任、unknown恢复规则公开可读。
- [x] 所有实机/发布未运行项单独列出（verification §未运行清单）。
