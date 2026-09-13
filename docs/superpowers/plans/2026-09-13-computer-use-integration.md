# Computer-use 接入 ya-skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安装 ya-skills 后，在任意目录通过 `yk computer-use` 操作桌面应用，不需要开发仓库或额外 Node 进程。

**Architecture:** 复用 yk 内置 Bun，同进程懒加载 Cua Driver；SDK 与原生文件作为发布包配套文件。使用现有 functions package / catalog / Homebrew 工程，不新增独立 CLI、daemon 或运行时安装器。

**Tech Stack:** Bun 1.3.14、TypeScript、现有 Bun workspaces / bun:test、Cua Driver 0.27.0、macOS arm64。

**Spec:** `docs/superpowers/specs/2026-09-13-computer-use-design.md`。执行前读完整设计；本文件是待批准执行的计划，不是完成报告。

## Global Constraints

- 固定 Bun 1.3.14、`@trycua/cua-driver` / darwin-arm64 包 0.27.0；对应 UniFFI 包为 0.31.0-3。
- 首版沿用现有发布平台 macOS arm64；驱动要求 macOS 13+。
- 不增加 Node 安装依赖、Node worker、常驻 daemon 或另一套 CLI。
- 不克隆 cowork-e2e，不依赖开发者路径、Cowork 源码或 dev 实例。
- 不自动激活或以前台投递重试；不可逆动作需要用户明确授权。
- 运行时不安装、不下载；不修改上游 SDK；保持 SDK/native 版本配对。
- 只修改 ya-skills。旧 cowork-e2e、cowork-app、全局安装 Skill、tap 和远端发布不在此次写入权限内。
- 所有未执行/跳过的验收独立报告；mock 通过不能计作真实桌面通过。
- 子代理使用用户指定的单个前台同步方式；一名 writer，完成后再审查，不并行写同一目录。若需改运行协议先询问用户。
- 本计划只写文档，不执行实现、提交、推送或发布；实现批准后再使用隔离工作区，保留原有改动。

## 文件与职责

新增：

| 路径 | 职责 |
| --- | --- |
| `packages/functions-computer-use/package.json` | 新 domain 的 workspace / native 运行依赖 |
| `packages/functions-computer-use/src/index.ts` | 导出 `createComputerUseCommands(): FunctionCommand[]` |
| `packages/functions-computer-use/src/commands.ts` | 命令执行与成功 JSON / 失败消息，不拥有 CLI 主进程 |
| `packages/functions-computer-use/src/args.ts` | 纯参数验证，生成明确的观察/动作请求 |
| `packages/functions-computer-use/src/runtime.ts` | SDK 定位、懒加载、同进程生命周期、只读 doctor |
| `packages/functions-computer-use/src/observe.ts` | 唯一窗口选择、snapshot 数据、隐私处理 |
| `packages/functions-computer-use/src/act.ts` | 单动作、唯一元素匹配、有限 stale 重试、投递结果判断 |
| `packages/functions-computer-use/src/artifacts.ts` | 用户缓存/显式输出目录、唯一文件名与私有权限 |
| `skills/computer-use/SKILL.md`、`skills/computer-use/skill.json` | 通用使用指南、catalog 与函数映射 |
| `scripts/package-release.ts` | 唯一发布目录和 tarball 组装入口 |
| `tests/computer-use.test.ts` | 输入、观察、动作与生命周期的纯行为测试 |
| `tests/computer-use-runtime.test.ts` | 懒加载、定位、缺文件与 doctor 测试 |
| `tests/computer-use-packaging.test.ts` | 配套依赖、发布布局、打包和陌生目录行为 |
| `docs/computer-use.md` | 安装、权限、命令、支持范围、发布验收证据 |

修改：`packages/cli/package.json`、`packages/cli/src/function-registry.ts`、`packages/cli/src/cli.ts`（仅帮助/参数路由必要处）、根 `package.json`、`tsconfig.json`、`bun.lock`、`tests/functions.test.ts`、`tests/cli.test.ts`、`tests/catalog.test.ts`、`tests/install.test.ts`、`tests/homebrew-formula.test.ts`、`scripts/update-ya-skills-formula.py`、`.github/workflows/release.yml`、`.github/workflows/release-please.yml`、`README.md`、`README.zh-CN.md`、`AGENTS.md`。

不把领域逻辑放入 core 或 CLI；不把 native 文件复制到每份安装后的 Skill 目录。

