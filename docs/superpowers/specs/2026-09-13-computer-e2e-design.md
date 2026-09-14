# 通用 Computer-Use / Computer-E2E 设计

日期：2026-09-13。状态：根据用户已确认的职责和交付方式编写，细化接口随实施计划一起待审；尚未实现。

## 1. 目标与交付边界

ya-skills 交付两个通用 Skill：`computer-use` 用于 LLM 逐步观察、决策、操作；`computer-e2e` 用于编写和运行固定测试代码。运行回归时，不让 LLM 临时选路、修改断言或接管失败步骤。

使用方只安装 yk 和 Skills，不安装 Node、Bun、Vitest、驱动 SDK 或另一个 npm 包。开发 ya-skills 所用的工具不等于使用方依赖。被测应用自身的构建依赖仍归该应用负责。

`cowork-e2e` 是第一个消费项目：保留 Cowork 用例、选择器、环境政策、启动/关闭逻辑、历史和报告。它不再拥有通用驱动实现。

## 2. Global Constraints

以下各行也是配套计划的全局约束；以相同文字复制。

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

## 3. 架构：两个入口，共享实现

```text
computer-use Skill → yk computer-use 单步命令 ─┐
                                              ├→ 内部 computer-runtime → Cua SDK
computer-e2e Skill → yk computer-e2e run ──────┘
                       │
                       ├ 主进程：参数、运行目录、日志、超时监督、报告
                       └ 同一 yk 的工作进程：加载测试、连续执行、驱动同进程运行
```

工作进程不是另一个产品、Node worker 或常驻 daemon。用同一个 yk 可执行文件自启动一次（每个测试文件一个工作进程，顺序执行）。这是为了让外部测试的无限循环或同步 native 卡死也能被父进程终止，并留下失败记录。仅靠 Promise.race 不能终止这些工作。

共享代码放在私有 workspace `packages/computer-runtime`。`packages/functions-computer-use` 保留参数解析、一次动作后的观察信封。`packages/functions-computer-e2e` 提供有限的顺序执行器，不复制整个 Vitest，不支持插件、多机、并发、自动重试和自动修复。

## 4. 必须先验证的技术假设

用 Bun **1.3.14** 编译临时 yk 形态的程序，验证：

1. 从文件系统加载外部 `.e2e.ts` / `.e2e.mjs`；支持文件内 TypeScript 类型擦除、相对模块导入和 `node:` 内置模块。
2. 运行文件没有 node_modules；PATH 不含 node/npm/bun；仍能执行纯断言。
3. 程序可通过 realpath 后的自身路径启动工作进程，父进程能取得退出码、独立控制通道和输出日志。
4. 超时能够终止死循环工作进程，不遗留同组子进程。
5. 运行目录（cwd）的项目内容按受信处理——与测试文件同级信任（本条为 2026-09-13 用户裁定，取代初稿"bunfig preload 不执行"的阻断条件，实测依据见 docs/research/2026-09-13-compiled-e2e-loader.md）。必须保持并已验证的硬边界：不执行 package.json 生命周期脚本；不自动安装依赖（导入失败即失败）；bunfig 查找不向上遍历父目录；SDK 只从安装目录 sidecar 的绝对路径解析，不从 cwd/NODE_PATH 解析。文档义务：SKILL 与 docs 必须写明在不受信目录运行 yk 会执行该目录 bunfig 的 preload。

探针禁止调用 SDK/桌面，证据写入文档。任一关键条件不成立则停止并回到设计评审；不能偷偷改为消费方安装 npm 包。

## 5. 使用方测试文件契约（API version 1）

每个文件默认导出一个 Suite 对象。只允许一个 suite、顺序 cases、beforeAll/afterAll；无 describe 嵌套、mock 系统、Vitest 兼容层。TypeScript 运行时仅转译，不宣称执行了静态类型检查。

```ts
import assert from 'node:assert/strict';

export default {
  apiVersion: 1,
  id: 'example',
  name: '示例',
  tests: [{
    id: 'arithmetic',
    name: '纯代码用例不应初始化桌面驱动',
    async run(ctx) {
      await ctx.step('检查结果', async () => {
        assert.equal(1 + 1, 2);
      });
    },
  }],
};
```

发布类型文件 `skills/computer-e2e/references/api.d.ts` 从内部类型生成；安装 Skill 会携带该文件。不要求用例导入 npm 类型包。示例可不加类型标注；静态检查属于可选开发工具，不影响运行。

