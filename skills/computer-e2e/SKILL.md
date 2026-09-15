---
name: computer-e2e
description: Deterministic macOS desktop E2E via yk. Use only when the user asks for computer-e2e.
---

# Computer-E2E (via `yk`)

Deterministic desktop replay: trusted project-local test code drives real
macOS UI through the same runtime as `yk computer-use`, but NOTHING decides
steps at run time — the suite does. No npm install, no Node, no Vitest, no
SDK dependencies in the consumer project.

## Workflow: explore, distill, replay

1. **Explore with computer-use** (LLM in the loop): find stable predicates
   (role + exact text) and postconditions (what must be observable AFTER an
   action). Never settle for coordinates.
2. **Write the suite** as `*.e2e.ts` files in the project (see
   [references/api.d.ts](references/api.d.ts) and
   [examples/pure.e2e.ts](examples/pure.e2e.ts)): one default-exported Suite,
   sequential cases, `ctx.step(...)` for observable phases.
3. **Run ONLY with explicit user authorization** — each run drives real UI:
   ```sh
   yk computer-e2e run tests/smoke.e2e.ts
   yk computer-e2e run tests/smoke.e2e.ts --param app-root=/path
   ```
4. **Read the report, do not guess**: runs land in `.computer-e2e/runs/` —
   `yk computer-e2e history`, then `yk computer-e2e report <run-dir>`.
5. **On failure, diagnose with computer-use** (perceive the failing window),
   then FIX THE SUITE or the app and re-run with the user's authorization.

## Hard rules

- **No self-healing passes.** Never edit assertions to make a failing run
  green, never re-run a failed case as "verification" without the user.
- **SDK delivery success is not business success.** Every action must be
  followed by an explicit postcondition (`ctx.computer.waitFor(...)` or a
  fresh-snapshot assertion).
- **Only authorized targets.** Run suites only against apps/windows the user
  approved; a suite may spawn its own instance via project helpers.
- **Never read credentials.** Password field values are stripped from every
  output path; do not attempt to work around it.
- **Interrupted ≠ passed.** Killed/timed-out runs report `incomplete`/
  `interrupted` and an action outcome of `unknown`: re-observe, never replay
  the action blindly.
- **Test files are trusted code, not a sandbox.** They run with your
  permissions and can do anything you can — review them before running.
  Running yk in an untrusted directory also executes that directory's
  bunfig.toml preload.
- **TypeScript is transpile-only.** Type errors do not stop a run; types are
  editor support via `references/api.d.ts`.
- Suites are sequential and fail-stop: the first failure stops the file and
  later files; skips (exit code 2) are recorded, never hidden.

## Suite shape (apiVersion 1)

```ts
import assert from 'node:assert/strict';
import type { Suite } from './.agents/skills/computer-e2e/references/api.d.ts';

export default {
  apiVersion: 1,
  id: 'my-flow', name: 'My flow',
  async beforeAll(ctx) { /* boot the app via project helpers */ },
  async afterAll(ctx) { /* quit what beforeAll started */ },
  tests: [{
    id: 'create-and-send',
    name: 'creates a session and sends a message',
    timeoutMs: 440_000,
    async run(ctx) {
      await ctx.step('open composer', async () => {
        await ctx.computer.click(ctx.params.target!, (e) => e.label === 'New', 'new button');
        await ctx.computer.waitFor(ctx.params.target!, (els) => els.some((e) => e.role === 'AXTextArea'), 'composer');
      });
    },
  }],
} satisfies Suite;
```

## Commands

```sh
yk computer-e2e run <file.e2e.ts...> [--param k=v]... [--out-dir DIR] [--timeout-ms N] [--require-version V]
yk computer-e2e history [--out-dir DIR] [--limit N]
yk computer-e2e report <run-dir>
```

Exit codes: 0 all passed; 1 any failure/interruption/cleanup error; 2 skips
or not-run present; 130/143 user interrupt.