## Task 1：命令接入与输入契约

**Files:** 新 package / index.ts / commands.ts / args.ts；修改 CLI 注册与依赖、tsconfig、lockfile；测试 functions / cli / computer-use。

**Interfaces:**
- Consumes：现有 `FunctionCommand`、`createFunctionRegistry`。
- Produces：`createComputerUseCommands(): FunctionCommand[]`，恰好注册 doctor/apps/windows/perceive/act；`parseRequest(action: string, args: string[]): ParsedRequest`。
- `ParsedRequest` 用判别联合定义，包含 action，按动作需要携带 pid、windowId、shot、activate、outDir 和 action 参数；不存在的参数不填隐式默认动作。windowId 类型为 bigint。

- [ ] 先添加可运行失败测试，证明新命令还不存在；输入测试覆盖缺 PID、多个动作、未知 flag、不安全整数和超大 window ID。

```ts
import { expect, test } from "bun:test";
import { createComputerUseCommands } from "@ya-skills/functions-computer-use";

test("desktop operations have one registered entry and no hidden setup command", () => {
  expect(createComputerUseCommands().map(c => `${c.domain} ${c.action}`)).toEqual([
    "computer-use doctor", "computer-use apps", "computer-use windows",
    "computer-use perceive", "computer-use act"
  ]);
});
```

- [ ] 运行 `bun test tests/functions.test.ts tests/computer-use.test.ts`，记录预期缺 module / 命令的失败；禁止把无关环境失败当作 RED。
- [ ] 创建包和严格 parser，声明锁定 SDK 运行依赖；平台专用包使用 optionalDependencies，macOS 发布时另行断言存在，不能破坏其他平台的依赖安装。从公共 registry 更新 bun.lock。在 CLI 注册中追加 `...createComputerUseCommands()`；其余 domain 不改。

```ts
import { createComputerUseCommands } from "@ya-skills/functions-computer-use";
// createCliFunctionRegistry 的唯一领域接入：
return createFunctionRegistry([
  ...createDemoCommands(), ...createPbenchCommands(), ...createComputerUseCommands()
]);
```

- [ ] 同时测试 `--type=--help`、含空格/换行的文字、空文本与 `--help` 本身：帮助不初始化驱动，不吞掉要输入的文本。不以 shell 拼接用户输入。
- [ ] 运行上述测试与 `bun run typecheck`；确认 help/list 原行为保持，记录审查结果。

## Task 2：SDK 懒加载、生命周期与通用 doctor

**Files:** runtime.ts、commands.ts；runtime / cli 测试。

**Interfaces:**
- Consumes：锁定 SDK 的 `CuaDriver.create`、metadata、EndSessionInput 与 macOS 只读权限查询（先从 0.27.0 声明确认真实导出）。
- Produces：`loadSdk(): Promise<typeof import("@trycua/cua-driver")>`；`withDriver<T>(fn: (driver: CuaDriverLike, sdk: typeof import("@trycua/cua-driver")) => Promise<T>): Promise<T>`；doctor JSON。
- 纯定位函数 `compiledSdkUrl(execPath: string): string` 按真实 executable 路径定位；开发路径不用它。

- [ ] 先写失败测试：调用 help、list、install 或非法参数时 importer 次数为零；SDK 缺失只影响该 domain；callback 抛错后仍 shutdown/destroy；清理失败不覆盖原动作错误，也不静默报告全成功。
- [ ] 用临时目录创建真实文件及 symlink，验证 compiled 定位不受 cwd 影响；缺 runtime 时错误指向重装，而非寻找 cowork-e2e。

```ts
// runtime.ts 的 compiled 分支定位形状；实现时用 realpath 验证真实二进制。
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
export function compiledSdkUrl(execPath: string): string {
  return pathToFileURL(join(dirname(realpathSync(execPath)),
    "runtime", "computer-use", "node_modules", "@trycua", "cua-driver", "dist", "index.js")).href;
}
```

