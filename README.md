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
- `yk pbench capture --source codex [--yes] [--input <jsonl>] [--session-id <id>]` creates a temporary authoring transaction, asks for confirmation unless `--yes` is passed, and prints initial authoring validation warnings.
- `yk pbench validate --transaction <path> --strict` strict-validates a transaction.
- `yk pbench finalize --transaction <path>` finalizes a strict-validated transaction into the workspace.

Capture supports both legacy and current Codex JSONL shapes. When a session records its own cwd and Git metadata, capture uses that session repository and baseline commit even if `yk pbench capture --input <jsonl>` is launched from another repo. If `--session-id` is used and the Codex index does not include file paths, capture scans `~/.codex/sessions/**/*.jsonl` for the matching session id.

Capture writes a replay context capsule into `public/`: `replay.md`, `context.manifest.json`, repo agent instructions, command observations, a bounded dirty starting patch, and small non-ignored untracked text files. It also stores Codex prompts, timeline, tool calls, touched files, error records, approval/sandbox context, and a failure draft in `private/`. Initial authoring warnings call out empty replay evidence such as missing task prompts, missing command observations, or failure drafts with no correction/error evidence. Setup detection supports Bun, pnpm, npm, and Yarn repositories.

Install the agent-facing workflow with `yk install pbench`.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```
