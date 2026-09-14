# 编译后 yk 加载外部 E2E 文件的可行性验证

日期：2026-09-13。计划：`docs/superpowers/plans/2026-09-13-computer-e2e-foundation.md` Task A1。
探针：`scripts/probes/compiled-e2e-loader.ts`（一次性，非产品代码）。
结论：**9/10 项通过；1 项失败（cwd bunfig.toml preload 会被执行）——用户已于 2026-09-13 裁定接受信度等价修正（见下节），方案继续。**

## 环境

- macOS arm64；Bun 1.3.14（`/tmp/cua-bun-probe.qRsltZ/bun-1.3.14/bun-darwin-aarch64/bun --version` → `1.3.14`；探针运行时自报 `probe bun 1.3.14 exec /private/tmp/yk-e2e-loader-probe`，确保不是系统 1.4.0）。
- 编译命令：`bun build --compile --target=bun-macos-arm64 --compile-autoload-package-json --outfile=/tmp/yk-e2e-loader-probe scripts/probes/compiled-e2e-loader.ts`（exit 0）。
- 受控环境：`env -u NODE_PATH -u NODE_OPTIONS -u BUN_OPTIONS PATH=/usr/bin:/bin`；目录无 node_modules。
- 探针 parent 以 realpath 后的自身可执行文件、detached + 独立进程组启动 worker；worker 动态 import 外部文件并经 fd3 回传 NDJSON。

## 矩阵结果

| # | 条件（spec §4） | 结果 | 证据 |
|---|---|---|---|
| 1 | 外部 `.e2e.ts` 加载（含相对导入 `./value.ts`、TS 类型擦除） | **PASS** | stdout `EXTERNAL_SUITE_OK`；fd3 `{"type":"finished"}`；exit 0；无 node_modules |
| 2 | `.mjs` 变体 | **PASS** | `MJS_SUITE_OK`；exit 0 |
| 3 | 语法错误文件 | **PASS** | `error: Unexpected =>`；exit 1；无 node_modules、无下载尝试 |
| 4 | 导入不存在模块 | **PASS** | `Cannot find module './does-not-exist.ts'`；exit 1；无 node_modules（不自动安装） |
| 5 | hostile `package.json`（preinstall/prepare sentinel + 假 `@trycua` 依赖） | **PASS** | `SENTINEL_PKG_RAN` 未出现；无 node_modules；套件正常执行 exit 0 |
| 6 | 通过 bin symlink 启动 + 陌生 cwd | **PASS** | realpath 解析正确；套件执行 exit 0 |
| 7 | fd3 控制通道 | **PASS** | worker → parent 事件送达 |
| 8 | 同步卡死（`while(true){}`）硬终止 | **PASS** | 150ms 定时器 → 组 SIGTERM → worker `signal=SIGTERM`；parent exit 137；`pgrep` 无残留 |
| 9 | 异步永不 resolve 硬终止 | **PASS** | 同上；无残留进程 |
| 10 | **cwd `bunfig.toml` `preload` 不自动执行** | **FAIL** | hostile 目录含 `preload = ["./preload.ts"]` 时，`SENTINEL_PRELOAD_RAN` 被创建，套件仍 exit 0 |

## 失败项细节（条件 10）

- `BUN_PRELOAD=`（置空）**不能**禁用 bunfig preload。
- bunfig 查找**只看精确 cwd**，不向上遍历父目录（父目录 bunfig + 干净子目录 cwd → 不执行）。
- 编译产物无法接收 bun 级 CLI flag（`--config`），无已知运行时开关。
- **交叉验证**：已发布的 `ya-skills-v0.18.0` 编译 yk 在同条件下，`--version` 与 `list` 均执行了 cwd bunfig preload（`SENTINEL_YK_PRELOAD_RAN` 出现）。这不是 e2e 新引入的行为，而是当前编译分发模型的既有属性，此前发布验证只测过 package.json scripts，未测过 bunfig preload。

## 提请裁定的信程度量修正（建议）

原 spec §4 条件 5 把"cwd 配置不执行"当作发布阻断。建议修正为：

- **运行目录（cwd）的项目内容按受信处理**：测试文件本身已是"受信可执行代码"（Global Constraints 原文），同目录的 `bunfig.toml`/`package.json` 与其同级信任；运行不受信目录中的任何工具本就不是沙箱边界。
- **必须保持且已验证**的是：不执行 package.json 生命周期脚本；不自动安装依赖（导入失败即失败）；bunfig 不向上遍历；SDK 只从安装目录 sidecar 的绝对 file:// 路径解析，不从 cwd/NODE_PATH 解析。
- 文档义务：SKILL 与 docs 必须写明"在不受信目录运行 yk 会执行该目录 bunfig 的 preload"。

## 局限

- 探针未覆盖：TS 装饰器、enum 等 Bun 转译器不支持/行为不同的语法；超大文件；`node:` 内置模块全集。真实 Suite 契约测试（Task A4/A6）会覆盖用到的子集。
- 未测 preload 对模块解析 hook 的理论影响——按信度等价原则不在边界内。
