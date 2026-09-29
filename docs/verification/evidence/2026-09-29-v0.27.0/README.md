# v0.27.0 release evidence (2026-09-29, local publish)

## 发布内容

- 修复 yk 对 Cua Driver 的接入，支持后台目标输入与完整保留驱动结果。
- `@trycua/cua-driver` 和 macOS arm64 sidecar 更新到 `0.30.4`。

## 环境与版本

- macOS 27.0，build `26A428`，arm64。
- Bun `1.3.14`。
- 发布提交：`0a1a3aa3310aa70b2f47af05618d2c409990fb5c`；打 tag 前 `main` 干净，且 `HEAD == origin/main`。
- 功能提交：`76db8870a5fbc084f8e5ea1dfaf627a300b59559`。
- tag / release：[`v0.27.0`](https://github.com/Yaphet2015/ya-skills/releases/tag/v0.27.0)。发布前确认 `v0.27.0` tag 与 release 都不存在；没有覆盖资产。
- tap 提交：`7fc6a51fd0d742fcb76bda8608f42d7782ef9d07`，推送到 `Yaphet2015/homebrew-tap` `main`，普通 fast-forward。

## SHA-256

本地归档、GitHub 上传资产、独立目录下载文件和 GitHub asset digest 相同：

```text
d19f168dc640755195ceadbd3c2b2139698175530a75738ec0990581557ea010  ya-skills-v0.27.0-macos-arm64.tar.gz
```

归档大小为 43,630,709 bytes。发布包含 tar.gz 与 `.sha256` 两个资产。

## 命令与结果

| 步骤 | 命令 / 检查 | 结果 |
|---|---|---|
| typecheck | `/tmp/yk-cua-bun-1.3.14/bun-darwin-aarch64/bun run typecheck` | PASS |
| 默认测试 | `PATH` 指向 Bun 1.3.14 后运行 `bun run test` | 764 pass / 0 fail / 11 skip，2,749 assertions，92 files |
| 打包 | `bun run package:release --version 0.27.0` | PASS；签名后执行 `codesign --verify --strict` |
| 打包态测试 | `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts` | 13 pass / 0 fail，74 assertions |
| build | `bun run build` | PASS |
| smoke | `bun run smoke` | PASS；源码与 Node 路径 |
| 解包验证 | 新建独立目录并解包最终归档 | 根目录含 `yk`、`skills/`、`runtime/`；归档二进制签名有效；`yk -h` exit 0 且包含 `Usage`；`yk --version` 精确为 `0.27.0`；Cua Driver runtime 文件存在 |
| 本地哈希 | `shasum -a 256` 并检查生成的 `.sha256` | PASS；两者一致 |
| GitHub 发布 | 推送 `v0.27.0` tag；`gh release create` 上传 tar.gz 与 `.sha256` | PASS；[release](https://github.com/Yaphet2015/ya-skills/releases/tag/v0.27.0) |
| 下载验证 | `gh release download` 到独立目录，检查 `.sha256` 并重算归档哈希 | PASS；下载值与本地、上传 digest 一致 |
| tap 更新 | `scripts/update-ya-skills-formula.py`，设置 `VERSION`、`TAG_NAME`、`ASSET_NAME`、`ASSET_SHA256` | PASS；URL、SHA 与版本断言匹配；没有 `version` 行；保留 `yk` 和 `runtime` 安装结构 |
| formula 检查 | `brew style Formula/ya-skills.rb`；`brew audit --strict ya-skills` | PASS |
| Homebrew 升级 | `brew update`；`brew upgrade ya-skills` | PASS；安装 `0.27.0` |
| 安装验证 | 对 `$(brew --prefix ya-skills)/libexec/yk` 验签；运行 `bin/yk -h` 与 `bin/yk --version` | PASS；签名有效，帮助含 `Usage`，版本精确为 `0.27.0` |
| Release Please PR | 检查 PR #44 后关闭 | PASS；该 PR 是已发布 `0.27.0` 的重复 changelog PR；未合并；关闭后无 open PR |

默认测试里的原生桌面操作测试按项目约定跳过（需 `YK_CU_NATIVE_TESTS=1`）；本次 release gate 的打包测试不操作真实桌面。没有把桌面测试记作通过。

## CI（状态记录，不替代本地发布验证）

- [release-please](https://github.com/Yaphet2015/ya-skills/actions/runs/36543676837)：completed / success。
- [release](https://github.com/Yaphet2015/ya-skills/actions/runs/36544538199)：completed / success。`Skip if the release already has the local asset` 通过；之后的 checkout、typecheck、test、package、release tests、build、smoke 与 publish steps 均 skipped。发布检查由上面的本地 gate 完成。

## 例外与重试

- 第一次默认测试误用了系统 Bun 1.4.0，且沙箱阻止本地 socket 与缓存写入；停止该轮后使用 Bun 1.3.14 和所需本机权限重跑。
- Bun 1.3.14 的首次完整测试运行读到了先前生成的 `0.26.2` `dist/release` 二进制，只有版本断言失败。重新打包 `0.27.0` 后完整测试通过。
- Homebrew tap 在准备推送期间新增了 `0.26.2` 自动更新。第一次 push 被 non-fast-forward 拒绝；fetch 后将本地公式提交 rebase 到远端，按新 release 的 URL、哈希与断言解决冲突，再以普通 fast-forward 推送。没有 force-push。
- Homebrew style/audit 的沙箱调用无法访问配置的 API proxy；改用独立 `/private/tmp` cache/temp 并在授权网络上下文中重跑，两项均通过。
- GitHub tag workflow 因本地已上传归档而跳过 CI 打包步骤；本地 typecheck、默认测试、打包测试、build、smoke 和归档验证均已实际运行。

## 原始数据

- `release.json`：GitHub release 与资产摘要。
- `ci.json`：发布提交触发的 workflows 状态与链接。
- `open-prs.json`：关闭 PR #44 后的 open PR 列表。