接口定义（所有名称由计划 Task A2/A4 实现）：

```ts
export interface Target { pid: number; windowId: bigint }
export interface WindowRef extends Target { title: string }
export interface AppRef {
  pid: number; name: string; bundleId?: string; running?: boolean; active?: boolean;
}
export interface AxElement {
  role?: string; label?: string; value?: string; elementToken?: string;
  frame?: { x: number; y: number; w: number; h: number }; enabled?: boolean;
}
export interface Snapshot {
  elements: AxElement[]; title: string; imageBase64?: string;
}
export type Predicate = (element: AxElement) => boolean;
export interface Computer {
  apps(): Promise<AppRef[]>;
  windows(pid: number, options?: { onScreenOnly?: boolean }): Promise<WindowRef[]>;
  snapshot(target: Target, options?: { screenshot?: boolean }): Promise<Snapshot>;
  click(target: Target, predicate: Predicate, description: string): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  key(target: Target, key: string, modifiers?: string[]): Promise<void>;
  scroll(target: Target, options: {
    direction: 'up' | 'down' | 'left' | 'right'; amount: number; x: number; y: number;
  }): Promise<void>;
  waitFor(target: Target, predicate: (elements: AxElement[]) => boolean,
    description: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<AxElement[]>;
}
export interface ApplicationInfo {
  name: string; revision: string | null; dirty: boolean | null; environment: string;
}
export interface CaseContext {
  computer: Computer;
  signal: AbortSignal;
  params: Readonly<Record<string, string>>;
  artifactsDir: string;
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  skip(reason: string): never;
  setApplication(info: ApplicationInfo): void;
  capture(target: Target, name: string): Promise<{ elementsPath: string; screenshotPath?: string }>;
}
export interface TestCase {
  id: string; name: string; timeoutMs?: number; skip?: string;
  run(context: CaseContext): Promise<void> | void;
}
export interface Suite {
  apiVersion: 1; id: string; name: string; hookTimeoutMs?: number;
  beforeAll?(context: CaseContext): Promise<void> | void;
  afterAll?(context: CaseContext): Promise<void> | void;
  tests: TestCase[];
}
```

`setApplication` 的数据来自项目，不让通用层猜测 Cowork 配置。`params` 不自动写入报告值，只记 key；禁止通过 CLI 传秘密。自定义 case/step 名称和错误文本也可能包含敏感信息，由用例作者控制。通用层过滤密码元素 value，不宣称任意自定义输出都可安全脱敏。

## 6. 命令契约

```sh
yk install computer-use computer-e2e
yk computer-e2e run tests/smoke.e2e.ts
yk computer-e2e run tests/smoke.e2e.ts tests/session-flow.e2e.ts --param app-root=/path/to/cowork-app
yk computer-e2e history --out-dir .computer-e2e/runs --limit 20
yk computer-e2e report .computer-e2e/runs/RUN_ID
```

`run` 只接受显式文件，不默认扫描/执行整个目录。可重复 `--param key=value`，重复 key 拒绝；支持 `--out-dir DIR`、`--timeout-ms N`（整个调用工作预算，默认 900000）和 `--require-version V`（与 yk --version 严格匹配，启动前拒绝漂移）。不提供通用生产环境绕过 flag、foreground flag、自动 retry flag。

`history` 读取运行目录输出 JSON；`report RUN_DIR` 根据日志生成 Markdown 到 stdout，不运行测试。`run` stdout 只输出最终 JSON 摘要，测试 stdout/stderr 保存到运行目录。

退出码：0 仅表示至少一个 case 且全数通过、清理成功；1 表示参数/加载/钩子/断言/超时/清理等失败；2 表示没有失败但存在 skipped/not_run 或零用例；用户中断保留 130/143。父进程被 SIGKILL 后无法完成终态的记录由 history 标为 incomplete，不能推断通过。

## 7. 生命周期与错误语义

