# v1.1.1 release evidence (2026-10-22, local publish)

## 发布内容

- 发布 `ya-skills` / `yk` 版本 `1.1.1`。用户选择 patch 版本。
- Release commit：`0d6dd5da95592ccbae84facb194cdfeaf54fab36`，提交 `chore(release): bump version to 1.1.1`。
- tag `v1.1.1` 指向该 commit；发布前确认远端精确 tag 与 GitHub Release 均不存在。未覆盖已有目标。
- [GitHub Release](https://github.com/Yaphet2015/ya-skills/releases/tag/v1.1.1)，发布时间 `2026-10-22T09:17:42Z`。
- tap 提交：`fb7f0f710e19bd833eecf5693ce67b4d8627463e`，推送到 `Yaphet2015/homebrew-tap` `main`，fast-forward，无 force-push。
- tap 公式 URL、SHA-256 和 `--version` 断言已更新；没有 `version` 行。
- Homebrew 已升级到 `1.1.1`，安装目录 `/opt/homebrew/opt/ya-skills`。

发布前的仓库状态：最初位于 `refactor/ultra-cr-without-graph`，其 tree 与当时的 `origin/main` 完全相同。切换到本地 `main` 并 fast-forward 至 `5d7470daffd8d048f5e14ffd15b3a2b2a8bd7365` 后继续。最终发布前 `main` 干净，`HEAD == origin/main == 0d6dd5da95592ccbae84facb194cdfeaf54fab36`。

## 环境

- macOS `27.0`，build `26A428`，`arm64`。
- Bun `1.4.0`。
- 打包脚本先对编译后的 `dist/yk` 执行 `codesign --force --sign -`，再执行 `codesign --verify --strict`。

## SHA-256

本地归档、GitHub 上传资产 digest、独立目录下载文件的 SHA-256 相同：

```text
d6a3fbf6588aa7a4ce637e308add3f1002302f7db4355640b4bf7044639650f5  ya-skills-v1.1.1-macos-arm64.tar.gz
```

归档大小 `48,497,309` bytes。GitHub 上传归档 digest 为 `sha256:d6a3fbf6588aa7a4ce637e308add3f1002302f7db4355640b4bf7044639650f5`；`.sha256` 资产 digest 为 `sha256:de103392519fd61c46fb04af90179c598a70f8a46433eeb871299963ae95b0e0`。

## 命令与结果

| 步骤 | 命令 / 检查 | 结果 |
|---|---|---|
| typecheck | `bun run typecheck` | PASS |
| 默认测试 | `bun run test` | 789 pass / 18 skip / 0 fail；2,911 assertions；807 tests / 98 files。18 个 opt-in/native/packaged 项按默认 desktop-free lane 跳过。 |
| 发布打包 | `bun run package:release -- --version 1.1.1` | PASS；脚本签名并严格验证编译后的 `yk`。 |
| packaged lane | `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts` | 14 pass / 0 fail；81 assertions。 |
| Node build | `bun run build` | PASS。 |
| smoke | `bun run smoke` | PASS；source 与 Node 路径均报告版本 `1.1.1`。此项不代替独立二进制验证。 |
| 解包验证 | 最终归档解压到独立目录 | 根目录有 `yk`、`skills/`、`runtime/`；归档内二进制签名有效；`yk -h` exit 0、非空且含 `Usage`；`yk --version` 精确为 `1.1.1`。 |
| 本地校验和 | `shasum -a 256` 与生成的 `.sha256` 对比 | PASS；一致。 |
| GitHub Release | 推送 `v1.1.1`，上传 tar.gz 和 `.sha256` | PASS；两个资产状态均为 `uploaded`。 |
| 上传下载核对 | `gh release download` 到独立目录后重算归档 hash | PASS；下载值与本地值及 GitHub asset digest 相同。 |
| tap 更新 | `scripts/update-ya-skills-formula.py`，设置 `VERSION=1.1.1`、`TAG_NAME=v1.1.1`、`ASSET_NAME=ya-skills-v1.1.1-macos-arm64.tar.gz`、`ASSET_SHA256=d6a3fbf6588aa7a4ce637e308add3f1002302f7db4355640b4bf7044639650f5` | PASS；保留 `yk` 与 `runtime` 安装结构。 |
| Homebrew 升级 | `brew update`; `brew upgrade ya-skills` | PASS；安装 `1.1.1`。 |
| 安装验证 | 对 `$(brew --prefix ya-skills)/libexec/yk` 验签；运行 `bin/yk -h` 与 `bin/yk --version` | PASS；签名有效、帮助含 `Usage`、版本精确为 `1.1.1`。 |
| Release Please PR | `gh pr list --state open` | 空列表；无需关闭或刷新；未合并任何 PR。 |

## CI（仅记录状态，不替代本地验证）

- [release-please](https://github.com/Yaphet2015/ya-skills/actions/runs/39754076145)：completed / success。
- [release](https://github.com/Yaphet2015/ya-skills/actions/runs/39754271611)：completed / success。`Skip if the release already has the local asset` 成功；checkout、typecheck、test、package、packaged tests、build、smoke 与 publish 步骤均 skipped。发布验证由上表中的本地 gate 和归档检查完成。

## 纠正记录

初始 tag 探测命令只检查了 `git ls-remote` 的退出码，因此即使无匹配也打印了 `TAG_EXISTS`。随后用精确 ref 查询确认远端 `v1.1.1` tag 为空，并确认 `gh release view v1.1.1` 返回 `release not found`。创建前再次复查目标为空；没有覆盖任何已有 tag、Release 或资产。

## 原始数据

- `release.json`：GitHub Release 与资产摘要。
- `ci.json`：相关 workflow 的状态、步骤和链接。
- `open-prs.json`：发布完成后的 open PR 列表。

## 清理

所有发布与 tap 检查通过后，已删除本次创建的归档、`.sha256`、`dist/yk`、`dist/release/ya-skills`，以及独立解压/下载目录 `/tmp/ya-skills-release-v1.1.1-20261021.BU7pop`。没有删除其他 `dist` 内容。
