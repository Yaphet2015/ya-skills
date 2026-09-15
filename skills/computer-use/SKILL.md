---
name: computer-use
description: Drive real macOS UI. Use when the task must operate a visible desktop app.
---

# Computer-Use (via `yk`)

YOU are the decision loop. The `yk computer-use` commands give you eyes (AX
element JSON + optional screenshots) and hands (background clicks, typing,
keys, scrolling). Work in short steps: perceive → decide ONE action → act →
read the returned post-action perception → verify. Never script a whole flow
blind.

All commands work from any directory. Flags are documented below and in
`docs/computer-use.md`; `yk computer-use <command> --help` prints the one-line
command description.

## Setup (one-time)

```sh
yk computer-use doctor
```

`doctor` checks platform (macOS arm64 only), runtime files, that the driver
loads in-process, and macOS permissions — read-only, it never opens dialogs.
If permissions are missing, grant Accessibility AND Screen Recording to the
program running `yk` (your terminal) in System Settings, restart the
terminal, re-run `doctor`.

## The loop

```sh
# 1. find the target app (spawn it yourself first if absent)
yk computer-use apps --name Safari

# 2. pick a window — windowId is a decimal string, pass --window when several exist
yk computer-use windows --pid 1234

# 3. perceive: AX elements (role/label/value/frame) + optional screenshot
yk computer-use perceive --pid 1234 --window 5678 --shot

# 4. ONE action, then the tool prints the fresh perception
yk computer-use act --pid 1234 --window 5678 --click-role AXButton --click-text "新建会话"
yk computer-use act --pid 1234 --window 5678 --type "hello world"
yk computer-use act --pid 1234 --window 5678 --key Return
yk computer-use act --pid 1234 --window 5678 --scroll down --amount 3 --x 400 --y 300

# 5. verify the effect in the elements; repeat from 3
```

Screenshots land in `~/Library/Caches/ya-skills/computer-use/` (override with
`--out-dir`); open them yourself to see the UI.

## Rules that keep this safe

- **Background-first.** Clicks never steal focus. `--activate` exists ONLY
  when the user explicitly asks for foreground operation ("show me").
- **Never `--activate` your way around a degraded/empty perception.**
  Minimized or occluded windows have suspended AX trees — ask the user to
  surface the window instead.
- **Ambiguity is an error.** If windows or click matches are not unique, the
  command refuses; narrow the selector (`--window`, `--click-role`), do not
  click "the first match".
- **Typing needs focus.** Click the field first (background click sets
  window focus), then `--type`. If the draft does not appear, re-perceive
  ONCE to confirm the actual state — while delivery is uncertain, do NOT
  retype; a repeated action may land twice. Show the user the evidence and
  let them decide.
- **An echo is not success.** Text visible in AX after typing may be a stale
  mirror; re-perceive once before concluding.
- **Destructive actions announce first.** Before deleting, sending messages,
  submitting forms, or any irreversible click, state the exact action in the
  conversation and get the user's OK — unless the user already requested that
  exact operation.
- **Never read credentials.** Password field values are stripped from all
  output; do not attempt to work around it.
- **Respect the live session.** Prefer reading over writing on windows the
  user is actively using; prefer your own spawned instance for mutating flows.
- **One app/window at a time;** no parallel driving.
- If an `act` fails with `actionDelivered: true`, the action WAS delivered —
  continue with `perceive`, never repeat the act. A `command_timeout` error
  means delivery is UNKNOWN: observe with `perceive` before doing anything
  else; never blindly re-run the act.

## Verified behavior notes (2026-09-13, macOS arm64)

- Clicks re-resolve elements from a fresh snapshot every time; a stale-token
  refusal is retried exactly once internally.
- Windows/apps with many entries (e.g. Notes) require explicit `--window`.
- This skill drives any macOS app; it does not run e2e test suites and has no
  Cowork-specific logic.
