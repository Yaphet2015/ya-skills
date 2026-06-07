# ya-skills

Personal skill repository and CLI.

`yk` installs skills from this repository into the current project and exposes underlying functions as CLI commands.

## Commands

- `yk list` lists local catalog skills.
- `yk install [skill...]` installs selected skills into the current repository.
- `yk <domain> <action> [...args]` runs an underlying function.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```
