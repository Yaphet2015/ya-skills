# Native computer-use orchestration

Read this reference only for a native macOS task. Browser pages should follow
the browser-first route in `browser-cdp.md` first.

## Response shapes

`observe` and `act` do not have the same default shape:

```json
{
  "schemaVersion": 1,
  "target": { "pid": 123, "windowId": "456" },
  "observation": {
    "id": "uuid",
    "target": { "pid": 123, "windowId": "456" },
    "ax": { "status": "usable", "elements": [] },
    "image": { "status": "unavailable" }
  }
}
```

Read AX elements at `observation.ax.elements`, the observation id at
`observation.id`, and image evidence at `observation.image.path`. Do not look
for `elements` or `observationId` at the top level.

`act` keeps the compatibility shape by default (`--format legacy`):

```json
{ "pid": 123, "windowId": "456", "title": "Window", "elements": [] }
```

Use `--format observation` when the next decision should consume the same
observation envelope as `observe`. This makes the response choice explicit;
it does not change delivery semantics. A post-action observation is evidence
for the next decision, not proof that the business operation succeeded.

## Economical action loop

- Use `observe --mode ax` for a DOM-like native accessibility question.
- Use `observe --mode both` only when AX cannot answer and a visual frame is
  needed. Pass the same `--out-dir` to `observe` and coordinate `act`.
- Use a short batch or one `exec` flow for already-decided serial steps. Keep
  a new observation as the boundary for a new judgment.
- Use `--key KEY --modifiers MOD[,MOD]` for shortcuts. For example:
  `--key I --modifiers cmd,option`. Do not pass `Cmd+Alt+I` as one key.
- `--format observation|legacy` applies to one-shot and session `act` output;
  use `observation` for new orchestration and `legacy` for an existing parser.
- Treat structured receipt status and exit code as the retry signal. Do not
  search an arbitrary message for the word `error`.

When a batch reports `unknown`, observe before any further input and never
replay the same request id. When an action reports `delivered`, do not repeat
it: inspect the returned observation and verify the effect.

## Batch and exec

Put only already-decided serial actions in a batch. A batch is bound to one
window, stops at the first failed or unknown receipt, and marks later actions
`not_run`; its `--request-id` is a deduplication key and a failed/unknown run
must never be replayed. Example:

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

```sh
yk computer-use batch --pid PID --window WINDOW --file steps.json --request-id search-1
```

For loops, local waits, or a small bounded branch, open one session and run
one trusted local async-function body:

```sh
yk computer-use session open --pid PID --window WINDOW
yk computer-use exec --session SESSION --file .agents/skills/computer-use/examples/search.js --request-id search-flow-1
```

The generated script surface is
[`references/api.d.ts`](api.d.ts), and the complete flow example is
[`examples/search.js`](../examples/search.js). Exec state commits only after a
clean completion. An unknown delivery interrupts the session; observe and
decide instead of re-running the request id.

## Visual evidence and values

Coordinate evidence is single-use, has a 60-second TTL, and keeps the
target geometry, title, epoch, and revision with the observation. If the evidence
is still fresh and the state has not changed, use the original observation id
and coordinates; CLI/runtime performs the final evidence check. The runtime
decodes PNG pixels, requires the 32 sent-pixel target neighbourhood to remain
unchanged, and bounds unrelated global changes at 0.1% and 1024 pixels. If the
worker returns after the TTL or the window moved, resized, scrolled, or
navigated, take a fresh `observe --mode both`, inspect the new image, and ask
the worker to identify the target again. Never copy old coordinates onto a new
observation without re-identifying the target.

For a writable Accessibility value, use a fresh AX token:

```sh
yk computer-use observe --pid PID --window WINDOW --mode ax
yk computer-use act --pid PID --window WINDOW \
  --set-value VALUE --element-token TOKEN --format observation
```

`--set-value` uses the AX-only route and accepts only a confirmed writable
AXValue result. It never falls back to typing, but a confirmed AX value does
not prove that arbitrary web content or a custom control applied the value;
observe the page or app state afterward.

## Foreground ownership

Background delivery is the default. `--activate` is an explicit one-shot
request and the runtime records the actual previous frontmost PID, verifies
activation, and waits for driver cleanup before restoring that app. Restoration
requires the target to still be frontmost; another frontmost app or failed
cleanup prevents restoration. `--audit-foreground` records before/after ownership
without activation. Session actions remain background-only.

Do not add AppleScript activation, an Otty restore, or a blind foreground
retry around a refused action. If foreground activation or restoration has an
issue, report the receipt together with the action outcome. An action that was
already delivered must remain delivered even if its follow-up observation or
foreground restoration fails.

## Visual delegation

Delegate a visual question only when DOM, AX, and deterministic selectors do
not identify the target. Give the visual worker a minimal fresh context and
these three items only:

1. the image path (the exact returned image),
2. one concrete question, and
3. the coordinate convention: return pixel coordinates on that image, as
   `{x, y}`, with no scaling or window-relative conversion.

Keep the observation id and capture time in the parent/runtime state. The worker only needs the image path, question, and coordinate convention; the parent passes the original id to `act` while it remains valid.

Use `context: "fresh"` for pi-subagents or `fork_turns: "none"` for a Codex
fork. Pass a short task state rather than the development history. Ask for a
compact answer. The parent requests `--activate` when needed; CLI/runtime owns
capture/restore. The runtime worker owns image matching and final evidence
validation. Batch or execute deterministic actions in the parent/runtime after
the coordinate answer; the visual worker does not retry, foreground the app,
or run AppleScript.
