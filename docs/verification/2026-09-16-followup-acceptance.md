# 后续验收 — 2026-09-16

> 2026-09-17 续验：用户允许临时占用当前桌面后，AX 表单填写与提交已实跑通过。最新结果和边界见 [真实验收报告](2026-09-17-ax-form-native.md)。以下保留此前检查记录。

本轮由三个 `gpt-5.6-luna`、`max` 子代理分别处理输入隔离、AX 表单、权限归属。根代理复核了改动与原始结果。三项目标尚未全部通过。

| 验收项 | 当前状态 | 本轮结果 |
| --- | --- | --- |
| 鼠标、键盘不受干扰 | 部分修复，整体未通过 | 旧 fixture 默认鼠标穿透并置于后方。坐标模式要求 `--allow-pointer` 和 `YK_INPUT_TEST_DESKTOP=1`；环境门禁在创建窗口前检查。通用 background 输入仍可能使用合成事件。 |
| 完整 AX 表单 | 接口与 runner 已就绪，实跑未完成 | 既有 `Computer.setValue` 写三个字段；新 runner 从真实 AX 观察取 token、回读字段、调用产品提交路径并核对结果。当前没有启动 fixture 或执行表单输入。提交接口未暴露 route，不能证明严格 AXPress。 |
| 安装环境 | 原矩阵通过 | 源码、发布二进制、符号链接均通过安装与随包 runtime 加载检查。 |
| 持久 host 责任归属 | 本机两条启动链已验证 | 源码版和编译版的 host、driver responsible PID 均指向 Ghostty。关闭后 host/driver 已退出，socket 已删除，lease 为空。 |

持久 host 的两次观察请求均完成，但 AX channel 是 `degraded`；这不是 AX 内容读取通过。责任 PID 是本机启动链证据，不能代替 TCC 数据库记录，也不代表全新机器或撤销权限后的行为。

根代理只读检查了已知 fixture 进程名，没有匹配到遗留进程。该结果仅覆盖已知名称。没有终止用户应用，没有激活窗口，没有发送鼠标或键盘输入，也没有撤销或修改系统权限。

## AX 实跑入口

[computer-use-ax-form.ts](../../scripts/probes/computer-use-ax-form.ts) 默认输出 guard report，不启动 native SDK 或窗口。真实运行要求独立 macOS 登录会话或测试机；普通的另一个 Space 不能隔离用户输入。

```sh
bun scripts/probes/computer-use-ax-form.ts \
  --allow-native --test-desktop isolated-login-session \
  --out-dir /private/tmp/yk-ax-form-new-run
```

输出目录必须尚不存在。runner 会保存字段写入回执、AX 观察、提交结果和清理信息。即使业务提交成功，提交 route 仍记录为 `unavailable`，输入隔离仍记录为 `unverified`。不能把业务成功当作完整 AX-only 输入隔离通过。

当前尚未确认可用的独立测试桌面，因此没有执行上述 native 流程。

## 证据

- [输入隔离](2026-09-16-input-isolation.md)
- [AX 表单与 runner](2026-09-16-ax-form.md)
- [权限与安装](2026-09-16-permissions-install.md)
- [持久 host 原始证据](evidence/2026-09-16-permissions-install/persistent-session.json)

## 验证

- 类型检查通过。
- AX runner 与严格写入定向测试通过；已有输出目录的权限和内容受到保护。
- 输入隔离只读 probe 回归通过；当前 fixture 与历史证据分开报告。
- 两个 Swift fixture 的类型检查通过，AX fixture 编译通过。
- 默认免桌面全量测试：662 pass、11 skip、0 fail，2400 assertions。沙箱内曾因 socket/cache 权限失败；经批准在沙箱外复跑通过。
