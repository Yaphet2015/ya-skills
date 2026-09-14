# Computer Use Persistent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多次命令复用同一桌面 driver，可靠处理重复请求、目标竞争、断线和终止。

**Architecture:** computer-session 的本地宿主管理 socket、事件和 worker；原生 driver 在专用 worker 内，不阻塞宿主的状态/取消接口。CLI、exec worker 都通过同一个宿主请求面调用 runtime，不复制动作实现。

**Tech Stack:** Bun 1.3.14、TypeScript、node:net、node:child_process、Unix socket、同一 yk 自启动。

**Spec:** `docs/superpowers/specs/2026-09-14-computer-use-agentic-design.md`

## Global Constraints

- 先完成桌面基础计划 A；共享类型只从 computer-runtime 导入。
- 脚本按受信本机代码执行，不建设 VM、容器或 OS 权限沙箱。
- SDK 继续 lazy load，help/list/install 不加载 native。
- 不要求 Homebrew 用户额外安装 Node/Bun。
- 状态目录0700、文件0600；socket 不监听 TCP。
- 原生未知投递不可自动重放；原生 worker 未确认终止不得释放目标。
- 不增加模型调用、脚本审计、调用方权限配置或运行时适配。

---

## 文件与接口总表

新包 `packages/computer-session`：

| 文件 | 职责 |
|---|---|
| src/types.ts | session 和 wire 请求/结果 |
| src/protocol.ts | NDJSON framing、1MiB消息上限、bigint转换、版本校验 |
| src/paths.ts | session私有目录、短socket路径、UUID校验 |
| src/client.ts | 一次请求发送/结果读取，不在超时后重发mutation |
| src/host.ts | socket服务、状态、单mutation准入、worker管理 |
| src/driver-worker.ts | 单个 ComputerSession、固定方法派发、动作事件 |
| src/process.ts | 源码/compiled自启动、TERM/KILL、退出证据 |
| src/index.ts | 导出公开会话客户端和内部启动入口 |

其它修改：runtime target-lease（供单步/batch/E2E/session共同使用），functions-computer-use/session-command，CLI最小启动路由、workspace imports。

### wire 契约

```ts
export interface SessionInfo {
  id: string;
  target: { pid: number; windowId: string };
  state: "starting" | "idle" | "running" | "stopping" | "closed" | "unusable";
  activeRequestId?: string;
  hostPid: number;
  generation: string;
  idleTimeoutMs: number;
}
export type SessionOperation =
  | { kind: "observe"; options?: ObserveOptions }
  | { kind: "batch"; request: BatchRequest }
  | { kind: "exec"; code: string; sourceName: string; timeoutMs: number; maxActions: number };
export interface SessionRequest {
  schemaVersion: 1;
  sessionId: string;
  generation: string;
  requestId: string;
  operation: SessionOperation;
}
export interface SessionReply {
  schemaVersion: 1;
  requestId: string;
  status: "completed" | "failed" | "interrupted" | "running" | "unknown";
  result?: unknown; // decode按operation分发至Observation/BatchResult/ExecResult，不能透传任意JSON
  error?: { code: string; message: string };
}
```

Types 中 ObserveOptions/BatchRequest 从 runtime 引入。C 扩展 exec 结果；B 收到 exec 时返回 `unsupported_operation`，不得静默成功。

控制面独立于 SessionRequest：`status(sessionId)`、`cancel(sessionId, requestId)`、`close(sessionId)`。返回 SessionInfo；status 不调用 driver、不延长 idle。observe 也按业务单请求排队规则执行，不在原生mutation期间插入读取。

## Task B1：协议和私有目录，无桌面依赖

**Files**
- Create：`packages/computer-session/{package.json,src/types.ts,src/protocol.ts,src/paths.ts,src/client.ts,src/index.ts}`
- Modify：`tsconfig.json`、`packages/functions-computer-use/package.json`、`bun.lock`
- Create：`tests/computer-session-protocol.test.ts`

**Interfaces**

```ts
export function encodeRequest(request: SessionRequest): string;
export function decodeRequest(line: string): SessionRequest;
export function sessionPaths(root: string, id: string): {
  directory: string; socket: string; metadata: string; events: string;
};
export function sendRequest(socket: string, request: SessionRequest,
  timeoutMs: number): Promise<SessionReply>;
```

- [ ] 创建 workspace package（无模型依赖，依赖 `@ya-skills/computer-runtime: workspace:*`），新增 tsconfig paths。先写测试再补实现，package配置与任务一起交付。
- [ ] 写失败测试：