- [ ] 运行 `bun test tests/computer-use-runtime.test.ts tests/cli.test.ts`，确认 RED 后实现。通过明确 build define 区分 compiled 模式，声明该编译常量；源码模式使用正常 package import。compiled 使用变量 URL import，不能把绝对开发路径编译进去。
- [ ] 有序 `try/finally`：成功创建后总是 await endSession、await shutdown、destroy；每个清理步骤即使前一个失败也要尝试。保留主错误和清理诊断。
- [ ] 添加挂起调用与挂起清理的失败测试，再实现命令总时限 30 秒、清理最多额外 5 秒的界限。测试通过可注入计时器缩短等待；退出只针对本次 CLI。超时输出失败，未确认的动作报告 `actionOutcome: "unknown"`，不重放动作。
- [ ] doctor 分项输出 supported platform / SDK version / native files / permission status，区分 unknown 与 denied；不请求授权，不调用现有 Cowork doctor。不支持平台先拒绝 import。
- [ ] 运行 runtime / CLI 测试和 typecheck。此任务不使用真实 UI、截图或弹窗。

## Task 3：观察、动作和隐私边界

**Files:** observe.ts、act.ts、artifacts.ts、commands.ts；computer-use 测试。

**Interfaces:**
- Consumes：Task 1 ParsedRequest、Task 2 withDriver。
- Produces：成功 JSON envelopes `{ apps }`、`{ windows }`、`{ pid, windowId, title, elements, screenshot? }`；错误包含 code/message，动作后观察失败另含 `actionDelivered: true`。
- 窗口类型 `{ pid: number; windowId: bigint; title: string }`；`selectWindow(windows, requestedId?)` 必须唯一。
- `clickWith(read: () => Promise<AxElement[]>, click: (token: string) => Promise<void>, matches: (e: AxElement) => boolean): Promise<void>` 是 stale-token 的纯测试切入点；AxElement 定义 role/label/value/elementToken/frame/enabled，密码值先脱敏。

- [ ] 添加以下纯逻辑测试，先记录失败：两窗口拒绝；零/多元素拒绝；一次 stale 成功、两次 stale 失败；非 stale 不重试；type/key/scroll ToolResult.isError 不成功；动作已投递后 snapshot 失败不重新动作；密码值不出现在 JSON/故障证据；输出目录只读仍可用默认 cache。

```ts
import { expect, test } from "bun:test";
import { selectWindow } from "../packages/functions-computer-use/src/observe.js";

test("ambiguity cannot send an action to a different document", () => {
  const windows = [
    { pid: 10, windowId: 1n, title: "A" },
    { pid: 10, windowId: 2n, title: "B" }
  ];
  expect(() => selectWindow(windows)).toThrow(/window/i);
  expect(selectWindow(windows, 2n).title).toBe("B");
});
```

- [ ] 运行 `bun test tests/computer-use.test.ts`，再移植所需通用逻辑。只参考旧 `scripts/cu.ts`、src/driver.ts、src/act.ts、src/locate.ts；不导入 cowork-e2e，不搬 launchApp/envGuard/withApp、Cowork 标题或登录规则。
- [ ] 每次 click 重新 snapshot，唯一选择；明确 Background 投递。只对确认未投递的 stale token 重新读取并重试一次，不添加通用 retry wrapper。
- [ ] 使用原 SDK 操作返回值判断失败；post-action snapshot 失败要保留“已投递”事实。输出窗口 ID 字符串化，保留 frame；不沿用旧投影丢 frame 或截断文字的问题。
- [ ] 私有 cache 目录权限 0700、证据文件 0600，随机唯一文件名；只在需要时写文件。输出绝对截图路径；不把诊断混入 stdout JSON。
- [ ] 运行测试和 typecheck，审查全部动作分支，确认没有静默前台 fallback、硬编码 app 或任意动作重放。

## Task 4：可安装 Skill 与使用文档

**Files:** skills/computer-use 两文件、docs/computer-use.md、README 双语、AGENTS；catalog/install/CLI 测试。

**Interfaces:**
- Consumes：前三任务的真实命令与行为。
- Produces：`yk install computer-use` 安装到已有 catalog 目标，支持 -g 与双目录；Skill 仅调用 `yk computer-use`。

- [ ] 在新增 Skill 前运行一个前台、只读的使用场景基线：在非 Cowork 项目想观察浏览器，不提供旧仓库。记录 Agent 当前选择的入口，不授权真实动作。再增加 catalog/install 失败测试。

```ts
const catalog = await loadCatalog(resolve("skills"));
const skill = catalog.byName.get("computer-use");
expect(skill?.dependsOn).toEqual([]);
expect(skill?.functions.map(f => f.action)).toEqual([
  "doctor", "apps", "windows", "perceive", "act"
]);
```

- [ ] 运行 `bun test tests/catalog.test.ts tests/install.test.ts tests/cli.test.ts` 记录 RED；新增 manifest：

