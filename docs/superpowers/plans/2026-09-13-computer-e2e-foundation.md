# Computer-E2E 通用能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仅通过 yk 和可安装 Skills，提供共享桌面操作、无消费方依赖的固定代码回放、执行历史和报告。

**Architecture:** computer-use 与 computer-e2e 共用私有 computer-runtime workspace；消费方不 import workspace 或 SDK。E2E 主进程负责记录和监督，用同一 yk 自启动工作进程加载外部 Suite 文件并连续运行；不存在逐动作 CLI 子进程或外部 Node 运行时。先验证编译后外部模块加载，不成立则停止，不用 npm 安装方案代替。

**Tech Stack:** Bun 1.3.14 编译 yk，TypeScript，Node 内置模块，Cua Driver 0.27.0，macOS arm64。

**Spec:** `docs/superpowers/specs/2026-09-13-computer-e2e-design.md`（与本计划一起阅读；接口定义以 spec §5 为准）。

## Global Constraints

- 对外交付仅为 yk、随包 runtime/ 和 yk install 安装的 Skills；不增加消费方 npm install、Node、Bun、Vitest 或 SDK 安装要求。
- 首版真实桌面仅支持 macOS arm64；ya-skills 开发/发布使用 Bun 1.3.14；Cua Driver/native 固定 0.27.0，@ubjs/core 与 @ubjs/node 固定 0.31.0-3。
- computer-use 与 computer-e2e 共用一份内部桌面操作实现；不发布新的 npm 包，不新增 daemon，不逐动作启动 CLI。
- E2E 运行受用户显式授权；计划执行和普通单元/打包测试不得启动真实应用、读取真实桌面或创建真实后端会话。
- 点击后台投递；禁止自动激活、自动前台回退、歧义选第一个、失败后盲目重放；只有明确未投递的 stale_element_token 可重新观察并重试一次。
- 固定回放每次重新观察和定位；不持久化元素 token 供下次操作使用；通过条件来自显式断言而非动作返回成功。
- 测试文件是受信任的可执行代码，不是沙箱；导入、收集阶段禁止应用启动及桌面副作用，不自动安装缺失依赖。
- 真实运行串行；普通回归不调用 LLM、不自动改用例；超时/中断中未确认的动作记 actionOutcome=unknown，禁止重放。
- 单次桌面操作预算 30000ms；E2E 用例默认预算 30000ms、可显式覆盖；终止时工作进程共享清理宽限 15000ms，其中驱动清理预算最多 5000ms。
- 所有运行结果必须区分 passed、failed、skipped、not_run、interrupted；存在跳过或未执行不能报告全部通过。
- 报告和证据归运行项目；目录 0700、文件 0600；不记录完整环境、凭据或输入动作正文，不承诺自动遮挡截图中的敏感内容。
- 只修改 ya-skills 与 cowork-e2e；不修改 cowork-app 源码，不自动发布、合并或推送，不改 Homebrew tap。

---

## 0. 执行前状态与文件职责

2026-09-13 实测基线：本计划所在 checkout `/Users/phaethon/workspace/personal/ya-skills-cu`，`feat/computer-use@ef132fb`；原 ya-skills main 尚未包含此功能。必须从该功能基线继续或先由用户整合它，不能从 main 假定文件已存在。

当前有两项 tracked deletion：`ya-skills-v0.18.0-macos-arm64.tar.gz`、同名 `.sha256`。它们是上次误提交的生成物，不是干净工作区。不要恢复/下载 44MB 文件掩盖状态，也不改写历史。执行时先展示 diff，并获得用户对移除生成物的确认；隔离工作区按 using-git-worktrees 流程处理，不直接要求工具在脏工作区分配 worktree。

旧测试 `tests/computer-use-act.test.ts` 的 artifacts 测试会创建并删除用户默认缓存目录；旧 packaging 测试在 dist 存在时会访问真实 Finder。Task A1 在运行全量测试前先隔离这两类行为。此前“200 测试通过”不作为本计划验收证据。

| 路径 | 职责 |
|---|---|
| `scripts/probes/compiled-e2e-loader.ts` | 一次性、无桌面的编译可行性探针 |
| `docs/research/2026-09-13-compiled-e2e-loader.md` | 探针命令、退出码、输出、局限 |
| `packages/computer-runtime/src/types.ts` | 与应用无关的 Computer / Target / Snapshot 类型 |
| `packages/computer-runtime/src/sdk.ts` | 唯一 SDK 加载与编译 sidecar 定位 |
| `packages/computer-runtime/src/session.ts` | 懒 session、共享预算、关闭与中止 |
| `packages/computer-runtime/src/cua-backend.ts` | SDK 输入构造、ToolResult 检查、后台投递 |
| `packages/computer-runtime/src/observe.ts` | 元素归一化、隐私、唯一窗口 |
| `packages/computer-runtime/src/actions.ts` | 唯一匹配、一次 stale 恢复、等待结果 |
| `packages/computer-runtime/src/artifacts.ts` | 私有绝对路径证据文件 |
| `packages/computer-runtime/src/index.ts` | 私有 workspace 出口，不对 npm 发布 |
| `packages/functions-computer-use/src/` | 现有命令/参数/JSON 信封，仅调用共享实现 |
| `packages/functions-computer-e2e/src/types.ts` | Suite、CaseContext、RunEvent、RunSummary |
| `packages/functions-computer-e2e/src/suite.ts` | 校验与顺序执行、hook/skip/step |
| `packages/functions-computer-e2e/src/worker.ts` | 外部文件 import、fd3 事件、退出清理 |
| `packages/functions-computer-e2e/src/supervisor.ts` | 自启动、墙钟监督、信号、工作进程组 |
| `packages/functions-computer-e2e/src/history.ts` | 目录、事件归约、JSON/Markdown 报告 |
| `packages/functions-computer-e2e/src/args.ts` | 严格 run/history/report 参数 |
| `packages/functions-computer-e2e/src/commands.ts` | 三个公共命令与退出码 |
| `packages/functions-computer-e2e/src/index.ts` | workspace 出口，导入不得触 native |
| `skills/computer-e2e/` | 通用 Skill、完整本地参考、无应用示例 |
| `tests/computer-runtime*.test.ts` | 假 backend 测试 |
| `tests/computer-e2e*.test.ts` | 纯执行器、监督与发布包测试 |
| `tests/fixtures/computer-e2e/` | 无桌面的外部 Suite 文件 |