- 先验证参数并创建 run 记录，再启动工作进程；加载失败也有记录。
- 工作进程加载 suite，验证 id 唯一、函数及预算合法，发送完整 case 清单，随后运行 beforeAll。
- case 按顺序执行；首个失败后本文件后续 case 标 not_run，后续文件也不执行。显式 skip 不算失败但必须汇总。
- beforeAll 失败：所有 case 标 not_run，记录 hook_error；afterAll 仍尝试一次。
- 工作进程用 AbortController 阻止超时后的新操作；父进程负责真正停止不合作或同步卡死的工作。waitFor总预算可大于30000ms，它是多次只读观察组成的轮询；每次原生调用仍受30000ms上限和外层剩余预算共同约束，不能把整个E2E session限制为30秒。
- SIGINT/SIGTERM/超时先要求工作进程退出，允许 15000ms 共享清理宽限，然后终止仅本次创建的工作进程组。不按应用名/全局 PID 列表杀进程。
- 已脱离进程组的应用/重启实例不能保证清理；报告必须记录清理不能确认，交给用户，不允许猜 PID 后终止。
- 一个操作超时后该 session 不再接受操作；已经投递的操作不能被 Promise 超时撤销。未知结果记 unknown，已明确拒绝记 not_delivered，返回投递成功记 delivered。
- `computer-use` 保留已有 JSON 契约。共享异步预算必须跨 load/create/work 使用同一绝对截止点；同步 native 卡死在单步入口仍没有硬终止保证，文档如实写出，不把 Promise 超时描述成进程终止。
- cleanup 错误不覆盖主错误；E2E 即使断言全通过，cleanup 失败也不能报告整次通过。

## 8. 历史与证据

```text
.computer-e2e/runs/<UTC-time>-<uuid>/
  events.jsonl       # 父进程唯一写入者；事实来源
  run.json           # 由事件归约的摘要
  report.md          # 同一摘要的可读形式
  worker-1.stdout.log
  worker-1.stderr.log
  artifacts/
```

每个 run 单独目录；不做全局可变 index.json。事件包含 schemaVersion=1、runId、seq、time、type、payload。类型限于 run_started、runtime、suite_collected、hook_started、hook_finished、case_started、case_finished、step_started、step_finished、action_started、action_finished、application、artifact、run_finished。runtime事件只在SDK实际懒加载后记录版本，不为填报告而加载未使用的驱动。

使用 fd3 独立 NDJSON 控制通道，不能把用例 console.log 当协议。父进程分配 seq；行长度上限 1MiB；未知/非法事件视为 worker_protocol_error。工作进程仍是受信任代码，控制通道不构成安全隔离。

run 摘要至少有：ykVersion、ykExecutableSha256（实际yk字节的SHA256）、Bun 版本、平台/架构、apiVersion、SDK 版本（未加载时 null）、测试仓库 commit/dirty（无 Git 时 null）、入口文件 SHA256、应用身份（项目提供或 null）、开始/结束、case/step 结果、跳过原因、主错误、清理错误、证据路径、exitCode。metadata字段名固定为ykVersion、ykExecutableSha256、bunVersion、platform、arch、apiVersion、sdkVersion、testsRepo、testSources、application。版本号用于兼容性拒绝，不等于二进制内容锁。dirty 标记不是完整源码快照，不宣称能恢复未提交的依赖文件。

密码 value 在结构化 AX 输出中过滤。失败证据优先使用最近一次合法快照；额外只读 capture 失败不覆盖主错误。截图默认仅显式 capture 或失败取证时生成，永不自动提交 Git，不自动清理历史。

## 9. 迁移边界

通用层不写 LogosCowork、SSO Login、[COE]、staging、cowork-app 路径。测试项目仍可以包含这些值。

Cowork 后续计划把 Vitest suites 改成上述 Suite 文件；迁移不承诺源码不变，但必须逐条保留原用例意图与等待条件。保留本地薄 `cowork-e2e` Skill，指向已安装的通用 Skills；通用 Skills 不反向依赖它。

当前 `envGuard.ts` 和测试存在 E2E_ALLOW_PROD 绕过，而当前 Skill 写“prod always forbidden”。迁移计划明确选择后者，删除绕过；这是需随计划批准的安全收紧，不静默冒充无行为变化。

## 10. 验收与非目标

验收分开计数：纯测试、无桌面发布包测试、用户授权真实通用 UI、用户授权 Cowork smoke/gateway、真实 Homebrew 安装。没有授权的项目记未执行，不算通过。测试基础设施本身使用假 Computer；验证 Cowork 业务的正式 E2E 不使用 app mock。

非目标：npm 分发、用户安装运行时、另一个 CLI、Vitest 完整兼容、并发执行、自动录制鼠标轨迹、视觉自愈、自动调用 LLM、历史服务/数据库、自动测试数据删除、多平台支持。
