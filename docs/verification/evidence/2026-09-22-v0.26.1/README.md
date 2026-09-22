# v0.26.1 release evidence (2026-09-22, local publish)

## 发布内容
- `skills/plan-jury/SKILL.md`：Grok 模型 `xai/grok-4.6` → `xai/grok-4.7`（Roster 表 + 启动命令，两处）。

## 环境
- macOS 27.0, arm64 (Darwin)
- bun 1.4.0
- 发布提交：`70ddfbd07f5394d3f37d9702e5375044e0b7abb1`（`HEAD == origin/main`，打 tag 前树干净）
- tag / release：`v0.26.1` → https://github.com/Yaphet2015/ya-skills/releases/tag/v0.26.1
- 版本分类：patch（catalog 内文档/配置修复），默认不覆盖任何已有 tag / release / 资产。

## SHA-256（local = uploaded = downloaded = GitHub asset digest）
```
61fdda17cabc56424316219f9ddb6a4a2fcc7d1259e5d6ba04fd5e9323eaaebe  ya-skills-v0.26.1-macos-arm64.tar.gz
```

## 命令与结果
| 步骤 | 命令 | 结果 |
|---|---|---|
| typecheck | `bun run typecheck` | PASS |
| 默认测试 | `bun run test` | 744 pass / 0 fail / 17 skip（桌面封闭回路，按约定由下一条覆盖） |
| 打包 | `bun run package:release -- --version 0.26.1` | PASS；脚本含 `codesign --force --sign -` + `codesign --verify --strict`（scripts/package-release.ts:64-65） |
| 打包态测试 | `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts` | 13 pass / 0 fail |
| build | `bun run build` | PASS |
| smoke | `bun run smoke` | PASS（源码/Node 路径，不代表独立二进制验证） |
| 解包验证 | 新目录解包归档 | `yk`/`skills/`/`runtime/` 存在；`codesign --verify --strict` PASS；`yk -h` exit 0 且含 `Usage`；`yk --version` == `0.26.1`；包内 plan-jury 已含 `grok-4.7` |
| 本地哈希 | `shasum -a 256` 对比生成 `.sha256` | 一致 |
| tag/release | `git tag v0.26.1` + `gh release create`（带两个资产） | PASS，无覆盖 |
| 下载验证 | `gh release download` 到独立目录后重算哈希 | 与本地一致 |
| tap 更新 | `scripts/update-ya-skills-formula.py`（VERSION/TAG_NAME/ASSET_NAME/ASSET_SHA256） | url、sha256、`--version` 断言更新；无 `version` 行；install 形状校验通过 |
| tap 推送 | commit `c82cdfd` → `Yaphet2015/homebrew-tap` main | PASS，未 force-push |
| brew 安装 | `brew upgrade ya-skills` | 0.26.0 → 0.26.1 |
| 安装验证 | `codesign --verify --strict libexec/yk`；`bin/yk -h`；`bin/yk --version` | 签名 PASS；help exit 0 含 `Usage`；版本精确 `0.26.1`；安装目录 plan-jury 含 `grok-4.7` |
| Release Please PR | `gh pr list --state open` | 无 open PR，无需关闭/刷新 |

## CI（仅状态记录，不作为发布验证）
- release：completed / success → https://github.com/Yaphet2015/ya-skills/actions/runs/35680286402（本地发布后 guard 路径可能绿但跳步，已按 skipped 语义记录）
- release-please：completed / success → https://github.com/Yaphet2015/ya-skills/actions/runs/35680152773

## 例外与偏差（无省略检查）
- 无省略检查；所有必需门均实际执行。
- SSH 22 与 git-over-HTTPS 直连失败（网络重置 / SSL_ERROR_SYSCALL）；tap 改用 `gh repo clone`（HTTPS + gh 凭据），功能等价。
- tap 提交 `c82cdfd` 使用了 git 自动生成的作者身份（`Phaethon <phaethon@PhaethondeMac-mini.local>`）；已推送，不做 amend/force-push。
- 本次解包目录 `/tmp/ya-skills-v0.26.1-extract.BMMfsF`、下载目录 `/tmp/ya-skills-v0.26.1-download.t0u22T`、归档与 `.sha256`、`dist/yk`、`dist/release/ya-skills` 已在成功后清理（仅本次产物）。

## 原始数据
- `release.json` — GitHub Release 资产与 digest
- `ci.json` — 顶部两条 workflow run 状态
- `open-prs.json` — 空（无 open PR）