```json
{
  "name": "computer-use",
  "description": "Use when a task needs real desktop UI interaction on macOS, such as inspecting app state, reproducing a UI issue, or operating a visible window.",
  "functions": [
    { "domain": "computer-use", "action": "doctor" },
    { "domain": "computer-use", "action": "apps" },
    { "domain": "computer-use", "action": "windows" },
    { "domain": "computer-use", "action": "perceive" },
    { "domain": "computer-use", "action": "act" }
  ]
}
```

- [ ] Skill 给出一个完整 `apps → windows → perceive → act → perceive` 示例，使用 help 获取完整参数。写明后台、串行、最小权限、不可逆操作确认、不可自动跑 Cowork E2E、不可把“输入回显”当业务成功。
- [ ] Skill 安装只复制说明文件，不复制 50 MiB 原生资源。对重装/全局/双目录使用现有安装测试，不改变依赖删除规则。
- [ ] 加载新 Skill，重跑相同使用场景，确认只选 yk、不搜索本地开发仓库。文档版本、命令、权限步骤来自实际实现；更新现有“单一二进制”表述为“一个命令及随包运行资源”。
- [ ] 运行 catalog/install/CLI 测试；人工读清全部新 Skill 命令，记录基线/新指南的差别，不用字符串断言代替 Agent 使用测试。

## Task 5：可重复的 native 配套文件与发布包

**Files:** scripts/package-release.ts、根 package.json、packaging/runtime 测试、两个 release workflow。

**Interfaces:**
- Consumes：bun.lock 安装的运行依赖、Task 2 executable-relative loader、现有 dist/yk 与 skills/。
- Produces：`dist/release/ya-skills/{yk,skills/,runtime/computer-use/node_modules/}`；现有 `ya-skills-v<version>-macos-arm64.tar.gz` 与 `.sha256`。
- `bun run package:release -- --version <version>` 是两个 workflow 共用的入口；版本参数来自各 workflow 已有 release 变量，不各自再拼一套复制逻辑。

- [ ] 先写 packaging 失败测试，验证 manifest 中每个必需文件实际存在：Cua SDK、darwin-arm64 .node/dylib、@ubjs/core、@ubjs/node resolver、各包 package.json 和 notices；拒绝指回源码/缓存的 symlink；缺任一文件打包失败。
- [ ] 运行 `bun test tests/computer-use-packaging.test.ts`；确认 RED 后新增配套组装。以锁定依赖的 package.json 为版本来源，只允许已确认版本组合，不复制完整开发 node_modules，也不依赖 `/tmp/cua-bun-probe.*`。
- [ ] 根 compiled 构建加以下关键选项，保留原产物名；显式 compiled define 在 Task 2 声明并消费。Node-target build 继续通过现有 smoke，不因懒加载而失效。

```sh
bun build --compile --target=bun-macos-arm64 \
  --compile-autoload-package-json \
  --define YA_SKILLS_COMPILED=true \
  --external @trycua/cua-driver \
  --outfile=dist/yk packages/cli/src/cli.ts
```

- [ ] 真正编译、打 tarball、解包并执行 `--help`、`--version`、`list`、computer-use help；从空 cwd 和含无关/恶意 package.json 的 cwd 执行。伪造项目 scripts/exports/imports 的哨兵文件不能执行，SDK 仍只来自安装目录；若 autoload 扩大不可信输入影响，阻断发布并收窄方案，不加静默豁免。
- [ ] 测试 runtime 缺失/版本错配只产生可读错误；重命名安装目录后可用；bin symlink 可用；NODE_PATH unset，不提供 node 可执行文件。Linux CI 只跑纯测试，macOS packaging job 负责 arm64 产物，不把未执行 native 用例计 PASS。
- [ ] 两个 workflow 都调用相同 package:release；读取打包输出完成现有上传与 checksum，不改版本/tag/tap token 流程。保留 native notices，核对再分发条款，不假设整个新增二进制仅 MIT。
- [ ] 执行 `bun run build && bun run build:binary:macos-arm64 && bun run smoke` 与 packaging 测试。验证配套资源来自解包产物，不是编译机器上的模块解析缓存。

## Task 6：Homebrew 安装布局及现有功能回归

**Files:** scripts/update-ya-skills-formula.py、tests/homebrew-formula.test.ts、AGENTS、README 双语、docs/computer-use.md。

