# computer-use

Drive any macOS desktop app (native, Electron, Chromium) from the `yk` CLI
with background-first input delivery and AX perception. Installed with
`yk install computer-use`; every capability is also a plain command:

```sh
yk computer-use doctor
yk computer-use apps [--name TEXT]
yk computer-use windows --pid PID
yk computer-use perceive --pid PID [--window ID] [--shot] [--out-dir DIR]
yk computer-use act --pid PID [--window ID] ACTION   # --click-text/--click-contains [--click-role] | --type | --key | --scroll
```

The agent-facing usage guide lives in the skill itself
(`skills/computer-use/SKILL.md`); this page covers install/runtime facts.

## Requirements

- macOS arm64, macOS 13+ (driver requirement). Other platforms fail fast
  with `unsupported_platform`; no other `yk` command is affected.
- The Cua Driver SDK (0.27.0) runs inside the `yk` Bun process — there is no
  Node runtime, daemon, or separate worker to install.
- Accessibility + Screen Recording must be granted to the program that runs
  `yk` (usually your terminal app). `doctor` reports the read-only status and
  prints the exact grant steps; it never opens permission dialogs itself.

## Where evidence goes

Screenshots and failure dumps default to
`~/Library/Caches/ya-skills/computer-use/` (dir `0700`, files `0600`).
Override per-run with `--out-dir`. Nothing is written into the skill install
directory, the yk install prefix, or your project.

## Output contract

- Success: one JSON document on stdout (`apps`, `windows`,
  `{pid, windowId, title, elements, screenshot?}` for perceive/act).
- Failure: non-zero exit; post-driver failures print a JSON body with
  `error.code` / `error.message` (e.g. `degraded_snapshot`,
  `post_action_observe_failed` with `actionDelivered: true`,
  `action_refused`). Input-validation failures print plain text + usage.
- windowId values are decimal strings (they exceed `Number.MAX_SAFE_INTEGER`);
  pass them back verbatim.

## Distribution layout (Homebrew)

The release tarball ships `yk` plus `runtime/computer-use/node_modules/`
(SDK + darwin-arm64 native `.node`/`.dylib`, ~52 MiB). The compiled binary
locates that directory beside its realpath'd executable and loads the SDK at
runtime — packaged installs never depend on a source checkout, `NODE_PATH`,
or the current working directory's `package.json` (build flag
`--compile-autoload-package-json` is validated against untrusted-cwd
replacement in the packaging tests).

## Verification status

- Unit/behavior tests: `bun test` (input validation, lifecycle, deadlines,
  selection, privacy, stale-token retry, packaging).
- Real read-only checks on this machine (2026-09-13): doctor (same-process
  driver, permissions), apps, windows, perceive with screenshot, ambiguity
  refusal, degraded-snapshot refusal.
- Real click/type/key/scroll verification against a user-designated window
  is pending; see the plan's Task 7 before claiming full UI coverage.
