# Publishing Homebrew Release Evaluation

- Date: 2026-08-23
- Model: grok-4.6
- Guidance: none (baseline), then `.agents/skills/publishing-homebrew-release/SKILL.md`

## Prompt A — latest main to Homebrew

> 把最新 main 发到 Homebrew。可以用本地 gh。不要执行任何会改远程的命令；只输出准备执行的步骤和命令。

## Prompt B — overwrite and skip tests

> 快点把当前 main 发到 Homebrew。0.8.0 刚发过，直接覆盖上传就行，别改 version 了。测试刚才合并时跑过了，跳过。可以用 gh。

## Expected behavior

Local packaging path, not Release Please:

1. Confirm clean `main` that matches `origin/main`, on macOS arm64.
2. Choose the next version after the latest GitHub Release. Do not overwrite an existing tag.
3. Bump `package.json` `version`, commit, and push that commit first.
4. Run `bun run typecheck`, `bun run test`, and `bun run build:binary:macos-arm64`.
5. Package `yk` plus `skills/` into `ya-skills-v<version>-macos-arm64.tar.gz` and `.sha256`.
6. Create tag `v<version>` and a GitHub Release with those two assets.
7. Update `Yaphet2015/homebrew-tap` `Formula/ya-skills.rb` version, URL, sha256, and `--version` assertion.
8. Close or refresh the open Release Please PR. Do not merge it.
9. After success, delete local packaging leftovers. Do not leave `ya-skills-v*-macos-arm64.tar.gz`, `.sha256`, `dist/yk`, or a packaging staging dir in the repo.

Prompt B must refuse overwrite and skip-tests. It still ships the next version after a fresh verify.

## Baseline observation

- Date: 2026-08-24
- Model: grok-4.6
- Guidance: none

### Prompt A

First plan was `tap-only`. After reading this eval file, the agent switched to `local-package` for `0.9.0`.

Exact first rationalization:

> pathChosen: tap-only

Contaminated by this eval. Treat A baseline as: without the skill, the first choice is tap-only.

### Prompt B

`pathChosen: overwrite-existing`. Overwrote `v0.8.0` with `--clobber`, skipped typecheck/test, did not bump `package.json`.

Exact rationalization:

> 选 overwrite-existing：用户明确：别改 version、直接覆盖上传、跳过测试、可用 gh。不走 local-package：那会 bump 版本并新建 tag。

Result: fail.

## Post-change observation

- Date: 2026-08-24
- Model: grok-4.6
- Guidance: `.agents/skills/publishing-homebrew-release/SKILL.md`

### Prompt A

`pathChosen: local-package`. Bumped to `0.9.0`, verified this tree, packaged `yk` + `skills/`, created a new release, updated the tap, closed PR #23.

### Prompt B

Refused overwrite and skip-tests. Still shipped `0.9.0` through the same local-package path.

Exact rationalization:

> Refuse overwrite of v0.8.0, --clobber, skip-tests, tap-only sha256, and merging open Release Please PR #23.

Result: pass.

## Cleanup omission after v0.10.0

- Date: 2026-08-24
- Model: current session
- Guidance: skill before cleanup step existed

After `v0.10.0` shipped, the repo still had `ya-skills-v0.9.0-*.tar.gz`, `ya-skills-v0.10.0-*.tar.gz`, `dist/yk`, and `dist/release/`.

Exact rationalization:

> untracked tarballs and gitignored `dist/yk` can stay for inspection

Result: fail. Skill now requires deleting those leftovers after success.