```ts
const request: SessionRequest = {
  schemaVersion: 1, sessionId: crypto.randomUUID(), generation: crypto.randomUUID(),
  requestId: crypto.randomUUID(), operation: { kind: "observe", options: { mode: "ax" } },
};
expect(decodeRequest(encodeRequest(request))).toEqual(request);
expect(() => decodeRequest(JSON.stringify({ ...request, schemaVersion: 2 })))
  .toThrow(/protocol_version/);
expect(() => sessionPaths("/tmp/private", "../../escape")).toThrow(/session_id/);
```

再测 partial frame、多frame、非法UTF8/JSON、超过1MiB、非十进制windowId、客户端超时后server收到消息次数仍为1。
- [ ] Run `bun test tests/computer-session-protocol.test.ts` 确认 red。
- [ ] 实现 framing buffer，超过上限立即断连接；不是累积完整超大字符串后才验证。控制命令走固定 tag，不支持任意 method name。
- [ ] 私有根目录由 options 注入便于测试；默认 socket 置于当前用户临时目录中的0700短目录（控制完整路径 <=90 bytes），session记录仍在用户 cache。socket路径从受控 metadata 获取，不从用户传入任意字符串连接。
- [ ] Run `bun install && bun run typecheck && bun test tests/computer-session-protocol.test.ts`。记录 lock diff，确认无非公开 registry。
- [ ] 提交 `feat: define local computer session protocol`。

## Task B2：会话宿主与 driver worker

**Files**
- Create：`packages/computer-session/src/{host,driver-worker,process}.ts`
- Modify：`packages/computer-session/src/{types,index}.ts`
- Create：`tests/computer-session-host.test.ts`
- Create：`tests/helpers/session-worker.ts`

**Interfaces**

```ts
export interface OpenSessionOptions {
  target: Target;
  root?: string;
  idleTimeoutMs?: number; // default/max 120000
}
export function openSession(options: OpenSessionOptions): Promise<SessionInfo>;
export function hostMain(configPath: string): Promise<number>;
export function driverWorkerMain(configPath: string): Promise<number>;
export function stopProcessGroup(child: ChildProcess, graceMs: number): Promise<{
  exited: boolean; signal: NodeJS.Signals | null; code: number | null;
}>;
```

host 与 driver 分开：宿主保持可响应，driver worker 内 createComputerSession 一次。driver helper 不增加第二套 timeout 语义，调用 A 的 Computer。

- [ ] helper fake driver 通过受限测试注入启动，不能靠公开 `--fake-driver` flag。返回 driverInitCount，使用合成观察，不 import SDK。
- [ ] 写失败测试：

```ts
const host = await startTestHost({ driver: "fake", idleTimeoutMs: 500 });
try {
  await host.observe({ mode: "ax" });
  await host.observe({ mode: "ax" });
  expect((await host.diagnostics()).driverInitCount).toBe(1);
  expect((await host.status()).state).toBe("idle");
} finally { await host.close(); }
```

`startTestHost` 在 tests/helpers/session-worker.ts 实现，内部公开方法使用真实 socket/client，diagnostics 仅 fake worker fixture 返回；不是mock整个session。
- [ ] Run `bun test tests/computer-session-host.test.ts` 确认 red。
- [ ] 宿主收到已校验请求才派发；状态 running 时立即返回 `session_busy`，不隐藏排长队。status/cancel/close 始终可用。
- [ ] 读取请求身份必须匹配当前 generation；启动ready回执在socket和driver握手准备后发送。native仍lazy，打开会话不自动截图或点击。
- [ ] idle计时仅在无在途业务请求时启动，最长120s；status不续期。不在 SDK 五分钟隐式session失效后自动假装同epoch复用。
- [ ] 子进程资源使用显式 cwd：启动在私有目录；脚本需要的 cwd 在 C 显式传递并记录，避免启动时执行项目 preload。不能改变原安装加载规则却不写文档。
- [ ] Run session tests、`tests/computer-runtime-budget.test.ts`、typecheck；提交 `feat: reuse desktop driver in persistent sessions`。

## Task B3：请求去重、目标占用、取消与崩溃

**Files**
- Modify：`packages/computer-session/src/{host,process,client,types}.ts`
- Create：`packages/computer-runtime/src/target-lease.ts`
- Modify：`packages/computer-runtime/src/{session,index,request-journal}.ts`
- Create：`tests/{computer-session-recovery,computer-target-lease}.test.ts`

**Interfaces**
- 复用 A5 RequestJournal。hash = 规范化操作内容+目标+版本，不含传输generation/requestId；exec 含捕获代码，文件名只作诊断。
- `acquireTargetLease(root, target, owner): Promise<{ release(): Promise<void> }>`，owner 包含随机 generation、pid、进程启动身份、sessionId或临时runId。
- 目标锁放 runtime 确保单步CLI/E2E/session不互相绕过；第一次mutation持有至session关闭；read-only不抢占桌面。
- 采用应用级 lease（以 pid 和进程身份），比同窗口严格，避免同app多个窗口共享焦点导致竞态；错误仍报告具体窗口。

