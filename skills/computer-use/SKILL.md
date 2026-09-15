---
name: computer-use
description: Use when a task needs real desktop UI interaction on macOS, such as inspecting app state, reproducing a UI issue, or operating a visible window.
---

# Computer-Use (via `yk`)

YOU are the decision loop. The `yk computer-use` commands give you eyes (AX
element JSON + screenshots + per-channel validity) and hands (background
clicks — AX-first with a visual-coordinate fallback — typing, keys,
scrolling, and short batches). Work in short cycles: observe → decide →
execute deterministic steps → read the returned observation → verify.
Never script a whole flow blind.

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

# 3. observe: AX first; screenshot automatically when AX is insufficient
#    returns observationId + per-channel status + image geometry
yk computer-use observe --pid 1234 --window 5678 --mode auto
yk computer-use observe --pid 1234 --window 5678 --mode both --max-dimension 1600
#    (strict snapshot semantics stay available: yk computer-use perceive --pid ...)

# 4. deterministic steps: short batch (max 5 by default) in ONE command
yk computer-use batch --pid 1234 --window 5678 --file steps.json --request-id r1

# 5. single actions still work when you need them (then read the printed
#    post-action perception)
yk computer-use act --pid 1234 --window 5678 --click-role AXButton --click-text "新建会话"
yk computer-use act --pid 1234 --window 5678 --type "hello world"
yk computer-use act --pid 1234 --window 5678 --key Return
yk computer-use act --pid 1234 --window 5678 --scroll down --amount 3 --x 400 --y 300

