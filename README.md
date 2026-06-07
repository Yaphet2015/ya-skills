# ya-skills

Personal skill repository and CLI.

`yk` installs skills from this repository into the current project and exposes underlying functions as CLI commands.

This is a Bun workspace monorepo:

- `packages/cli` owns the `yk` binary.
- `packages/core` owns shared catalog, install, uninstall, target, dependency, and function-registry logic.
- `packages/functions-demo` owns the independent `yk demo <action>` command package.
- `packages/functions-pbench` owns the independent `yk pbench <action>` command package.

## Commands

- `yk list` lists local catalog skills.
- `yk install [skill...]` installs selected skills into the current repository.
- `yk uninstall <skill...>` removes selected skills from existing skill targets in the current repository.
- `yk <domain> <action> [...args]` runs an underlying function.

`yk install` writes to the current working repository. If `.claude/skills` and `.agents/skills` both exist, it installs to both. If one exists, it installs there. If neither exists, it creates `.agents/skills`.

`yk uninstall` removes from existing `.claude/skills` and `.agents/skills` targets only; it does not create default target directories and does not remove dependency skills automatically.

### PBench

`yk pbench` captures task/session-level outcome mismatch from Codex work into local private personal benchmark cases. It is a case-authoring workflow, not a benchmark runner.

- `yk pbench workspace-init <path>` initializes a local pbench workspace.
- `yk pbench project-link --workspace <path>` links the current project to a workspace.
- `yk pbench capture --source codex [--yes] [--input <jsonl>] [--session-id <id>]` creates a temporary authoring transaction.
- `yk pbench validate --transaction <path> --strict` strict-validates a transaction.
- `yk pbench finalize --transaction <path>` finalizes a strict-validated transaction into the workspace.

Install the agent-facing workflow with `yk install pbench`.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```
