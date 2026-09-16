# computer-use

Drive any macOS desktop app (native, Electron, Chromium) from the `yk` CLI
with background-first input delivery and AX perception. Installed with
`yk install computer-use`; every capability is also a plain command:

```sh
yk computer-use doctor
yk computer-use apps [--name TEXT]
yk computer-use windows --pid PID
yk computer-use perceive --pid PID [--window ID] [--shot] [--out-dir DIR]
yk computer-use observe --pid PID [--window ID] [--mode auto|ax|image|both] \
    [--max-dimension N] [--select-text T [--select-match exact|contains] [--select-role R]]
yk computer-use act --pid PID [--window ID] ACTION   # --click-text/--click-contains [--click-role] | --click-x/--click-y --observation ID | --set-value VALUE --element-token TOKEN | --type | --key | --scroll
yk computer-use batch --pid PID [--window ID] --file steps.json --request-id ID
yk computer-use session open --pid PID [--window ID] [--idle-timeout-ms N (<=120000)]
yk computer-use session status --session ID
yk computer-use session cancel --session ID --request-id REQUEST
yk computer-use session close --session ID
yk computer-use observe|batch|act --session ID ...   # reuse the session's driver
yk computer-use exec --session ID --file flow.js --request-id ID [--timeout-ms N] [--max-actions N]
# common flags for perceive/act: --shot, --out-dir DIR, --activate (explicit user request only)
```

The agent-facing usage guide lives in the skill itself
(`skills/computer-use/SKILL.md`); this page covers install/runtime facts.

## Requirements

- macOS arm64, macOS 13+ (driver requirement). Other platforms fail fast
  with `unsupported_platform`; no other `yk` command is affected.
- The Cua Driver SDK (0.27.0) runs inside the `yk` Bun runtime for one-shot
  commands. Persistent sessions manage one private driver worker themselves;
  users install no Node runtime, daemon, or extra dependency.
- Accessibility + Screen Recording must be granted to the program that runs
  `yk` (usually your terminal app). `doctor` reports the read-only status and
  prints the exact grant steps; it never opens permission dialogs itself.

## Background input and desktop use

Background delivery requests input without bringing the target to the front.
It does not isolate the user's mouse and keyboard. SDK 0.27 coordinate clicks
use synthetic events, and text insertion can fall back from AX to synthetic
keystrokes; the `type_text` tool schema has no public AX-only/no-fallback
input option. Unchanged frontmost/window-focus flags do not establish noninterference.
Use an independent test desktop for native input when the user's current desktop
must remain undisturbed. Observation and permission checks can remain read-only.

## Strict AX value writes

`Computer.setValue(target, elementToken, value)` and CLI
`act --set-value VALUE --element-token TOKEN` use the generic SDK
`set_value` operation. The adapter passes the target pid, the snapshot element
token, and the value. It does not call `typeText` or inject keyboard events.
The host returns success only for a structured result with
`route: "accessibility"` and `effect: "confirmed"`; another route or an
unverifiable result poisons the session. The token must come from a fresh AX
observation of the same target. This is a capability for controls with a
writable AXValue. It does not establish support for arbitrary web content or
custom controls.

## Where evidence goes

Screenshots and failure dumps default to
`~/Library/Caches/ya-skills/computer-use/` (dir `0700`, files `0600`).
Override per-run with `--out-dir`; pass the same directory to `observe` and
the subsequent coordinate `act` so both commands use the same observation store.
Nothing is written into the skill install
directory, the yk install prefix, or your project.

## Output contract

- Success: one JSON document on stdout (`apps`, `windows`,
  `{pid, windowId, title, elements, screenshot?}` for perceive/act,
  `{schemaVersion: 1, target, observation}` for observe, and
  `{schemaVersion: 1, target, result}` for batch with per-step receipts:
  `delivered` / `not_delivered` / `unknown` / `satisfied` / `not_run`).
- Failure: non-zero exit; post-driver failures print a JSON body with
  `error.code` / `error.message` (e.g. `degraded_snapshot`,
  `post_action_observe_failed` with `actionDelivered: true`,
  `action_refused`, `command_timeout` with `actionOutcome: "unknown"`,
  `batch_failed` / `batch_interrupted`, `stale_observation`,
  `request_conflict`).
  Input-validation failures print plain text + usage.
- windowId values are decimal strings (they exceed `Number.MAX_SAFE_INTEGER`);
  pass them back verbatim.
- Observations are single-use evidence for visual clicks: any delivered
  input invalidates them (60s TTL, geometry + PNG-hash verification across
  commands). `observationId` values are UUIDs.
- Native SDK errors are `not_delivered` only when a structured code proves
  rejection before input dispatch. Unclassified `DriverError.Tool` failures and
  cancellation after dispatch are `unknown`; they stop further session input.
- Sessions hold an application-level target lease: a second session (or a
  single-step act) on the same app pid is refused while the lease is alive.
  Unknown native delivery marks the session `unusable` and KEEPS the lease —
  explicit close ends the host control plane but does not clear an unresolved
  delivery verdict or prove that the target application's callback has finished.
- exec scripts are trusted local JavaScript; state is explicit JSON committed
  only on clean completion. Generated script API:
  `skills/computer-use/references/api.d.ts`.

## Distribution layout (Homebrew)

The release tarball ships `yk` plus `runtime/computer-use/node_modules/`
(SDK + darwin-arm64 native `.node`/`.dylib`, ~52 MiB). The compiled binary
locates that directory beside its realpath'd executable and loads the SDK at
runtime — packaged installs never depend on a source checkout, `NODE_PATH`,
or the current working directory's `package.json` (the
`--compile-autoload-package-json` flag is covered by the hostile-cwd test in
`tests/computer-use-packaging.test.ts`, which runs wherever the packaged
binary exists).

## Verification status

- Unit/behavior tests: `bun test` (input validation, lifecycle, deadlines,
  selection, privacy, stale-token retry, packaging).
- Real read-only checks on this machine (2026-09-13): doctor (same-process
  driver, permissions), apps, windows, perceive with screenshot, ambiguity
  refusal, degraded-snapshot refusal.
- Real Background coordinates through the packaged session/exec path now
  reach an AX-hidden canvas without making the fixture key/main or changing
  the frontmost app during the action. Window-movement and expired-evidence
  refusals also passed. Full native acceptance remains incomplete, including
  the fixed native cancellation case while the desktop is locked; see
  `docs/verification/2026-09-16-native-acceptance.md`.