不要为每种应用建插件系统。目标项目通过 Suite hooks 和闭包保存 app handle；共享接口只接收 pid/windowId、谓词、预算。

## Task A1: 验证编译加载路径，并建立不会碰桌面的验证基线

**Files:**
- Create: `scripts/probes/compiled-e2e-loader.ts`
- Create: `tests/fixtures/computer-e2e/pure.e2e.ts`
- Create: `tests/fixtures/computer-e2e/value.ts`
- Create: `docs/research/2026-09-13-compiled-e2e-loader.md`
- Create: `tests/computer-use-native.test.ts`
- Modify: `tests/computer-use-act.test.ts`, `tests/computer-use-packaging.test.ts`, `.gitignore`, `tsconfig.json`

**Interfaces:**
- Consumes: Bun 1.3.14 编译器；spec §4 的验证条件。
- Produces: 明确的可行/阻断结论与完整命令证据；可安全运行的纯测试基线。探针不是产品接口。

- [x] **Step 1: 先修正测试隔离，不运行旧全量测试。** artifacts 测试仅检查 `defaultArtifactsDir()` 返回值；所有写入在 `mkdtemp` 返回目录内，finally 只删除该目录。用以下骨架替换默认缓存写入/删除测试；`saveScreenshot`/`ensureOutDir` 使用现有导出。

```ts
const temp = await mkdtemp(join(tmpdir(), 'yk-artifacts-'));
try {
  const dir = ensureOutDir(join(temp, 'nested'));
  const file = saveScreenshot(dir, Buffer.from('png').toString('base64'));
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(defaultArtifactsDir()).toContain('Library/Caches/ya-skills/computer-use');
} finally {
  await rm(temp, { recursive: true, force: true });
}
```

将旧 Finder `apps` 探测从默认 packaging 测试移到 `tests/computer-use-native.test.ts`，仅 `YK_CU_NATIVE_TESTS=1` 时启用；默认报告该项 skip。root tsconfig 的 exclude 添加 `tests/fixtures/computer-e2e/**`，因为这些外部fixture包含故意语法错误和运行期`.ts`相对导入；它们由加载测试验证，不纳入生产代码tsc。hostile-cwd 的默认验证改为纯加载 fixture，不访问桌面。生成物 ignore 添加 `ya-skills-v*-macos-arm64.tar.gz*`；用户确认后仅 stage 上述两个已删除生成物，禁止 `git add -A`。

- [x] **Step 2: 写外部文件和探针。** `value.ts` 内容 `export const value: number = 42;`；`pure.e2e.ts` 如下。首先用不存在的 probe 可执行文件运行，记录非零退出，确保验证不是误用系统 Bun/Node。

```ts
import assert from 'node:assert/strict';
import { value } from './value.ts';
export default async function run() {
  assert.equal(value, 42);
  console.log('EXTERNAL_SUITE_OK');
}
```

探针的受控工作分支：

```ts
import { spawn } from 'node:child_process';
import { realpathSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [mode, file] = process.argv.slice(2);
if (mode === 'worker') {
  const module = await import(pathToFileURL(file!).href);
  await module.default();
  writeSync(3, JSON.stringify({ type: 'finished' }) + '\n');
} else if (mode === 'parent') {
  const child = spawn(realpathSync(process.execPath), ['worker', file!], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(process.stdout);
  child.stderr!.pipe(process.stderr);
  child.stdio[3]!.on('data', (chunk) => process.stdout.write(chunk));
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  throw new Error('expected parent|worker and external file');
}
```

- [x] **Step 3: 在 Bun 1.3.14 下编译并运行无依赖目录。** `BUN_1314` 必须是已核对 `--version` 的绝对路径；不能把当前 1.4.0 结果当作 1.3.14 结果。

```sh
"$BUN_1314" --version
"$BUN_1314" build --compile --target=bun-macos-arm64 \
  --compile-autoload-package-json \
  --outfile=/tmp/yk-e2e-loader-probe scripts/probes/compiled-e2e-loader.ts
probe_dir=$(mktemp -d)
cp tests/fixtures/computer-e2e/{pure.e2e.ts,value.ts} "$probe_dir/"
(cd "$probe_dir" && env -u NODE_PATH -u NODE_OPTIONS -u BUN_OPTIONS PATH=/usr/bin:/bin \
  /tmp/yk-e2e-loader-probe parent "$probe_dir/pure.e2e.ts")
```

Expected: `EXTERNAL_SUITE_OK`、`{"type":"finished"}`、退出 0；目录没有 node_modules。同样验证 `.mjs`；文件语法错误、导入不存在模块必须非零且不尝试下载。构造 package.json 的 preinstall/prepare 以及 bunfig preload sentinel，确认仅导入用户明确选择的文件，不自动执行 cwd 配置。复制目录到陌生 cwd、用 bin symlink 启动也必须通过。

- [x] **Step 4: 验证硬中断。** 新建仅 `export default () => { while (true) {} };` 的临时文件，用父探针增加 100ms 定时器，向 `-child.pid` 发 SIGTERM、50ms 后 SIGKILL；确认退出非零、`process.kill(pid,0)` 抛 ESRCH。用相同方式验证异步永不 resolve 文件。只终止探针创建的进程组。

