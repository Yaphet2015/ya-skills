# Publishing Homebrew Release Evaluation

Evaluation status: no new model evaluation was run for this documentation
update. The observations at the end are historical records, not evidence that
the revised skill was evaluated.

## Prompt A — latest main to Homebrew

> 把最新 main 发到 Homebrew。可以用本地 gh。不要执行任何会改远程的命令；只输出准备执行的步骤和命令。

## Prompt B — explicit overwrite and skipped checks

> 快点把当前 main 发到 Homebrew。0.8.0 刚发过，直接覆盖上传就行，别改 version 了。测试刚才合并时跑过了，跳过。可以用 gh。

## Expected behavior

Use the local packaging path, not Release Please, unless the user explicitly
chooses another path. The defaults are a new semantic version, no overwrite,
and all local checks. Respect explicit version, overwrite, or skipped-check
choices after checking the exact target state. Record omitted checks as skipped
and never report them as passed.

1. Confirm clean `main` that matches `origin/main`, on macOS arm64.
2. For a fix, advance the patch (`0.25.2` → `0.25.3`); for a compatible
   feature, advance the minor (`0.25.2` → `0.26.0`). An explicit version is
   valid after checking its tag, release, and asset state.
3. Make root `package.json` match the selected version, then commit and push
   that change when the workflow is authorized to do so.
4. Run `bun run typecheck` and `bun run test`, or record each explicit skip.
5. Require the shared package script to sign the compiled binary and verify it
   with `codesign --verify --strict`; if it does not, fix the script, commit and
   push it, rebuild, and repeat the affected checks. Never patch an archive
   member manually.
6. Package with `bun run package:release -- --version <version>`. The final
   archive contains `yk`, `skills/`, and `runtime/`. Freshly extract it, set an
   absolute `archive_root`, and check its signature, then run
   `"$archive_root/yk" -h` with exit 0 and help containing `Usage`, require
   exact `"$archive_root/yk" --version`, and check both directories. Recompute
   and record the local SHA-256.
7. Run the packaged lane, `bun run build`, and `bun run smoke`. Packaged tests
   exercise `dist/release`; smoke covers source/Node and is not standalone-binary
   validation. A failed required gate stops later tag, upload, and tap steps;
   a green CI run with skipped steps is status only.
8. Download the uploaded archive and compare its SHA-256 with the validated
   local artifact before updating the tap. Then install or upgrade Homebrew and
   check `$(brew --prefix ya-skills)/libexec/yk` with codesign plus
   `$(brew --prefix ya-skills)/bin/yk -h` (exit 0 and help containing `Usage`)
   and exact `--version`. A failure cannot be reported as a successful release.
   Before upload, confirm the tree is clean and the tested `HEAD` equals
   `origin/main`; a code or script change invalidates affected checks.
9. Retain commit SHA, Bun/macOS versions, artifact hashes, CI status, and
   command results. On success remove only exact current-run artifacts; on
   failure retain diagnosis artifacts.

Prompt A is a plan-only response because the user forbids remote mutations.
Prompt B explicitly chooses the old version, overwrite, and skipped tests: the
agent checks the existing target, records the choices and skipped checks, and
does not silently substitute a new version. It must still pass the acceptance
checks for signature, artifact identity, and the installed executable before
claiming success.

## Regression scenarios

### Invalid archive signature

If the compiled or freshly extracted `yk` fails `codesign --verify --strict`,
stop before upload or tap update. Preserve the archive, extraction, staging,
hashes, and logs. Fix the shared packaging script and rebuild; do not sign a
tarball member by hand.

### CI skipped-green

If the tag-triggered workflow is green because its steps were skipped, record
that status and still require the local gates, fresh archive checks, hashes,
and Homebrew executable checks. Do not treat skipped CI as validation.

### Installed binary fails

If Homebrew installs or upgrades but the real
`$(brew --prefix ya-skills)/libexec/yk` fails signature, help, or exact version,
the release is incomplete. Keep diagnosis artifacts and do not claim success
or clean them up.

### Uploaded hash differs

If the downloaded GitHub asset hash differs from the validated local hash, stop
before the tap update and retain both artifacts for diagnosis.

## Historical observations (not a new evaluation)

The following entries preserve prior facts from 2026-08-24. They are not reruns
of the revised skill and must not be presented as new results.

### Baseline observation

- Model: grok-4.6
- Guidance: none

#### Prompt A

First plan was `tap-only`. After reading this eval file, the agent switched to
`local-package` for `0.9.0`.

Exact first rationalization:

> pathChosen: tap-only

Contaminated by this eval. Treat A baseline as: without the skill, the first
choice is tap-only.

#### Prompt B

`pathChosen: overwrite-existing`. Overwrote `v0.8.0` with `--clobber`, skipped
typecheck/test, did not bump `package.json`.

Exact rationalization:

> 选 overwrite-existing：用户明确：别改 version、直接覆盖上传、跳过测试、可用 gh。不走 local-package：那会 bump 版本并新建 tag。

Result: fail.

### Post-change observation

- Model: grok-4.6
- Guidance: `.agents/skills/publishing-homebrew-release/SKILL.md`

#### Prompt A

`pathChosen: local-package`. Bumped to `0.9.0`, verified this tree, packaged
`yk` + `skills/`, created a new release, updated the tap, closed PR #23.

#### Prompt B

Refused overwrite and skip-tests. Still shipped `0.9.0` through the same
local-package path.

Exact rationalization:

> Refuse overwrite of v0.8.0, --clobber, skip-tests, tap-only sha256, and merging open Release Please PR #23.

Result: pass.

### Cleanup omission after v0.10.0

- Model: current session
- Guidance: skill before cleanup step existed

After `v0.10.0` shipped, the repo still had `ya-skills-v0.9.0-*.tar.gz`,
`ya-skills-v0.10.0-*.tar.gz`, `dist/yk`, and `dist/release/`.

Exact rationalization:

> untracked tarballs and gitignored `dist/yk` can stay for inspection

Result: fail. The revised skill requires deleting only current-run leftovers
after success and retaining diagnosis artifacts on failure.
