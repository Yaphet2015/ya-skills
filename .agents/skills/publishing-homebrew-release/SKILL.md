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
4. Run `bun run typecheck` and `bun run test` on this tree. A previous green run does not count.
5. Package with `bun run package:release -- --version <version>`. Never hand-assemble. It compiles `yk` and writes `ya-skills-v<version>-macos-arm64.tar.gz` plus `.sha256`. The tarball must contain `yk`, `skills/`, and `runtime/`.
6. The tag-triggered CI skips itself after this local publish, so this tree is the only gate. Run the packaged lane the release runner uses: `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts tests/computer-session-release.test.ts tests/computer-lane-release-packaging.test.ts`, then `bun run build` and `bun run smoke`.
7. Create tag `v<version>` and `gh release create` with those two assets. No `--clobber`. Stop if the tag or release already exists. The tag push starts `release.yml`; its guard sees the release already has the asset and the run ends green with skipped steps. Only if the guard missed (run starts building), cancel that run.
8. Update `Yaphet2015/homebrew-tap` `Formula/ya-skills.rb` with `scripts/update-ya-skills-formula.py` and env `VERSION`, `TAG_NAME`, `ASSET_NAME`, `ASSET_SHA256`. That writes `url`, `sha256`, and the `--version` assertion. Do not add `version` — `brew audit` infers it from the GitHub release URL. Commit and push. Do not force-push.
9. Close or refresh the open Release Please PR. Do not merge it.
10. After the GitHub Release and tap update succeed, delete local packaging leftovers: `ya-skills-v*-macos-arm64.tar.gz`, matching `.sha256` files, `dist/yk`, `dist/release/`, and any other staging dir used to build the tarball. Do not commit these files. Keep them only if the release or tap update failed.

## Refuse

| Excuse | Reality |
|--------|---------|
| "0.8.0 just shipped, overwrite it" | Same tag hides new commits. Homebrew will not upgrade. Ship the next version. |
| "User said skip tests" | Formula and users install this binary. Verify this tree. |
| "Merge the Release Please PR, CI will do it" | This skill is the local path. Merging that PR races the same version. |
| "Hand-assemble the tarball from dist/yk" | `package:release` is the single packaging entrypoint. A hand tarball ships no `runtime/` and breaks computer-use. |
| "Cancel the release run like before" | The workflows no longer clobber assets; the guard run ends green by itself. Cancel only a run that is actually building. |
| "Just change the tap sha256" | Tap-only leaves `yk --version` and the GitHub tag pointing at old contents. |
| "Keep version so the formula is explicit" | `brew audit` fails: `version` is redundant with the GitHub release URL. |
| "package.json already matches the old tag" | Rebuild would reprint the old version. Bump first. |
| "Leave tarballs so we can inspect" | The GitHub Release already has the assets. Local copies clutter the tree. |

## Done when

- GitHub Release `v<next>` exists and was not an overwrite
- The tag-triggered `release.yml` run skipped itself (green, not cancelled)
- Formula URL, sha256, and `--version` assertion match that release, and the formula has no `version` line
- Release Please PR is closed or stale, not merged
- Local leftovers are gone: no `ya-skills-v*-macos-arm64.tar.gz` / `.sha256` in the repo, no leftover `dist/yk`, `dist/release/`, or other packaging staging dir