- [x] **Step 5: 记录结论并运行隔离后的相关纯测试。** 证据文档逐条列出环境、命令、exitCode、stdout、stderr、sentinel 是否存在；任一核心失败停止后续 Task。不写“支持外部 TS”而只测 `.mjs`。

```sh
bun test tests/computer-use.test.ts tests/computer-use-runtime.test.ts tests/computer-use-act.test.ts
# Expected: 所选纯测试通过，没有桌面调用，没有用户缓存修改。
git add scripts/probes/compiled-e2e-loader.ts tests/fixtures/computer-e2e \
  docs/research/2026-09-13-compiled-e2e-loader.md \
  tests/computer-use-act.test.ts tests/computer-use-packaging.test.ts \
  tests/computer-use-native.test.ts .gitignore tsconfig.json
git commit -m "test: prove dependency-free compiled e2e loading"
```

## Task A2: 抽出共享桌面 session，而不是复制一份驱动

**Files:**
- Create: `packages/computer-runtime/package.json`, `packages/computer-runtime/src/{types,sdk,session,cua-backend,observe,actions,artifacts,index}.ts`
- Create: `tests/computer-runtime.test.ts`, `tests/computer-runtime-budget.test.ts`
- Modify: root `tsconfig.json`, `bun.lock`

**Interfaces:**
- Consumes: spec §5 的 `Computer`、`Target`、`Snapshot` 等类型；现有 computer-use 的 SDK 输入构造、observe、actions 和 artifacts。
- Produces:

```ts
export interface SessionOptions {
  onRuntime?: (info: { driverVersion: string; pid: number }) => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  onAction?: (event: {
    phase: 'started' | 'finished'; kind: 'click' | 'type' | 'key' | 'scroll';
    outcome?: 'delivered' | 'not_delivered' | 'unknown';
  }) => void;
}
export interface ComputerSession {
  computer: Computer;
  metadata(): Promise<{ driverVersion: string; pid: number }>;
  permissions(): Promise<{ accessibility: boolean; screenRecording: boolean }>;
  close(): Promise<void>;
}
export function createComputerSession(options?: SessionOptions): ComputerSession;
export class ComputerError extends Error {
  constructor(
    public code: string,
    message: string,
    public actionOutcome?: 'delivered' | 'not_delivered' | 'unknown',
  ) { super(message); }
}
```

另导出 `selectWindow`、`sanitizeElements`、`bigintSafeReplacer`、`ensureOutDir`、`saveScreenshot` 供两个内部入口共用，不放进消费方 Suite 接口。测试通过内部 `createSessionWithBackend(makeBackend, options)` 注入假 backend；不导出到 Skill。

- [x] **Step 1: 写失败测试。** 假 backend 接口与 Computer 相同的 `apps/windows/snapshot/type/key/scroll`，但点击接受 token：`clickToken(target, token): Promise<void>`；另有 `metadata/permissions/close`。测试文件局部假对象必须提供所有方法，默认未配置方法抛 `unexpected backend call`，而非悄悄成功。

```ts
import { expect, test } from 'bun:test';
import { clickUnique } from '../packages/computer-runtime/src/actions.js';
test('歧义时绝不投递动作', async () => {
  let deliveries = 0;
  await expect(clickUnique({
    snapshot: async () => [
      { role: 'AXButton', label: 'Save', elementToken: 'a' },
      { role: 'AXButton', label: 'Save', elementToken: 'b' },
    ],
    click: async () => { deliveries++; },
  }, e => e.label === 'Save', 'save')).rejects.toThrow(/found 2/);
  expect(deliveries).toBe(0);
});
```

同文件新增：零匹配、缺 token、两次 stale 最多两次投递、非 stale 一次即停、type/key/scroll ToolResult.isError、密码 value 丢弃、数字 value 转字符串、waitFor 直到条件成立、非 degraded 错误立即抛（不能把权限错误吞成轮询）。`waitFor` 只允许 `degraded_snapshot` 作为暂态重读，默认 interval=500ms。

- [x] **Step 2: 运行 RED。** `bun test tests/computer-runtime.test.ts`。Expected: 模块不存在或接口缺失；不能因 SDK/TCC 缺失而红。

- [x] **Step 3: 建私有 workspace 并移动已验证逻辑。** package name `@ya-skills/computer-runtime`，`private:true`，`type:module`，`exports:"./src/index.ts"`。此Task先在新包声明Cua依赖（版本按 Global Constraints，native为optionalDependency），A3切换旧入口时再删除旧包依赖声明。迁移中短暂共存不能作为最终发布状态。types中不出现Cowork名字；NodeNext导入使用`.js`。

`actions.ts` 中点击的核心代码必须保留如下条件，不能统一重试全部异常：

```ts
export async function clickUnique(
  deps: { snapshot(): Promise<AxElement[]>; click(token: string): Promise<void> },
  predicate: Predicate,
  description: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const matches = (await deps.snapshot()).filter(predicate);
    if (matches.length !== 1) throw new Error(`expected exactly one ${description}, found ${matches.length}`);
    const token = matches[0]!.elementToken;
    if (!token) throw new Error('matched element has no elementToken');
    try { await deps.click(token); return; }
    catch (error) {
      const e = (typeof error === 'object' && error !== null ? error : {}) as
        { errorCode?: string; inner?: { errorCode?: string } };
      if (attempt === 0 && (e.errorCode ?? e.inner?.errorCode) === 'stale_element_token') continue;
      throw error;
    }
  }
}
```

