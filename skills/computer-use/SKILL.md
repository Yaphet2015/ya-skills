---
name: computer-use
description: Route web pages through browser DOM/CDP first, then drive native macOS UI when a visible desktop app is required.
---

# Computer-use

Use this skill when a task needs a browser page or a visible macOS app. Keep
the decision loop short: inspect the current state, do a deterministic action
or small batch, then use the returned state to choose the next action.

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
4. Stop using screenshots once the DOM or CDP result answers the question.

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
yk computer-use act --pid PID --window WINDOW --click-text "Search"
```

`perceive` remains available for strict snapshot output: `yk computer-use perceive --pid PID --window WINDOW --shot`. Use it when a legacy consumer needs the flat snapshot.

`observe` is the normal native inspection command. Prefer AX selectors and
fresh element tokens. Use `mode both` only when a screenshot is needed. Use a
short `batch` or one `exec` session for already-decided serial steps; stop at
every new judgment. Read the returned observation after an action.

Visual coordinates are evidence-bound. Observe with `mode both`, look at the
exact returned image, and click only on that image's pixel coordinates. A
stale, degraded, ambiguous, or expired observation is a reason to observe
again, not to guess or activate the window.

`--activate` is an explicit foreground request. Use it only when the user
asked for foreground behavior or the native operation requires it. Use
`--audit-foreground` to record frontmost ownership without activation when a
diagnostic needs evidence. Read the foreground receipt before reporting the
result.

Native input can still affect the user's mouse or keyboard even when delivery
is labelled background. Use an independent desktop for mutating native tests
when uninterrupted user input matters. Do not use AppleScript to bypass the
CLI or force a foreground retry.

Do not repeat an action with uncertain delivery. A `delivered` action means
input was sent; continue with observation. An `unknown` action means delivery
cannot be proved; observe first and choose a new request id or another route.
Follow the user's authorization for mutating work; do not add a new approval
step to an operation the user already requested.

## Setup and limits

The command is macOS arm64 only and keeps screenshots under
`~/Library/Caches/ya-skills/computer-use/` unless `--out-dir` is supplied.
The Cua Driver is loaded lazily by desktop paths. Use `yk computer-use <command> --help` for runtime details.