**Interfaces:**
- Consumes：Task 5 tarball 布局与现有公式更新器。
- Produces：现有 tap 自动更新流程可将真实 yk 和 runtime 安装到相邻位置；bin wrapper 继续配置 `YA_SKILLS_CATALOG_DIR`。

- [ ] 读取实际 tap 公式作为只读参考；不直接改 tap。把它的完整 install block 放入测试 fixture，先验证当前 updater 不会安装 runtime 的失败。
- [ ] updater 保持幂等，必要的目标 Ruby 布局为：

```ruby
libexec.install "yk", "runtime"
pkgshare.install "skills"
(bin/"yk").write_env_script libexec/"yk", YA_SKILLS_CATALOG_DIR: pkgshare/"skills"
```

- [ ] 保留实际公式其他 metadata/test，不整份猜写。依旧不设置 formula version，不添加 `depends_on "node"`；updater 重复执行不重复插入 install 行，遇到未知 install 形状明确失败。
- [ ] 运行 `bun test tests/homebrew-formula.test.ts`；从模拟 libexec/pkgshare/bin 布局启动，覆盖 wrapper/symlink 的真实 executable 解析、install -g、已有其他 domain 命令。
- [ ] 两条 workflow 的公式/资产衔接均纳入测试；文档写清 brew 包附带资源与权限归属可能变化。真实 tap 推送、brew 升级、发布必须另行授权，此任务不自动操作。

## Task 7：发布产物的真实桌面验收与最终审查

**Files:** 更新 docs/computer-use.md 的验证记录；只按发现的问题修复此前任务文件，不增加第二实现。

**Interfaces:**
- Consumes：Task 5 解包后的完整产物、Task 6 安装布局。
- Produces：测试矩阵、真实行为证据、未测清单和可合入结论；不自动发布。

- [ ] 先跑全量纯验证并逐项记录结果：

```sh
bun run typecheck
bun test
bun run build
bun run build:binary:macos-arm64
bun run smoke
bun run package:release -- --version 0.18.0
```

这里 0.18.0 只作为当前基线的本地打包测试版本，不 bump version、不创建 tag；执行时若基线已经改变，读取实际 package.json 版本传入。

- [ ] 使用解包产物在独立临时目录执行 doctor/apps/windows，记录真实 Bun 版本、驱动版本、同进程证据、退出码。没有权限则停止对应检查并标未验证，不改 TCC、不假装环境检查通过。
- [ ] 向用户确认一个可写、非敏感的测试窗口，以及点击/输入/按键/滚动/截图的验证范围。不得把此计划批准解释为发送消息、删除文件或提交表单的授权。
- [ ] 在该窗口串行验证 AX、截图、后台点击、输入、按键、滚动、post-action observe；操作前后检查前台应用未变化。多窗口不指定 window 必须拒绝；隐藏/不可观察窗口不得自动激活。截图含敏感数据时不保存/外传。
- [ ] 用独立前台只读审查核对安全分支、错误传播、发布路径和证据。review 与 writer 串行；按当前工具协议执行，若前台审查不受支持先询问用户，不自动重试后台。
- [ ] 最终报告分别列出纯测试/发布包/真实 UI/Homebrew：通过、失败、未执行及原因。只有实际完成的层级可称通过。报告改动路径、恢复办法与残余风险；不以“研究跑通”替代完整产品验收。

## 执行顺序与停止条件

Task 1 → 2 → 3 → 4 → 5 → 6 → 7。每项先 RED、最小实现、GREEN，再审查。实现期间可在用户认可的分支内按任务提交，不自动 push 或创建 release。

以下立即停止并报告：新原生崩溃/挂起、需要前台权限但用户未授权、配套文件只能靠源码路径加载、陌生 cwd 可以替换 SDK/执行项目代码、依赖许可证无法确认、工具运行协议失败。不得用新增 Node worker、自动下载或修改上游 SDK 来暗中绕过。

## 计划自检

- [x] 用户目标、CLI/Skill、后台安全、参数/输出、native 生命周期均有对应任务。
- [x] Bun 1.3.14 同进程方案与外置资源的实测/未测边界分开。
- [x] 两条 release workflow、Homebrew 安装、Node-target 现有 smoke 都在范围内。
- [x] 默认 CI 与真实 UI 验收分开；没有授权 Cowork E2E、发布或 tap 写入。
- [x] 临时探针仅为证据，不作为构建依赖；既有 cowork-e2e 不被宣称已迁移。
- [x] 本文所有实现任务仍未执行，等待用户批准。