`cua-backend.ts` 使用现有 `commands.ts` 的 SDK 构造：Window target、Element position、Background delivery、Left/count=1；将所有返回的 isError（包括 click）归一为 ComputerError。保留原 typed errorCode 供唯一 stale 分支使用。wakeAx 的 osascript 设置必须有剩余预算 timeout，不能无期限 spawnSync；共享层不提供 activate 方法。

`sdk.ts` 移入 realpath executable-relative loader 与编译 define 检查；侧载路径保持 `runtime/computer-use/node_modules`，不重命名已交付布局。包内只有此文件动态导入 Cua。

- [x] **Step 4: 写预算 RED，再实现绝对 deadline 和关闭防护。** 使用依赖注入 `now`/fake backend 控制 load=40ms、create=40ms、work=40ms，总预算100ms时必须失败；不是每个阶段再获得100ms。加载/创建 promise 迟到时必须最终清理创建物，不启动 work。

```ts
// 在每次原生操作开始时执行；load/create/work共用该操作的截止点。
// CLI传入整个命令deadlineAt；E2E不把长寿session限制为30秒。
const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + 30_000);
const remaining = () => {
  const ms = deadlineAt - Date.now();
  if (ms <= 0) throw new ComputerError('command_timeout', 'operation budget exhausted');
  options.signal?.throwIfAborted();
  return ms;
};
```

`waitFor` 是多次只读snapshot组成的轮询，不套单次30秒总上限；它按调用者timeoutMs计算自己的绝对截止点，每次snapshot预算取该剩余时间与30000ms的较小者。必须测试一个60秒等待能在第40秒成功，防止误把整个E2E session限制为30秒。每次方法调用前检查 signal/session closed；动作超时将 session 标不可再用并记录 unknown。关闭幂等，顺序 endSession → shutdown → destroy，在一个5000ms剩余预算内尝试。Promise 超时不等于取消 native；明确禁止其迟到续体再次投递。SDK metadata/permission 使用同一懒加载，无操作的 session 不创建 native。初始化后在同一操作预算内读取metadata并缓存，通过onRuntime通知worker记录SDK版本；重复metadata调用返回缓存，不能为报告在close后重新打开driver。

- [x] **Step 5: GREEN + typecheck + 提交。** `bun test tests/computer-runtime.test.ts tests/computer-runtime-budget.test.ts && bun run typecheck`。Expected: 所有测试使用假 backend，无 SDK/TCC。将新 package 路径加入 tsconfig 后用 `bun install` 更新 workspace lock（这是开发依赖管理，不是消费方安装要求）。提交 `feat: share computer runtime behind a lazy session`，只 stage 本 Task 文件。

## Task A3: computer-use 改用共享 session，保持用户命令契约

**Files:**
- Modify: `packages/functions-computer-use/src/{commands,runtime,index}.ts`, `packages/functions-computer-use/package.json`
- Delete after imports migrate: `packages/functions-computer-use/src/{observe,act,artifacts}.ts`
- Modify: `scripts/package-release.ts`, `tests/computer-use*.test.ts`, `docs/computer-use.md`

**Interfaces:**
- Consumes: A2 `createComputerSession`, Computer 方法及共享辅助函数。
- Produces: 原 doctor/apps/windows/perceive/act flags 与 JSON 不变；原测试导出可暂时经 index re-export，不能留下第二份实现。

- [x] **Step 1: 写命令级 RED。** 注入 `createSession` 而不是只 stub 整个 runReal；这样测试能覆盖真正操作分支。

```ts
// 测试用 fakeComputer 必须由 tests 中的局部工厂提供所有 Computer 方法。
const calls: string[] = [];
const computer = makeFakeComputer({
  windows: async () => [{ pid: 1, windowId: 2n, title: 'Fixture' }],
  type: async () => { calls.push('type'); },
  snapshot: async () => { throw new Error('observation unavailable'); },
});
const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
const action = commands.find(c => c.action === 'act')!;
const error = await Promise.resolve(action.run(['--pid', '1', '--type', 'hello'])).catch(e => e);
expect(JSON.parse(error.message).error.actionDelivered).toBe(true);
expect(calls).toEqual(['type']);
```

在 `tests/computer-use.test.ts` 定义这两个局部helper（Computer/ComputerSession是A2导出类型）：

```ts
function makeFakeComputer(overrides: Partial<Computer> = {}): Computer {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected computer call'); };
  return { apps: unexpected, windows: unexpected, snapshot: unexpected,
    click: unexpected, type: unexpected, key: unexpected, scroll: unexpected,
    waitFor: unexpected, ...overrides };
}
function makeSession(computer: Computer): ComputerSession {
  return { computer, metadata: async () => ({ driverVersion: '0.27.0', pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    close: async () => {} };
}
```

补 click拒绝、key拒绝、scroll拒绝、超时unknown且无重放、输入非法createSession次数0、help/list/install SDK importer次数0的进程测试。doctor 的参数也走 parseRequest，不能接受未知 flag。

- [x] **Step 2: 跑 RED。** `bun test tests/computer-use.test.ts tests/computer-use-act.test.ts`。Expected: 尚不支持 createSession 注入而失败。

- [x] **Step 3: 最小替换 orchestration。** 参数解析保留；每个命令建立一个 session、finally close。示例：

```ts
const session = createSession({ deadlineAt: Date.now() + COMMAND_DEADLINE_MS });
try {
  const win = selectWindow(await session.computer.windows(request.pid), request.windowId);
  const target = { pid: request.pid, windowId: win.windowId };
  await session.computer.type(target, request.type);
  try {
    return encodePerception(target, await session.computer.snapshot(target, { screenshot: request.shot }), request.outDir);
  } catch (error) { throw postActionObserveError(error); }
} finally {
  // 保留现有单步CLI契约：cleanup告警不覆盖主错误或成功输出。
  try { await session.close(); }
  catch (error) { console.error('driver cleanup issue:', error); }
}
```

