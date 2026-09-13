# 通用 computer-use 接入 ya-skills

状态：最终计划的设计依据；尚未实施。日期：2026-09-13。

## 1. 目标与已确认决策

安装 ya-skills 后，Agent 可通过 `yk computer-use` 操作任意目标桌面应用。不克隆 cowork-e2e，不依赖开发者路径、Cowork 源码或 dev 实例。

- 复用 yk 内置 Bun；Cua Driver 在同一进程内运行。
- 不增加 Node 安装依赖、Node worker、常驻 daemon 或另一套 CLI。
- 首版沿用现有发布平台 macOS arm64；驱动要求 macOS 13+。
- 固定 Bun 1.3.14、`@trycua/cua-driver` / darwin-arm64 包 0.27.0；对应 UniFFI 包为 0.31.0-3。
- 使用现有 function package、catalog、Homebrew 和两个发布 workflow。
- 本次新增的 ya-skills 实现是新发布入口的唯一实现；不在 Skill 中另放一份操作脚本。旧 cowork-e2e 的替换/移除不在本次修改范围内，不声称已完成跨仓库迁移。
- 本次计划不授权发布、推送、修改已安装 Skill，或运行 Cowork E2E。

## 2. 证据与证据边界

2026-09-13 在本机 macOS 26.5.2 arm64 实测：

| 运行形式 | Bun 1.3.14 | Bun 1.4.0 |
| --- | --- | --- |
| 源码运行 SDK | metadata、listApps、listWindows、清理均退出 0 | 同左 |
| 直接将全部 JS 编译进单文件 | 编译成功，运行时平台包解析失败 | 同左 |
| 原样配套文件 + executable-relative import + `--compile-autoload-package-json` | 上述异步调用与清理均退出 0 | 同左 |

成功运行的 native metadata PID 等于 Bun PID，embedded=true；原生库实际加载在该进程内。父会话另行重跑了 1.3.14 编译产物，退出 0。这支持“无须外部 Node”，不等于全部 UI 动作或正式分发已验证。

原始临时证据：`/tmp/cua-driver-bun-compatibility-report.md`；命令、源码与日志：`/tmp/cua-bun-probe.qRsltZ/`。这些是本机历史证据，不是安装或构建输入；实现必须从锁定依赖重新构建。临时文件消失不影响产品。

尚未验证：动作、截图、AX、权限迁移、正式 tarball/Homebrew、陌生 cwd 的 package.json 自动加载影响、最低系统版本和长期稳定性。

## 3. 对外命令与行为

```sh
yk install computer-use
yk computer-use --help
yk computer-use doctor
yk computer-use apps [--name TEXT]
yk computer-use windows --pid PID
yk computer-use perceive --pid PID [--window WINDOW_ID] [--shot] [--out-dir DIR]
yk computer-use act --pid PID [--window WINDOW_ID] [--shot] [--out-dir DIR] ACTION
```

ACTION 恰好一个：`--click-text TEXT [--click-role ROLE]`、`--click-contains TEXT [--click-role ROLE]`、`--type TEXT`、`--key KEY`、`--scroll up|down|left|right --amount N --x X --y Y`。

- `perceive` / `act` 保留显式 `--activate`，仅在用户明确要求前台操作时由 Agent 使用。不自动激活或以前台投递重试。
- 缺失/未知参数、多个 action、非法 PID/window/数值先拒绝，不创建驱动。
- PID 为正安全整数，windowId 按十进制 bigint 处理，不经 Number；amount 为正整数，坐标有限且可为负。
- 多个候选窗口必须指定 `--window`，不沿用旧脚本“选第一个有标题窗口”的行为。
- 每次 act 新取 snapshot 并唯一匹配元素；只对“明确未投递”的 stale token 拒绝重试一次。其他动作错误、动作后观察失败均不重放动作。
- 点击成功后的观察不等于业务成功；type/key/scroll 的 ToolResult.isError 必须检查，不能把结果忽略后宣称成功。
- 输出保留必要的 role、label、value、frame、enabled 信息与完整窗口身份；不把可交互控件的 label/value 无标记截断。密码字段不输出值。
- 成功 stdout 一条 JSON；诊断写 stderr。失败遵循现有 yk 非零退出码 1，并用 JSON 错误消息提供 code/message 和恢复建议。帮助保留现有文本格式。
- 动作已投递但观察失败必须明确标记 `actionDelivered: true`，指示下一步仅 perceive，不再次 act。
- 原生调用不能无限挂起：命令总时限 30 秒，另给清理最多 5 秒。超时只终止本次 CLI，不结束目标应用；若动作是否投递不明，报告 `actionOutcome: "unknown"`，禁止自动重试。
- 截图/故障证据默认写用户缓存目录 `~/Library/Caches/ya-skills/computer-use/` 下的唯一文件，支持 `--out-dir`。不写安装目录、源码仓库或默默污染当前项目；权限默认仅用户可访问，不自动导出/上传。
- `doctor` 只检查支持平台、版本、运行文件、驱动加载和只读权限状态；区分未知/未授权/损坏。不弹权限对话框、不打开设置、不检查 Cowork。缺权限时列出应授权的实际程序路径和恢复步骤；只读发现成功不能替代完整权限检查。
- 不支持的平台对 computer-use 清楚拒绝；不能导致 `yk list/install/--help` 等其他功能导入原生包失败。

