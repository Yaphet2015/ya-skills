# v1.1.2 release evidence (2026-10-28)

## 发布结果

- 用户明确要求补丁版本；从 `v1.1.1` 发布为 `v1.1.2`，包含新增 repro、旧技能弃用标记和文档。
- 内容提交：`647988fab25b58bffa3dadf25a081600e2490198`。
- 发布提交 / tag：`d1c3c0bcc0977d58807349cc96446410147930ed` / `v1.1.2`。
- [GitHub Release](https://github.com/Yaphet2015/ya-skills/releases/tag/v1.1.2)。两项资产均 uploaded。
- Homebrew tap 提交：`d6e7020e8743f04cac98648fcbed0eb98271a781`，已推送 main。
- 本机 Homebrew 已从 1.1.1 升级到 1.1.2；公式无显式 `version` 行。
- 创建前检查 tag 和 Release 均不存在；没有覆盖已有目标，没有 force-push。

## 环境与提交

macOS 27.0 / 26A428，arm64，Bun 1.4.0。起始 `main` 与 `origin/main` 均为 `cfca60d21e44b9a16f0e42da0c55b7db72187336`。

本地改动使用 `git add` 和 `git commit -m "feat(skills): add repro and deprecate legacy workflows"` 提交。根 package.json 仅改 version，再执行 `git commit -m "chore(release): bump version to 1.1.2"` 与 `git push origin main`，均 exit 0。上传前再次 fetch，确认工作区干净，`HEAD == origin/main == 发布提交`。tag 已 fetch 并确认指向该提交。

## 发布检查

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | PASS |
| 默认测试首轮 `bun run test` | 780 pass / 18 skip / 13 fail；13 项均因环境同时设置 NO_COLOR / FORCE_COLOR，stderr 多出警告 |
| `env -u FORCE_COLOR bun run test` | 793 pass / 18 skip / 0 fail，2989 assertions，811 tests / 99 files |
| `bun run package:release -- --version 1.1.2` | PASS；共享脚本签名并执行 codesign --verify --strict |
| `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts` | 14 pass / 0 fail，81 assertions |
| `bun run build` / `bun run smoke` | PASS；source 和 Node 路径均为 1.1.2 |
| 最终归档新目录解包 | PASS；yk / skills / runtime 完整，包含 repro；签名有效；帮助 exit 0、非空、含 Usage；版本精确为 1.1.2 |
| 本地 / 上传 / 独立下载 SHA-256 | PASS，三者相同，且匹配生成与下载的 .sha256 |
| tap 更新脚本 | PASS；VERSION、TAG_NAME、ASSET_NAME、ASSET_SHA256 指向新版本；更新 URL、hash、版本断言；无 version 行 |
| `brew update` / `brew upgrade ya-skills` | PASS |
| Homebrew 安装验证 | PASS；libexec/yk 验签；bin/yk 帮助与版本检查；catalog 含 repro |
| `brew test ya-skills` | PASS |
| Release Please | 检查 #51：自动 1.2.0 PR 只包含本次已发布内容；按本地发布流程关闭，未合并；最终 open PR 列表为空 |

18 项默认跳过来自 opt-in native / packaged 测试配置。发布必需 gate 无省略。首轮环境问题未修改产品代码；后续运行移除 FORCE_COLOR。

## SHA-256

```text
283c6b4663f3c9305a7c4d7c9133ab17b53b619c03c9fb21707f6a23adda8fb3  ya-skills-v1.1.2-macos-arm64.tar.gz
```

归档 48503445 bytes。详见 archive.json、release.json、download-check.json。

## CI 状态

- [release-please](https://github.com/Yaphet2015/ya-skills/actions/runs/40627716727)：completed / success。
- [release](https://github.com/Yaphet2015/ya-skills/actions/runs/40628079619)：completed / success；guard 发现本地上传资产，后续 checkout、typecheck、tests、package、packaged tests、build、smoke、publish 均 skipped。此绿色状态没有作为验证；发布以本地 gate 与归档检查为准。

## 记录与清理

commands.jsonl 记录发布命令、exit code。检查脚本和 release.json、ci.json、open-prs.json 等结构化记录已存入仓库。同名 .log 原始输出（移除 ANSI 颜色）保留在此本地目录，受仓库默认忽略规则保护，没有公开上传。自动审批因日志可能包含本机信息，拒绝了批量公开原始日志的附加操作；不影响版本发布和安装验证。最初沙箱内联网 / fetch 被权限限制，授权升级后成功；无自动审批拒绝。

全部发布及安装检查通过后，清理限定为本次创建的两个归档文件、dist/yk、dist/release/ya-skills，以及 `/var/folders/_6/69tcngy13_g1ljrj5s71r1dh0000gn/T/yk-release-v1.1.2-f43n7ey4` 中的 extract / download / tap 临时目录。清理结果见 cleanup.log。检查前这些构建产物均不存在。没有清理其他版本资产或其他 dist 内容。