两个信封函数在 commands.ts 明确定义（共享type/helper从A2导入）：

```ts
function encodePerception(target: Target, snapshot: Snapshot, outDir?: string): string {
  return JSON.stringify({ ...target, title: snapshot.title, elements: snapshot.elements,
    ...(snapshot.imageBase64 ? { screenshot: saveScreenshot(ensureOutDir(outDir), snapshot.imageBase64) } : {}),
  }, bigintSafeReplacer);
}
function postActionObserveError(error: unknown): Error {
  return new Error(JSON.stringify({ error: { code: 'post_action_observe_failed',
    message: error instanceof Error ? error.message : String(error),
    actionDelivered: true, nextStep: 'run perceive; do NOT repeat the act',
  } }));
}
```

显式 activate 仅留在 computer-use CLI，遵循原 flag；共享层和 E2E 无自动激活。

`scripts/package-release.ts` 的 createRequire 锚点由 functions-computer-use/package.json 改为 computer-runtime/package.json，PINNED/sidecar 不变；更新原测试导入，删除重复实现文件。

- [x] **Step 4: GREEN 与静态去重。** `bun test tests/computer-use.test.ts tests/computer-use-runtime.test.ts tests/computer-use-act.test.ts && bun run typecheck`。`rg '@trycua/cua-driver|stale_element_token' packages/functions-computer-use/src` 应不再找到 SDK 构造或重复 stale 循环；允许文档/类型 re-export，必须逐个解释。

- [x] **Step 5: 提交。** `git commit -m "refactor: route computer-use through shared runtime"`；stage 仅本 Task 文件及明确的删除项。

## Task A4: 实现有限 Suite 执行契约与可测的失败语义

**Files:**
- Create: `packages/functions-computer-e2e/package.json`, `packages/functions-computer-e2e/src/{types,suite,index}.ts`
- Create: `tests/computer-e2e-suite.test.ts`, `tests/fixtures/computer-e2e/{pass,skip,fail,hook-fail}.e2e.ts`
- Modify: `tsconfig.json`, `bun.lock`

**Interfaces:**
- Consumes: spec §5 完整 `Suite`、`TestCase`、`CaseContext`；A2 Computer。
- Produces:

```ts
export type CaseStatus = 'passed' | 'failed' | 'skipped' | 'not_run' | 'interrupted';
export interface CaseResult {
  id: string; name: string; status: CaseStatus; reason?: string;
  actionOutcome?: 'delivered' | 'not_delivered' | 'unknown';
}
export interface StepResult {
  caseId: string; name: string; status: 'passed' | 'failed' | 'interrupted'; reason?: string;
}
export interface SuiteResult {
  cases: CaseResult[];
  errors: Array<{ phase: 'load' | 'beforeAll' | 'case' | 'afterAll' | 'driver'; message: string }>;
}
export function validateSuite(value: unknown): Suite;
export function runSuite(suite: Suite, context: CaseContext,
  emit: (event: WorkerEvent) => void): Promise<SuiteResult>;
```

`WorkerEvent` 为 spec §8 除 run_started/run_finished 外的事件 `{type,payload}` 联合，types.ts 中穷举合法 payload；主进程随后添加 seq/runId/time。runtime事件承载懒加载后实际SDK版本；不为填报告而初始化未使用的driver。导出类型生成 Skill api.d.ts，不能手写第二份漂移接口。

- [x] **Step 1: 写 RED：钩子失败、跳过、失败后不继续。** 使用以下完整局部helper；测试导入`mkdtempSync/rmSync`、`tmpdir/join`和`afterEach`，SkipError从本workspace内部suite.ts导出，不能增加到消费方API。

```ts
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function makeContext(): CaseContext {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected computer call'); };
  const artifactsDir = mkdtempSync(join(tmpdir(), 'yk-suite-'));
  directories.push(artifactsDir);
  return {
    computer: { apps: unexpected, windows: unexpected, snapshot: unexpected,
      click: unexpected, type: unexpected, key: unexpected, scroll: unexpected, waitFor: unexpected },
    signal: new AbortController().signal, params: {}, artifactsDir,
    step: async (_name, work) => await work(),
    skip: reason => { throw new SkipError(reason); },
    setApplication: () => {}, capture: unexpected,
  };
}
const order: string[] = [];
const result = await runSuite({
  apiVersion: 1, id: 'fixture', name: 'fixture',
  beforeAll() { order.push('boot'); throw new Error('boot failed'); },
  afterAll() { order.push('cleanup'); },
  tests: [{ id: 'never', name: 'must not run', run() { order.push('BAD'); } }],
}, makeContext(), () => {});
expect(order).toEqual(['boot', 'cleanup']);
expect(result.cases.map(c => c.status)).toEqual(['not_run']);
expect(result.errors[0]!.phase).toBe('beforeAll');
```

另测重复 suite/case id、空 suite、非法apiVersion、非函数run、负/NaN预算、同步抛错、async抛错、skip理由必填、afterAll一次且不覆盖主错、失败后case不执行、step begin/end配对、cleanup失败不算通过。纯 fixtures 不得调用 native。

- [x] **Step 2: 跑 RED。** `bun test tests/computer-e2e-suite.test.ts`，Expected: runner 未实现，而不是测试自身类型错误。

- [x] **Step 3: 实现 validate + 顺序状态机。** 核心顺序：

