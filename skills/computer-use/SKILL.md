---
name: computer-use
description: Inspect browser and Electron UI through DOM/CDP first; use native macOS AX for dialogs and controls outside the page while respecting shared desktop input.
---

# Computer-use

Use this skill when a task needs a browser page or a visible macOS app. Keep
the decision loop short: inspect the current state, do a deterministic action
or small batch, then use the returned state to choose the next action.

## Shared desktop input

When the user is working on the same desktop, keep their focus, pointer, and
keyboard available. A separate app profile does not isolate desktop input;
a `background` delivery label is not proof of non-interference. Prefer CDP
and direct AX actions over synthetic keys or pointer events.

Do not escalate to foreground activation, global input, or AppleScript
`frontmost=true` to rescue a failing background test while the user is using
the desktop. Continue independent CDP/AX checks and record the affected
subcheck as blocked. Run input-dependent cases on an available isolated
login desktop or test machine, or within a foreground workflow the user has
already chosen. Do not create a new environment or interrupt the user merely
to keep a test running.

## Route browser pages first

For Chromium, Electron, or another page with a DevTools endpoint:

1. Use the available browser tool first. If it exposes CDP, list targets and
   record the exact target id.
2. If no browser tool is available, read
   [references/browser-cdp.md](references/browser-cdp.md) and run the bundled
   helper. It uses only built-in `fetch` and `WebSocket` in Bun or recent Node.
3. Evaluate a small, serializable DOM summary on that explicit target. Read
   `document.title`, URL, visible text, roles, labels, form controls, and
   state that answers the question. Keep the expression and output bounded.
4. Keep page navigation, forms, clicks, and assertions on CDP. Opening one
   native dialog does not move the rest of the journey to native input.
5. Stop using screenshots once the DOM or CDP result answers the question.

Do not select the active tab by position, switch tabs automatically, launch a
browser, bring it to the front, or restart a profile. A target id from a
fresh list is part of the request. If it disappears, list targets again and
resolve it again from the task URL or title; ask only when that is ambiguous. Use native computer-use only when the page is
not reachable through DOM/CDP, the task is about a native window, or the
browser renders the relevant state only in a canvas or native chooser.

For the helper's exact output and file-input rules, read
[references/browser-cdp.md](references/browser-cdp.md). For native response
shapes, key syntax, bounded orchestration, and visual delegation, read
[references/native-orchestration.md](references/native-orchestration.md) when
that mode is needed.

## Native macOS path

Run the read-only check first when the runtime is new:

```sh
yk computer-use doctor
```

Then use one target window at a time:

```sh
yk computer-use apps --name Safari
yk computer-use windows --pid PID
yk computer-use observe --pid PID --window WINDOW --mode auto
yk computer-use act --pid PID --window WINDOW --click-text "Search" --format observation
```

`perceive` remains available for strict snapshot output: `yk computer-use perceive --pid PID --window WINDOW --shot`. Use it when a legacy consumer needs the flat snapshot.

`observe` is the normal native inspection command. Prefer AX selectors and
fresh element tokens. Use `mode both` only when a screenshot is needed. Use a
persistent `session` to preserve the driver, tokens, and state across calls.
Use `batch` or `exec` within that session to combine already-decided steps and
local waits; stop at every new judgment. Read the returned observation and
verify the effect. For writable AX fields, use `setValue`; when keyboard events
are needed, address `type`/`key` to a fresh token or evidence-bound point.

For a native file chooser, distinguish an attached `AXSheet` from a standalone
`AXWindow`. Read an attached sheet through its actual parent window. See
[file chooser targets](references/native-orchestration.md#native-file-chooser-targets)
before switching the target to the chooser's separate window ID.

Visual coordinates are evidence-bound. Observe with `mode both`, look at the
exact returned image, and click only on that image's pixel coordinates. A
small detail can be inspected with `zoom` from the original capture; map its
coordinates back to the parent image before acting. Images default to at most
1280 px on the long side and 1,000,000 pixels; small images keep their size. A
stale, degraded, ambiguous, or expired observation is a reason to observe
again, not to guess or activate the window.

For `--activate` and foreground ownership, follow the shared desktop rule
above and the [native reference](references/native-orchestration.md#foreground-ownership).

Do not repeat an action with uncertain delivery. A `delivered` action means
input was sent; continue with observation. An `unknown` action means delivery
cannot be proved; observe first and choose a new request id or another route.
Follow the user's authorization for mutating work; do not add a new approval
step to an operation the user already requested.

## Keep execution bounded

Reuse the current persistent native session and the observation returned by
an action while valid; do not open another session or run another full
observation for the same known state. Batch already-decided actions and
condition waits locally, stopping when a new judgment or uncertain result
requires inspection. Prefer focused DOM/AX summaries; retain default image
limits and zoom a small region before requesting a larger image. Image size
flags do not increase AX tree completeness.

If the session is unusable or closed, confirm prior operations have settled
and cleanup has released the target before opening a fresh session to observe
current state. Never automatically replay an action with unknown delivery.

After correcting a target or input route, a repeated failure with the same
state and error is a stopping point for that route. Another attempt needs
new evidence, not another session, screenshot, or foreground toggle. Record
the error and continue independent cases. Keep command duration separate
from between-call reasoning time when investigating slowness.

## Setup and limits

The command is macOS arm64 only and keeps screenshots under
`~/Library/Caches/ya-skills/computer-use/` unless `--out-dir` is supplied.
The Cua Driver is loaded lazily by desktop paths. Use `yk computer-use <command> --help` for runtime details.
