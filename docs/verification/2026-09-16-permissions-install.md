# 权限与安装环境 — 2026-09-16

本轮运行 `doctor`、`apps --name Finder`、读取 Finder 窗口，以及两条真实持久 session host 路径的只读验收。没有发送桌面输入或激活窗口。窗口发现和观察使用产品现有的 AX 准备路径。

| 路径 | doctor | 应用枚举 | skill 安装 |
| --- | --- | --- | --- |
| Bun 1.3.14 + 源码入口 | AX、录屏权限均为 true | exit 0 | 成功 |
| 发布二进制 | AX、录屏权限均为 true | exit 0 | 成功 |
| 发布二进制的符号链接 | AX、录屏权限均为 true | exit 0 | 成功 |

持久 host 验收（源码入口和发布二进制）均通过：host 启动后由 lease 记录一个自有 driver worker，diagnostics 报告 `driverInitCount: 1`，通过 host 执行一次 `observe --mode ax`，再执行 close。报告把 `ownershipStatus: "passed_current_session"` 和 `lifecycleStatus: "passed"` 单独记录；这两个字段通过的是本次 host/worker 的责任归属和关闭清理。两次观察请求都完成；Finder 当前目标窗口的 AX channel 为 `degraded`、image channel 为 `unavailable`，这表示窗口数据不可用，不表示 AX 读取成功，也不表示 host 权限检查失败。

两条启动链的 host 和 driver worker 都由本 probe 的 lease 明确归属。每个 host/worker 都通过指定 PID 的 `ps`、libSystem responsible-PID 查询和 `codesign -dv --verbose=4` 记录身份：responsible PID 为 4610，comm 为 `/Applications/Ghostty.app/Contents/MacOS/ghostty`。源码 host/worker 使用签名的 Bun（Identifier `bun`、TeamIdentifier `7FRXF46ZSN`）；发布 host/worker 使用发布 `yk`（ad hoc、TeamIdentifier 未设置）。没有扫描无关进程的 argv 或环境。

close 的两个回执都为 `state: "closed"`、`driverTerminated: true`、`leaseReleased: true`、`unresolvedRequests: []`。随后按已记录 PID 验证 host 和 worker 已退出，session socket 不存在，目标 lease 查询为空；closed metadata 作为发现缓存保留。原始 host/worker、责任链、签名和清理证据见 [persistent-session.json](evidence/2026-09-16-permissions-install/persistent-session.json)。

发布二进制和符号链接在临时目录运行，`PATH=/usr/bin:/bin`，Node/Bun 相关加载选项已清空。该目录含假 SDK 依赖和写入 sentinel 的项目安装脚本。sentinel 没有生成。dyld 日志显示两条路径都从发布目录的 `runtime/computer-use/node_modules` 加载 SDK native 文件。这个结果证明本轮使用了随包 native runtime；没有追踪每一次文件系统查询。

doctor 在当前进程内创建 driver。libSystem 的 responsible PID 查询在本次启动链中指向 Ghostty；持久 host 和 driver worker 的同一查询也指向 Ghostty。该查询是本机诊断证据，不能代替 TCC 数据库授权记录，也不能证明其他终端、撤销后的权限状态或全新机器具有相同权限。本轮没有撤销或重新申请系统权限。

原始证据：

- [环境、文件和签名](evidence/2026-09-16-permissions-install/environment.json)
- [只读命令和 native 加载日志](evidence/2026-09-16-permissions-install/native-readonly.json)
- [持久 host/driver 归属、只读 observe 和关闭清理](evidence/2026-09-16-permissions-install/persistent-session.json)
- [安装矩阵](evidence/2026-09-16-permissions-install/install-matrix.json)
- [结果汇总](evidence/2026-09-16-permissions-install/status.json)

复核脚本是 [permissions-install.ts](../../scripts/probes/permissions-install.ts)。它只对 probe 自己启动的 host/worker 读取 PID 和签名，并在 AX observe 后关闭 session；输入策略字段固定为空。安装测试通过：`YK_PERMISSIONS_INSTALL=1 bun test tests/permissions-install.test.ts`，1 pass、16 assertions。持久 host 的临时源码 root 在清理验证通过后删除；发布入口使用产品默认 session cache，仅保留本次 UUID 的 closed metadata。
