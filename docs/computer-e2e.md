# Computer-E2E (yk computer-e2e)

Deterministic desktop replay: `*.e2e.ts` suite files in the CONSUMER project,
executed by the installed `yk` — no npm install, no Node, no Vitest, no SDK
dependencies. One runner (the same compiled yk as `yk computer-use`) spawns
one worker per file, and the suite code decides every step at run time; no
LLM is involved in replay.

## Commands

```sh
yk install computer-e2e            # also installs computer-use (dependency)

yk computer-e2e run <file.e2e.ts...> [--param k=v]... \
  [--out-dir DIR] [--timeout-ms N] [--require-version V]
yk computer-e2e history [--out-dir DIR] [--limit N]
yk computer-e2e report <run-dir>
```

- `run` executes exactly the listed files, in order, sequentially. The first
  failure stops the file and later files. Exit 0 = all passed; 1 = any
  failure/interruption/cleanup error; 2 = skips or not-run present; 130/143
  = user interrupt.
- `--param` values reach suites via `ctx.params`; values are NOT recorded in
  reports — do not pass secrets.
- `--require-version V` refuses to start unless the running yk reports
  exactly `V`.
- Runs record into `.computer-e2e/runs/<id>/` (override `--out-dir`):
  `events.jsonl` (source of truth), `run.json`, `report.md`, worker logs,
  `artifacts/`. Directories 0700, files 0600. History reads never mutate.
- Live suite results and persisted reports share the case/step event reduction
  rules. The supervisor owns the persisted event stream and verifies worker-group
  cleanup before draining the remaining fd3 events and publishing the report.

## Suite contract (apiVersion 1)

See the installed `references/api.d.ts` (generated from source; regenerate
with `bun scripts/generate-computer-e2e-api.ts`) and `examples/pure.e2e.ts`.
Shape: one default-exported `Suite` — `beforeAll`/`afterAll`, sequential
`tests: [{ id, name, timeoutMs?, skip?, run(ctx) }]`. `ctx` provides
`computer` (apps/windows/snapshot/click/type/key/scroll/waitFor), `signal`,
`params`, `artifactsDir`, `step`, `skip`, `setApplication`, `capture`.

TypeScript is transpile-only: type errors never stop a run. Relative imports
and `node:` builtins work; the file's own directory needs no node_modules.

## Verification status

- Unit/contract: suite validation, sequential fail-stop execution, budgets,
  per-case abort, event reduction, corruption refusal, supervisor kills
  (sync `while(true)` loops, async hangs, same-group grandchildren, and
  signal-driven stops of the running worker) — covered by the default
  `bun test` suite with fake backends and real child processes, desktop-free.
- If the parent yk is SIGKILLed, a worker config file (containing `params`)
  can remain inside the run directory (0700); delete stale run dirs you do
  not trust.
- Packaged loop: install → run (external TS, relative imports) → history →
  report through the compiled yk under `PATH=/usr/bin:/bin` — covered by
  `YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts` on
  release runners.
- Real desktop actions (click/type/key/scroll against a real app window)
  and a real Homebrew install: NOT yet verified — requires explicit user
  authorization (foundation plan Task A7).
- Trust model: the run directory is the user's project. Its `package.json`
  lifecycle scripts never run and deps never auto-install, but its
  `bunfig.toml` preload (cwd-exact, no parent walk-up) does execute — same
  trust tier as the suite files themselves. Do not run yk casually inside
  untrusted directories.