# 6. verify the effect in the returned observation; repeat from 3
```

Screenshots land in `~/Library/Caches/ya-skills/computer-use/` (override with
`--out-dir`); open them yourself to see the UI.

## Batches: many deterministic steps, one tool call

A batch is an ordered, strictly serial list of steps bound to ONE window.
Use it when the next steps are already decided (e.g. click field → type →
press Return). Any step that needs a NEW judgment is a batch boundary:
run the batch, read the returned observation, then decide the next batch.

`steps.json` (max 5 actions by default, `maxActions` raises it to 20; overall
timeout 30s default, 120s max):

```json
{
  "actions": [
    { "kind": "click", "selector": { "text": "Search", "match": "exact", "role": "AXTextField" } },
    { "kind": "type", "text": "penguin" },
    { "kind": "key", "key": "Return" },
    { "kind": "wait", "condition": { "kind": "element_exists", "selector": { "text": "Results", "match": "contains" } }, "timeoutMs": 3000 }
  ],
  "observe": { "mode": "auto" }
}
```

- `--request-id` is the dedup key: same id + same file replays nothing and
  returns the recorded outcome; same id + different file is rejected.
- Every step returns a receipt: `delivered` (input was accepted — NOT
  business success), `not_delivered` (known refusal, safe to re-plan),
  `unknown` (delivery state unknowable — observe before anything else),
  `satisfied` (wait met), `not_run`.
- A failed or interrupted batch stops there; later steps are `not_run` and
  are NEVER auto-executed. After `unknown`, re-observe — never re-run the
  same batch id.
- Local `wait` conditions poll AX on this machine — they never round-trip
  through you. Conditions are restricted structured predicates:
  `element_exists`, `element_value`, `window_exists`. There is no
  `focused_element` (the driver exposes no verifiable focus state); if a
  step needs a focus guarantee, make the next step a NEW observation
  instead.

### Worked examples

**click → type (deterministic pair):**

```json
{ "actions": [ { "kind": "click", "selector": { "text": "Search", "match": "exact" } }, { "kind": "type", "text": "penguin" } ], "observe": { "mode": "auto" } }
```

**visual click → type (AX can't find the target; you looked at the
screenshot):**

```sh
yk computer-use observe --pid P --window W --mode both   # note observationId + image path
yk computer-use batch --pid P --window W --request-id r2 --file steps.json
# steps.json: { "actions": [ { "kind": "click_point", "point": { "observationId": "<id from observe>", "x": 500, "y": 300 } }, { "kind": "type", "text": "hello" } ] }
```

`x`/`y` are pixel coordinates ON THE RETURNED IMAGE (the exact file you
looked at). The observation is single-use: after any input is delivered the
id is invalidated — a second visual click needs a fresh `observe`. The
window must not move, resize, scroll, or navigate between observe and click;
if it does the click is refused with `stale_observation` (re-observe).

**a failed batch is never replayed:**

```sh
yk computer-use batch --pid P --window W --file steps.json --request-id r3
# → error batch_interrupted: steps 0:click:delivered, 1:key:unknown, 2:type:not_run
# Next step: observe. Do NOT retry r3 — the key press may have landed.
yk computer-use observe --pid P --window W --mode both
```

## Exec: a JavaScript flow in one session

When a task has many deterministic steps plus local decisions (loops,
retries, waits), run them as ONE exec flow instead of many tool calls:

```sh
yk computer-use session open --pid P --window W          # once
yk computer-use exec --session <ID> --file flow.js --request-id r1
```

The file's content is an **async function body** (not an ES module). You get
`computer` (click/clickPoint/type/key/scroll/wait/observe/batch), `state`
(explicit JSON object that persists across exec calls on the same session),
`log()`, and `observe()`. Full typing: `references/api.d.ts`; complete
example: `examples/search.js`.

- Defaults: 60s timeout (max 120s), 100 facade actions (max 500), 64KiB log
  budget, 20 observations, 256KiB state. Over-budget ends the run with a
  clear error — nothing is silently truncated.
- `state` survives across exec calls **only when the run completes cleanly**;
  a failed/cancelled run commits nothing. Plain JSON only (no Dates, Maps,
  bigints, functions).
- Every facade action returns a host-generated receipt (`delivered` ≠
  business success). The script cannot self-report success.
- Unknown delivery (timeout mid-action) interrupts the run and the session
  reports unusable — **never re-run the same request-id**; observe and decide.
- Returning with an unawaited `computer.*` call in flight refuses completion
  (`unawaited_actions`).
- Dynamic `import()` works (use absolute `file:` URLs for local files);
  static `import` statements do not — the body is not a module.
- This is TRUSTED local code execution: scripts run with your user's full
  rights (files, network, processes). There is no sandbox, no model audit,
  and no approval flow. Screen content and logs may contain secrets — you
  are responsible for what flows through them.

## Visual clicks on screenshots

When AX cannot identify the target but the image is valid, you may look at
the screenshot and click coordinates:

```sh
yk computer-use observe --pid P --window W --mode both --max-dimension 1600
yk computer-use act --pid P --window W --observation <observationId> --click-x 500 --click-y 300
```

- The coordinates are pixels on the returned image file. `--max-dimension`
  derives a smaller SAME-FRAME copy (original kept); coordinates are mapped
  back automatically — always read coordinates off the exact file you saw.
- Clicks stay in the background; a refused background click is reported
  (`action_refused`), never retried in the foreground.
- Delivered ≠ succeeded: after the click, read the returned observation.

## Rules that keep this safe

- **AX first, visual fallback.** Use AX selectors whenever they identify the
  target uniquely; use visual clicks only after actually looking at the
  returned screenshot. Observe (don't guess) when validity is `degraded`,
  `truncated`, or the image is stale — there are no automatic confidence
  scores.
- **Background-first.** Clicks never steal focus. `--activate` exists ONLY
  when the user explicitly asks for foreground operation ("show me").
- **Never `--activate` your way around a degraded/empty perception.**
  Minimized or occluded windows have suspended AX trees — ask the user to
  surface the window instead.
- **Ambiguity is an error.** If windows or click matches are not unique, the
  command refuses; narrow the selector (`--window`, `--click-role`), do not
  click "the first match".
- **Typing needs focus.** Click the field first (background click sets
  window focus), then `--type`. If the draft does not appear, re-observe
  ONCE to confirm the actual state — while delivery is uncertain, do NOT
  retype; a repeated action may land twice. Show the user the evidence and
  let them decide.
- **An echo is not success.** Text visible in AX after typing may be a stale
  mirror; re-observe once before concluding.
- **Destructive actions announce first.** Before deleting, sending messages,
  submitting forms, or any irreversible click, state the exact action in the
  conversation and get the user's OK — unless the user already requested that
  exact operation.
- **Never read credentials.** Password field values are stripped from all
  output; do not attempt to work around it.
- **Respect the live session.** Prefer reading over writing on windows the
  user is actively using; prefer your own spawned instance for mutating flows.
- **One app/window at a time;** no parallel driving. Batches are serial and
  bound to one window.
- If an `act`/batch step fails with `actionDelivered: true` or status
  `delivered`, the input WAS delivered — continue with `observe`, never
  repeat. A `command_timeout` / `unknown` receipt means delivery is UNKNOWN:
  observe before doing anything else; never blindly re-run.

## Verified behavior notes (2026-09-13, macOS arm64)

- Clicks re-resolve elements from a fresh snapshot every time; a stale-token
  refusal is retried exactly once internally.
- Windows/apps with many entries (e.g. Notes) require explicit `--window`.
- This skill drives any macOS app; it does not run e2e test suites and has no
  Cowork-specific logic.