```ts
let stopped = false;
try {
  await suite.beforeAll?.(context);
  for (const item of suite.tests) {
    if (stopped) { results.push({ id: item.id, name: item.name, status: 'not_run' }); continue; }
    if (item.skip) { results.push({ id: item.id, name: item.name, status: 'skipped', reason: item.skip }); continue; }
    try {
      await item.run(context);
      results.push({ id: item.id, name: item.name, status: 'passed' });
    } catch (error) {
      if (error instanceof SkipError) results.push({ id: item.id, name: item.name, status: 'skipped', reason: error.message });
      else {
        results.push({ id: item.id, name: item.name, status: 'failed', reason: errorMessage(error) });
        stopped = true;
      }
    }
  }
} finally {
  await suite.afterAll?.(context);
}
```

上面是控制流形状：正式实现为 beforeAll/case/afterAll 分别记录 errors 和 events，不能用裸 finally 覆盖错误；`SkipError` 为私有 Error 子类，`errorMessage(unknown)` 只做 Error.message/String 转换。预算用 A2 的绝对截止点机制，向父进程发送 hook_started/case_started 的预算；Promise 超时后中止 context、不再运行下一 case，硬终止由 A5 完成。

runSuite为每个case/hook创建不修改原对象的context wrapper；覆盖step以绑定当前caseId/hookName并记录开始/结束，覆盖skip以抛SkipError。wrapper的computer/capture/params复用注入项。所有开始/结束事件包含稳定 case id；worker从config统一补充file，case id最终由父进程组合为 `relativeFile::caseId`。收集完成先发完整清单再执行任何 hook。只创建懒 Computer，纯 suite 不初始化 SDK。

- [x] **Step 4: GREEN 和退出判定测试。** 函数 `exitCodeFor(result: SuiteResult): 0|1|2`：errors非空或failed/interrupted→1；无case或skipped/not_run→2；否则0。显式断言 `[passed,skipped]` 为2，不能以“没有fail”为0。

- [x] **Step 5: 提交。** `bun test tests/computer-e2e-suite.test.ts && bun run typecheck`；提交 `feat: execute explicit computer e2e suites sequentially`。

## Task A5: 自启动监督、事件事实来源、历史报告

**Files:**
- Create: `packages/functions-computer-e2e/src/{worker,supervisor,history}.ts`
- Create: `tests/computer-e2e-supervisor.test.ts`, `tests/computer-e2e-history.test.ts`
- Create: `tests/fixtures/computer-e2e/{hang,sync-hang,console,load-error,orphan}.e2e.ts`
- Modify: `packages/cli/src/cli.ts`（仅内部 worker bootstrap）

**Interfaces:**
- Consumes: A4 runSuite/WorkerEvent/SuiteResult；A2 lazy session。
- Produces:

```ts
export interface RunOptions {
  files: string[]; params: Record<string, string>; outDir: string;
  timeoutMs: number; requireVersion?: string;
}
export interface RunEvent {
  schemaVersion: 1; runId: string; seq: number; time: string;
  type: 'run_started' | 'run_finished' | WorkerEvent['type'];
  payload: Record<string, unknown>;
}
export interface RunSummary {
  schemaVersion: 1; runId: string;
  status: 'passed' | 'failed' | 'incomplete'; exitCode: number;
  counts: Record<CaseStatus, number>;
  cases: CaseResult[]; steps: StepResult[]; errors: string[]; cleanupErrors: string[];
  artifacts: string[]; metadata: Record<string, unknown>;
}
export function supervise(options: RunOptions): Promise<RunSummary>;
export function reduceEvents(events: readonly RunEvent[]): RunSummary;
export function formatReport(summary: RunSummary): string;
export function readHistory(outDir: string, limit: number): Promise<RunSummary[]>;
export function workerMain(config: WorkerConfig): Promise<void>;
```

`WorkerConfig` 定义为 `{file:string; runId:string; artifactsDir:string; params:Record<string,string>}`；父进程通过专用配置文件传路径，只保存params到0700目录内的0600工作配置，退出后删除该配置；正式摘要不保存其值。控制事件 fd3；用例 stdout/stderr 单独保存。metadata字段名固定为 `ykVersion`、`ykExecutableSha256`、`bunVersion`、`platform`、`arch`、`apiVersion`、`sdkVersion`、`testsRepo`、`testSources`、`application`；实际缺失信息用null。ykExecutableSha256对realpath(process.execPath)的字节计算SHA256，不把同版本号的不同开发二进制当作同一产物。

- [x] **Step 1: 写事件归约 RED。** 在 tests 中构造完整事件序列，断言由事件生成的 run.json 与 report.md 一致，不另维护计数。

```ts
const events: RunEvent[] = [
  { schemaVersion: 1, runId: 'r', seq: 1, time: '2026-09-13T00:00:00Z', type: 'run_started', payload: { ykVersion: '0.18.0' } },
  { schemaVersion: 1, runId: 'r', seq: 2, time: '2026-09-13T00:00:01Z', type: 'suite_collected', payload: { file: 'a.e2e.ts', cases: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }] } },
  { schemaVersion: 1, runId: 'r', seq: 3, time: '2026-09-13T00:00:02Z', type: 'case_started', payload: { file: 'a.e2e.ts', id: 'a', timeoutMs: 30000 } },
];
const report = reduceEvents(events);
expect(report.status).toBe('incomplete');
expect(report.counts.passed).toBe(0);
expect(report.counts.interrupted).toBe(1);
expect(report.counts.not_run).toBe(1);
```

补 terminal fail、显式skip、主错误+cleanupError、两次run目录独立、空目录、末尾截断JSONL（保留此前事件并报incomplete）、内部坏行拒绝伪成功、相对artifact路径不能逃逸run目录、文件权限。缺失run_finished永不生成passed。

- [x] **Step 2: 跑 RED 后实现 history。** 用 `mkdirSync(runDir,{recursive:false,mode:0o700})` 和 timestamp+randomUUID；父进程 `appendFileSync(eventsPath, line,{mode:0o600})`，单写入者顺序seq。snapshot先sanitize再写；report从同一reduceEvents生成；run.json用同目录临时文件+rename更新。history遍历各run日志，不创建/修改已有历史。