## 4. 模块与分发

```text
skills/computer-use/{SKILL.md,skill.json}  # 只含使用指南与目录元数据
packages/functions-computer-use/         # 命令、输入验证、驱动生命周期、观察/动作
packages/cli/                            # 仅注册与通用 CLI 帮助路由

release/
  yk                                    # 编译后内置 Bun
  skills/                               # 现有 Skill catalog
  runtime/computer-use/node_modules/     # 原样 SDK / 原生包 / 必需传递依赖
```

- SDK 由新 function package 声明为运行依赖，平台专用包使用 optionalDependencies，不能让其他平台的纯测试或无关命令在安装阶段失败。通过公共 registry 和 bun.lock 获取，不复制本机 node_modules 作为正式构建方式；macOS 发布阶段必须确认原生包确实存在，不能把 optional 当成可缺失。
- SDK 懒加载：无关命令、安装、帮助、非法输入不初始化 native。
- 开发执行按正常 package resolution；编译执行只根据真实 executable 路径查找配套文件，不从 cwd、邻接开发仓库、全局 node_modules 或 NODE_PATH 恢复。
- 构建显式区分 compiled 模式，不凭文件名 `yk` 猜测。对 SDK 做 runtime filesystem import，防止打入 bunfs 后丢失平台包定位。
- Homebrew 把真正的 yk 和 runtime/ 一起放到 libexec；现有 bin wrapper 与 `YA_SKILLS_CATALOG_DIR` 保留。以 realpath 处理 bin/opt/Cellar 符号链接。
- 使用已经验证的 `--compile-autoload-package-json`，但将它对 cwd/package metadata 的影响列为发布阻断验证；不得为“通过”自动执行用户项目的脚本或安装包。
- 配套文件在构建/发布阶段交付；运行时不 npm install、不下载、不改 SDK。保留版本、package.json、原生文件、必要许可证和 notices。
- 两个 workflow 复用同一打包脚本，不能只更新一个发布分支。
- 不强求真正单文件；不引入资源自动解压缓存、下载更新器、可插拔后端或多平台适配层。

## 5. 安全与验收

Skill 用“发现 → 观察 → 单步动作 → 再观察”的短循环；一应用/窗口串行操作。删除、发送、提交等不可逆动作须用户明确授权。不读取凭据，不绕过后台限制，不自行启动 Cowork 测试。

验收分开计数：

1. 纯测试：参数、歧义、结果错误、重试边界、生命周期、隐私、输出和安装行为。
2. 发布包测试：从锁定依赖生成 tarball；解包到陌生目录；清空开发解析环境；从空目录及带无关/恶意 package.json 的目录运行；无 node 可执行文件仍可使用编译 computer-use；无 GUI 权限的 runner 不要求成功读取桌面。
3. 本机 native 只读验收：使用解包后的 1.3.14 发布产物，不使用源码入口，记录同进程 native metadata 和退出。
4. 用户同意的非敏感测试窗口验收：AX、截图、点击、输入、按键、滚动、动作后观察及后台不抢焦点。默认 CI 不操作真实桌面。无法执行的用例列为未验证，不计通过。
5. 正式 Homebrew 安装布局、权限提示、现有命令与 catalog 覆盖验证。实际发布和修改 tap 仍需独立授权。

只有第 1/2 项通过不能宣称“所有桌面操作已可用”；未完成 UI/安装验收时，报告范围和阻断，不以 mock 替代真实证据。
