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
- Install target detection:
  - If `.claude/skills` and `.agents/skills` both exist, install to both.
  - If only one exists, install there.
  - If neither exists, create `.agents/skills`.
- `yk uninstall <skill...>` removes requested skills from existing targets only.
- Uninstall must not create target directories.
- Uninstall must not remove dependency skills automatically.
- Each `yk <domain>` command must live in its own `packages/functions-<domain>` package and be registered by `packages/cli`.

## Development Commands
- Install dependencies: `bun install`
- Typecheck: `bun run typecheck`
- Test: `bun run test`
- Build: `bun run build`
- Smoke test: `bun run smoke`

## Editing Guidance
- Use Bun workspace package imports instead of deep relative imports across packages.
- Keep shared behavior in `packages/core`; keep CLI parsing and output in `packages/cli`.
- Do not put domain command logic in `packages/cli`.
- Update README when public CLI behavior changes.
- Prefer adding a failing test before changing behavior.