- [x] **Step 3: 写真实子进程但无桌面的监督 RED。** fixtures：pass纯断言；console包含 `{"type":"run_finished"}` 伪协议输出；load-error有语法错误；hang永不resolve；sync-hang无限循环；orphan仅spawn同组`/bin/sleep`并hang。所有测试在temp目录，结束验证子进程已消失。

```ts
const result = await supervise({
  files: [resolve('tests/fixtures/computer-e2e/sync-hang.e2e.ts')],
  params: {}, outDir: tempDir, timeoutMs: 100,
});
expect(result.exitCode).not.toBe(0);
expect(result.status).not.toBe('passed');
expect(result.counts.passed).toBe(0);
```

监督器测试允许注入 `cleanupGraceMs=50` 和 executable invocation，生产默认固定15000；此测试注入不成为公共CLI flag。需要显式读取保存的pid并 `process.kill(pid,0)` 验证ESRCH，不能仅断言Promise返回。

- [x] **Step 4: 实现 worker bootstrap 与 supervisor。** cli.ts 在公共 registry 之前处理隐藏 `__computer-e2e-worker`，校验只接收一个受控配置路径。开发模式自启动 `process.execPath + absolute cli.ts + hidden args`；compiled模式只使用realpath(process.execPath)+hidden args。Node target 的 E2E run 明确拒绝并提示使用已安装yk；不能自动安装/寻找Bun。

```ts
const child = spawn(invocation.executable, invocation.args, {
  cwd: projectRoot,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: '1' },
});
const requestStop = () => {
  if (child.pid) process.kill(-child.pid, 'SIGTERM');
  killTimer = setTimeout(() => {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }, cleanupGraceMs);
};
```

正式实现清理全部计时器与signal listener、处理spawn error/exit与fd关闭竞态，不因worker先exit就丢最后事件。watchdog覆盖加载、hook、case、整个run；父进程保留独立deadline，不相信worker只发started不finished。加载预算也为30000ms；case_started预算必须来自已验证收集清单。

worker先注册信号handler，再import外部文件。SIGTERM abort controller，afterAll与session.close最多执行一次；同步hang时由父进程杀组。native action_started没有对应finished时父进程记unknown，并停止后续文件，绝不重放。只有runtime有实际投递结果时才发delivered。

- [x] **Step 5: GREEN 并提交。** `bun test tests/computer-e2e-history.test.ts tests/computer-e2e-supervisor.test.ts && bun run typecheck`。验证console伪协议不影响结果、load错误也有run目录、history/report完全不加载SDK。提交 `feat: supervise e2e runs and persist truthful reports`。

## Task A6: 公共 CLI、可安装 Skill 与无依赖发布包闭环

**Files:**
- Create: `packages/functions-computer-e2e/src/{args,commands}.ts`
- Create: `skills/computer-e2e/{SKILL.md,skill.json}`, `skills/computer-e2e/references/api.d.ts`, `skills/computer-e2e/examples/pure.e2e.ts`
- Create: `scripts/generate-computer-e2e-api.ts`, `tests/computer-e2e-cli.test.ts`, `tests/computer-e2e-release.test.ts`, `docs/computer-e2e.md`
- Modify: `packages/cli/{package.json,src/function-registry.ts}`, root `package.json`, `tsconfig.json`, `bun.lock`
- Modify: `skills/computer-use/SKILL.md`, `README.md`, `README.zh-CN.md`, `AGENTS.md`, `tests/catalog.test.ts`
- Modify: `scripts/package-release.ts`, `.github/workflows/{release,release-please}.yml`

**Interfaces:**
- Consumes: A5 supervise/readHistory/formatReport。
- Produces: spec §6 三命令；`createComputerE2ECommands(): FunctionCommand[]`；Skill `dependsOn:["computer-use"]`；外部包不包含新增npm分发资产。

- [x] **Step 1: 写参数与安装 RED。** `parseE2EArgs(action,argv)` 返回区分run/history/report的联合；测试无文件、未知flag、重复param key、非法预算、重复单值flag、文件不存在、require-version不符均在worker/SDK前拒绝。不接受glob作为隐式发现规则；shell已展开多个路径则按传入顺序运行。

```ts
expect(() => parseE2EArgs('run', ['a.e2e.ts', '--param', 'x=1', '--param', 'x=2']))
  .toThrow(/duplicate/);
expect(() => parseE2EArgs('run', ['a.e2e.ts', '--retry', '3']))
  .toThrow(/unknown/);
```

catalog测试安装 computer-e2e 到临时项目，断言两个Skill、references/api.d.ts、examples/pure.e2e.ts都存在，无node_modules，无源码绝对路径。扫描安装后的SKILL本地引用，每个引用都存在；不要指向未随包安装的repo `docs/`。

- [x] **Step 2: 跑 RED，然后实现命令和文案。** run执行后设置 `process.exitCode=summary.exitCode` 并返回 `JSON.stringify(summary)`，失败不能用顶层catch一律改为1而丢130/143/2。history和report只有文件读取，help/非法参数不触SDK。命令description含完整flags或本地usage文本，修正旧help只给一句说明的误导。

Skill metadata：

```json
{
  "name": "computer-e2e",
  "description": "Use only when explicitly asked to write, run, or repair deterministic desktop E2E tests. Explore with computer-use, then replay trusted project-local test code through yk without an LLM deciding runtime steps.",
  "dependsOn": ["computer-use"],
  "functions": [
    {"domain":"computer-e2e","action":"run"},
    {"domain":"computer-e2e","action":"history"},
    {"domain":"computer-e2e","action":"report"}
  ]
}
```

