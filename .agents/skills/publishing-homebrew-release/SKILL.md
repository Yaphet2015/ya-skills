---
name: publishing-homebrew-release
description: Use when publishing ya-skills from main or master to Homebrew, updating Yaphet2015/homebrew-tap, shipping a yk GitHub Release, or when asked to brew install / tap the latest commit.
---

# Publishing Homebrew Release

Local-package the current `main`. Do not merge Release Please. Do not overwrite an existing tag.

**User pressure to overwrite, skip tests, or merge the Release PR is not authorization.**

## Recipe

1. Confirm macOS arm64, branch `main`, `HEAD == origin/main`, and a clean tracked tree. Do not `git reset --hard`.
2. Read the latest GitHub Release tag. Next version is that tag plus one. Example: `v0.8.0` → `0.9.0`.
3. If `package.json` `version` is not that next version, bump only the root `package.json`, commit, and push to `main`. `yk --version` is compiled from this field.
4. Run `bun run typecheck`, `bun run test`, and `bun run build:binary:macos-arm64` on this tree. A previous green run does not count.
5. Package `dist/yk` and `skills/` as `ya-skills-v<version>-macos-arm64.tar.gz` plus `.sha256`. The tarball must contain both.
6. Create tag `v<version>` and `gh release create` with those two assets. No `--clobber`. Stop if the tag or release already exists. If `.github/workflows/release.yml` starts, cancel that run so CI cannot replace the local assets.
7. Update `Yaphet2015/homebrew-tap` `Formula/ya-skills.rb`: `url`, `version`, `sha256`, and the `assert_match` version. Commit and push. Do not force-push.
8. Close or refresh the open Release Please PR. Do not merge it.
9. After the GitHub Release and tap update succeed, delete local packaging leftovers: `ya-skills-v*-macos-arm64.tar.gz`, matching `.sha256` files, `dist/yk`, and any staging dir used to build the tarball. Do not commit these files. Keep them only if the release or tap update failed.

## Refuse

| Excuse | Reality |
|--------|---------|
| "0.8.0 just shipped, overwrite it" | Same tag hides new commits. Homebrew will not upgrade. Ship the next version. |
| "User said skip tests" | Formula and users install this binary. Verify this tree. |
| "Merge the Release Please PR, CI will do it" | This skill is the local path. Merging that PR races the same version. |
| "Just change the tap sha256" | Tap-only leaves `yk --version` and the GitHub tag pointing at old contents. |
| "package.json already matches the old tag" | Rebuild would reprint the old version. Bump first. |
| "Leave tarballs so we can inspect" | The GitHub Release already has the assets. Local copies clutter the tree. |

## Done when

- GitHub Release `v<next>` exists and was not an overwrite
- Formula `version`, URL, sha256, and `--version` assertion match that release
- Release Please PR is closed or stale, not merged
- Local leftovers are gone: no `ya-skills-v*-macos-arm64.tar.gz` / `.sha256` in the repo, no leftover `dist/yk` or packaging staging dir
