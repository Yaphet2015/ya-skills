## Repository Shape
- This is a Bun + TypeScript monorepo.
- Root `package.json` owns workspace scripts and the public `yk` binary mapping.
- `packages/cli` owns the `yk` command-line entrypoint and command routing.
- `packages/core` owns shared catalog, dependency resolution, install, uninstall, target detection, and function-registry logic.
- `packages/functions-*` packages own independent `yk <domain> <action>` command implementations.
- `skills/` is the local skill catalog installed by `yk install`.
- `tests/` contains cross-package behavior tests.

## CLI Contract
- `yk install [skill...]` installs skills into the current working repository.
- `yk install -g [skill...]` and `yk install --global [skill...]` install skills into the user's home directory.
- Reinstalling an already installed skill overwrites that skill directory with the catalog copy.
- Install target detection applies within the selected repository or home-directory root:
  - If `.claude/skills` and `.agents/skills` both exist, install to both.
  - If only one exists, install there.
  - If neither exists, create `.agents/skills`.
- `yk uninstall <skill...>` removes requested skills from existing targets only.
- `yk uninstall -g <skill...>` and `yk uninstall --global <skill...>` remove requested skills from existing user-level targets only.
- Uninstall must not create target directories.
- Uninstall must not remove dependency skills automatically.
- Each `yk <domain>` command must live in its own `packages/functions-<domain>` package and be registered by `packages/cli`.

## Development Commands
- Install dependencies: `bun install`
- Typecheck: `bun run typecheck`
- Test: `bun run test`
- Build: `bun run build`
- Build Homebrew binary: `bun run build:binary:macos-arm64`
- Smoke test: `bun run smoke`

## Homebrew Release Contract
- Published install path is `brew tap Yaphet2015/tap && brew install ya-skills`.
- The tap repository is `Yaphet2015/homebrew-tap`.
- The release workflow publishes macOS arm64 assets named `ya-skills-v<version>-macos-arm64.tar.gz` plus `.sha256`.
- Release tarballs must contain the compiled `yk` binary and the `skills/` catalog.
- Packaged installs rely on `YA_SKILLS_CATALOG_DIR` pointing to the installed catalog; keep this env override working before changing catalog lookup.
- Keep `bun.lock` public-registry compatible for GitHub-hosted release runners.
- After a release, update the Homebrew formula version, asset URL, and sha256 in the tap.

## Editing Guidance
- Use Bun workspace package imports instead of deep relative imports across packages.
- Keep shared behavior in `packages/core`; keep CLI parsing and output in `packages/cli`.
- Do not put domain command logic in `packages/cli`.
- Update README when public CLI behavior changes.
- Prefer adding a failing test before changing behavior.