SKILL必须写明：探索→确认稳定谓词和后置条件→编写Suite→显式授权后运行→读报告→失败再用computer-use排查；不自动修复失败继续算pass；不把SDK投递成功当业务成功；只操作获准目标；不读取凭据；无npm安装；外部文件受信任不是沙箱；TS只转译。修复computer-use原文“没看到输入就再输一次”的不安全建议，改为只读确认、投递不确定时禁止重放。

`api.d.ts` 从A2/A4公共types用TypeScript声明输出生成（开发时用已有typescript），生成脚本遍历导出、拒绝残留 `@ya-skills/*` 或 `@trycua/*` import；测试重新生成后diff为0。不是消费方运行要求。

- [x] **Step 3: 写真实发布包 RED（无桌面）。** 用临时目录解包，PATH=/usr/bin:/bin，无node/npm/bun；运行以下闭环。release测试模式 `YK_RELEASE_TESTS=1` 时产物缺失必须FAIL，不允许skip；默认不构建/运行native。

```sh
export YA_SKILLS_CATALOG_DIR="$extract/skills"
(cd "$consumer" && "$extract/yk" install computer-e2e)
(cd "$consumer" && env -u NODE_PATH -u NODE_OPTIONS -u BUN_OPTIONS PATH=/usr/bin:/bin \
  "$extract/yk" computer-e2e run .agents/skills/computer-e2e/examples/pure.e2e.ts)
(cd "$consumer" && "$extract/yk" computer-e2e history)
# 从history取得run目录，再执行report；不要硬编码示例RUN_ID。
```

必须断言：没有node_modules；只有yk自启动工作进程；pure用例不触SDK；external TS relative imports可用；case失败退出1、skip退出2；bin symlink/空cwd/有空格路径/hostile package.json+bunfig均通过；SDK固定解析位置结构测试通过；native文件仍在原sidecar路径。旧computer-use参数与帮助测试不能回归。

- [x] **Step 4: 更新单一打包入口和两个workflow。** package:release先生成types再编译yk、复制两个Skill和原runtime；不增加额外npm资产。workflow顺序固定：安装开发deps→typecheck→默认纯tests→package:release→`YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts`→上传。发布CI不读取Finder，不申请TCC。两个workflow写相同命令，测试断言顺序而不是只搜字符串。

```sh
bun run typecheck
bun test
bun run package:release -- --version "$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts
bun run build
bun run smoke
```

执行这些命令时开启shell pipefail或不加tail管道；保存原始exitCode。Node build/smoke仅验证现有帮助/catalog等，不能据此声称Node支持E2E外部TS。

- [x] **Step 5: GREEN、文档一致性与提交。** README双语说明“无消费方npm安装”；AGENTS写包职责、默认测试不碰桌面、release gate要求；docs列出未授权真实UI与Homebrew验收。提交 `feat: ship dependency-free computer-e2e commands and skill`。

## Task A7: 验收交接，不越权做真实桌面操作

**Files:**
- Create: `docs/verification/2026-09-13-computer-e2e-foundation.md`
- Modify: `docs/computer-e2e.md`（只更新实际验证状态）

**Interfaces:**
- Consumes: A6打包产物、tests结果、各Task差异。
- Produces: 给Cowork迁移使用的可执行产物路径、SHA256、ykVersion、apiVersion=1和分层验收表。文档引用持久证据，不只写临时路径。

- [x] **Step 1: 重新从干净dist构建并跑纯/发布包门禁。** 不复用之前dist；报告pass/fail/skip分别计数，skip原因具体到native授权项。验收文档代码块保存命令及真实退出码。
- [x] **Step 2: 独立只读review。** 审查所有共享调用路径、预算、迟到promise、防重放、进程组、报告完整性、生成types、Skill可安装引用、无消费方依赖。按工具协议先发现agent；基础设施失败就停止报告，不偷偷换协议。审查问题修复后再运行相关门禁并复审，不能将首次BLOCK写成“全部修完”而没有证据。
- [x] **Step 3: 请求用户指定非敏感窗口及动作范围。** 获准前不执行。授权后用已打包yk做后台click/type/key/scroll与postcondition，验证未知结果不重放；记录权限/焦点/截图行为。未获准则本项明确未执行，不影响提供纯验证产物，但不声称生产验收完成。
- [x] **Step 4: 交接第二份计划。** 提供 `YK_BINARY` 的绝对路径与同目录runtime/、skills/；Cowork计划只消费产物，不import ya-skills源码。不自动发布或安装Homebrew；真实brew验证需要另行授权。已有tap若仍缺runtime-aware安装块，则正式Homebrew交付仍被阻断，必须由用户另行安排tap更新；本地tarball通过不等于brew已可用。
- [x] **Step 5: 提交验收文档。** `git add docs/verification/2026-09-13-computer-e2e-foundation.md docs/computer-e2e.md && git commit -m "docs: record computer-e2e verification evidence"`。未测项必须留在文档中。

## Self-review / Coverage

| Spec | Tasks |
|---|---|
| §1–3 无消费依赖、共享代码、两个入口 | A1–A3、A6 |
| §4 编译外部加载可行性 | A1，失败为停止门 |
| §5 Suite/Computer契约 | A2、A4、A6声明生成 |
| §6 CLI/退出码/版本约束 | A5–A6 |
| §7 清理、未知投递、硬终止 | A2–A5 |
| §8 历史、证据、隐私 | A2、A5–A6 |
| §9 Cowork迁移 | 第二份独立计划，不在本仓库偷偷改应用 |
| §10 验收和非目标 | A6–A7 |

自审要求：执行前再次核对所有接口与spec；本计划没有npm发布/消费方安装步骤，没有默认真实UI测试。设计的技术假设只在A1明确验证，不能因失败擅自更换交付方式。
