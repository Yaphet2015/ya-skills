---
name: publishing-homebrew-release
description: Use when publishing ya-skills from main or master to Homebrew, updating Yaphet2015/homebrew-tap, shipping a yk GitHub Release, or when asked to brew install / tap the latest commit.
---

# Publishing Homebrew Release

Use the local package path for the current `main`. The defaults are a new
semantic version, no tag or release overwrite, and no Release Please merge.
Honor an explicit user choice after checking the exact tag, release, asset, or
PR state. Record every exception and every omitted check; never describe an
omitted check as passed.

## Recipe

1. Confirm macOS arm64, branch `main`, `HEAD == origin/main`, and a clean
   tracked tree. Do not `git reset --hard`.
2. Read the latest GitHub Release tag and classify the changes. A fix advances
   the patch (`0.25.2` → `0.25.3`); a backward-compatible feature advances the
   minor (`0.25.2` → `0.26.0`); a breaking change advances the major. If the
   user selects a version, use that valid semver after checking that the exact
   tag, release, and intended asset state are understood. The default is to
   stop on an existing target; an explicitly requested overwrite must name the
   exact target and be recorded. `package.json` must contain the release
   version, because the compiled `yk --version` comes from that field.
3. If the root `package.json` needs the selected version, change only that
   field, commit, and push to `main`. Run `bun run typecheck` and `bun run test`
   on this tree unless the user explicitly omits one; record an omission and
   its reason.
4. Inspect the shared `package:release` script before packaging. It must sign
   the compiled `yk` before archiving and run
   `codesign --verify --strict` on that compiled file. If signing or verification
   is absent, fix the shared script, commit and push that fix, rebuild from
   scratch, and repeat the affected checks. Never patch a member of an
   already-created archive.
5. Run `bun run package:release -- --version <version>`. Never hand-assemble.
   It writes `ya-skills-v<version>-macos-arm64.tar.gz` and its `.sha256`, with
   `yk`, `skills/`, and `runtime/` at the archive root.
6. Run the packaged lane used by the release runner:
   `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts`,
   then `bun run build` and `bun run smoke`. The packaged tests exercise the
   binary under `dist/release`; `bun run smoke` covers the source/Node path and
   does not validate the standalone executable. A failed required gate stops
   later tag, upload, and tap steps; an explicit omission is recorded as
   skipped, never passed.
7. Create a fresh, run-specific extraction directory and set `archive_root` to
   its absolute path. Validate the final archive, rather than only its build
   directory. Check that `"$archive_root/yk"`, `"$archive_root/skills"`, and
   `"$archive_root/runtime"` exist; run
   `codesign --verify --strict "$archive_root/yk"`; run
   `"$archive_root/yk" -h` and require exit 0 with non-empty help containing
   `Usage`; and require
   `"$archive_root/yk" --version` to equal exactly `<version>`. Recompute the
   local SHA-256 and compare it with the generated `.sha256` before uploading.
8. Before tagging or uploading, confirm the tree is clean and `HEAD` is the
   tested release commit equal to `origin/main`; any code or script change
   invalidates its affected checks. Create tag `v<version>` and a GitHub
   Release with the two assets. Do not overwrite by default. If the user
   explicitly chose an overwrite, check the exact existing tag/release/asset
   first and record the operation. The
   tag-triggered `release.yml` guard may end green with skipped steps after a
   local publish. That is status only, not release validation; keep the local
   gates and archive checks.
9. Download the uploaded archive into a separate run-specific directory and
   compare its SHA-256 with the validated local archive before changing the
   tap. A mismatch stops the release. Update
   `Yaphet2015/homebrew-tap` `Formula/ya-skills.rb` with
   `scripts/update-ya-skills-formula.py` and env `VERSION`, `TAG_NAME`,
   `ASSET_NAME`, `ASSET_SHA256`. This writes `url`, `sha256`, and the
   `--version` assertion. Do not add `version`; Homebrew infers it from the
   GitHub release URL. Commit and push the tap change. Do not force-push.
10. Install or upgrade the formula and test the installed executable. The
    `/opt/homebrew/bin/yk` path is a wrapper, so use the formula prefix:
    `formula_prefix="$(brew --prefix ya-skills)"`,
    `codesign --verify --strict "$formula_prefix/libexec/yk"`, then run
    `"$formula_prefix/bin/yk" -h` and require exit 0 with non-empty help
    containing `Usage`; run `"$formula_prefix/bin/yk" --version`, requiring the
    exact selected version. Any signature, help, or version failure means the
    release is not complete; retain the diagnosis artifacts and do not claim
    success.
11. Close or refresh the open Release Please PR under the local-path default;
    honor an explicit user choice after checking the PR and version state. Do
    not merge it silently.

## Evidence and cleanup

Keep a durable, run-specific evidence record containing the commit SHA, tag and
release, `bun --version`, macOS version and architecture, local/uploaded/
downloaded SHA-256 values, CI URL and status, and every command with its result
or explicit skip reason. A skipped-green CI run must be recorded as skipped,
not as a substitute for validation.

After every release and tap check succeeds, remove only the exact artifacts
created by this run: its named archive and `.sha256`, `dist/yk`, the exact
`dist/release/ya-skills` tree, and its extraction/download/staging directory.
Do not glob away archives from other runs or pre-existing files. On any
failure, retain the archive, hashes, extracted files, downloads, staging
directory, and diagnosis logs.

## Done when

- The selected tag and GitHub Release exist without an unrequested overwrite.
- The shared package script signed and strictly verified the compiled binary.
- A fresh extraction passed signature, exit-0 help with `Usage`, exact
  `--version`, and `skills/`/`runtime/` checks.
- `bun run typecheck` and default `bun run test` passed, or each explicit
  omission is recorded; packaged tests, build, and smoke also passed. Smoke is
  not treated as standalone-binary validation.
- The uploaded/downloaded hash matched the validated local hash before the tap
  update.
- The formula URL, sha256, and `--version` assertion match the release and the
  formula has no `version` line.
- The Homebrew-installed executable passed signature, help, and exact version
  checks.
- Evidence is retained, and only this run's packaging leftovers were removed
  after success.