- [ ] 写失败测试：

```ts
const host = await startTestHost({ driver: "fake" });
const request = host.batchRequest([{ kind: "key", key: "Return" }]);
await host.send(request);
await host.send(request);
expect((await host.diagnostics()).deliveries).toBe(1);
await expect(host.send({ ...request, operation: { kind: "batch", request: {
  actions: [{ kind: "key", key: "Escape" }],
} } })).rejects.toThrow(/request_conflict/);
await host.close();
```

再测 response 丢失/客户端退出不触发重放、宿主死前 action_started 无finished→unknown、日志尾截断不变成success、两个真实测试进程不能同时lease。
- [ ] Run recovery/lease tests 确认 red。
- [ ] 宿主自己追加递增seq的事件；执行前持久化 started，动作结束后append outcome；reports从日志reduce，metadata只是路径/发现缓存。
- [ ] 去重先查已有请求再检查busy。running的重复返回running；unknown的重复返回unknown；不因重连重新派发。
- [ ] 取消顺序：关闭该请求准入→终止C脚本（存在时）→等待原生在途→期限到则终止driver→确认退出→保存unknown/closed。timeout后不尝试对同个不稳定driver perceive。
- [ ] TERM grace=2000ms，然后KILL；宿主关闭前等待driver退出，仍无法确认时state=unusable、lease保留。禁止仅通过旧PID存在与否杀进程，身份不匹配时报告 `owner_identity_unknown`。
- [ ] driver通过宿主liveness pipe检测失联；宿主对worker存活定期watchdog。实机原生不可取消路径如无法保证回收记录限制，不恢复执行。
- [ ] epoch重建必须invalidate所有观察；用户显式新session后才能继续。系统不承诺 exactly-once OS副作用，只保证不自动重发。
- [ ] Run `bun test tests/computer-session-recovery.test.ts tests/computer-target-lease.test.ts tests/computer-request-journal.test.ts tests/computer-e2e-supervisor.test.ts && bun run typecheck`。
- [ ] 提交 `feat: prevent session replay and conflicting desktop ownership`。

## Task B4：公开 CLI、自启动和分发兼容

**Files**
- Create：`packages/functions-computer-use/src/session-command.ts`
- Modify：`packages/functions-computer-use/src/{args,commands,index,batch-command,observe-command}.ts`
- Modify：`packages/cli/src/cli.ts`
- Modify：`packages/computer-session/src/process.ts`
- Modify：`docs/computer-use.md`、`README.md`、`skills/computer-use/SKILL.md`
- Create：`tests/{computer-use-session-cli,computer-session-packaging}.test.ts`

**Interfaces**
- 内部 `__computer-session-host <absolute-config>`、`__computer-driver-worker <absolute-config>`，只在 CLI 做路由与参数数量检查。
- 创建子进程命令由 process.ts 单一函数选择 compiled realpath executable 或 Bun + absolute source CLI。Node build 的 session/exec 在spawn前明确 `unsupported_runtime`；doctor、旧act、help保持原支持。

- [ ] 写失败解析测试：

```ts
expect(() => parseRequest("observe", ["--session", "s", "--pid", "1"]))
  .toThrow(/exclusive|cannot combine/);
expect(() => parseRequest("session", ["cancel", "--session", "s"]))
  .toThrow(/request-id/);
```

增加session不存在、版本不匹配、status不访问SDK、close幂等、私有控制文件损坏的测试。
- [ ] Run `bun test tests/computer-use-session-cli.test.ts` 确认 red。
- [ ] 添加实际入口，通过createComputerUseCommands注册session。原 CLI帮助逻辑只识别两级action，所以session help描述列子命令，不重写全局CLI路由。
- [ ] act/perceive 加session可选支持：旧CLI输出保持结构，不把observe新状态字段塞入旧contract；仍用同个driver。
- [ ] socket客户端wait超时返回requestId和status命令；不输出“失败请重跑”。close报告是否已回收以及unknown请求，不隐藏cleanup失败。
- [ ] 打包测试用合成fixture运行内部boot协议，不启动桌面；测试符号链接可执行文件、陌生cwd、无Node/Bun PATH、runtime sidecar realpath、help无native加载。
- [ ] 更新文档：open→observe→batch→status→close完整示例；session空闲到期、活动请求断线和取消的区别。旧act/batch也说明目标lease范围。
- [ ] Run B所有tests、`bun run typecheck && bun run build && bun run smoke`。打包闭环留C5门禁但不能声称已验证。
- [ ] 提交 `feat: expose persistent computer-use sessions`。
