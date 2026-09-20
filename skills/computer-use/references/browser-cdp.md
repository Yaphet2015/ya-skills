# Browser-first CDP route

Use this reference for Chromium, Electron, or another page with a Chrome
DevTools Protocol endpoint. Prefer the installed browser tool if one exists;
the bundled helper is a small fallback for discovery and DOM
inspection.

## Discover and bind one target

The helper uses built-in `fetch` and `WebSocket`; it needs no npm package,
daemon, browser launch, tab switch, frontmost change, or profile restart.
Run it from the installed skill directory (adjust the path for `.claude`):

```sh
bun .agents/skills/computer-use/scripts/browser-cdp.mjs targets \
  --endpoint http://127.0.0.1:9222
```

The result is a bounded JSON array. Each entry contains `id`, `type`, `title`,
`url`, and, when available, `webSocketDebuggerUrl`. Pick the exact `id` from
this result. Do not pick the first tab or infer the front tab. If the target
is gone, discover again.

Evaluate only against that explicit id:

```sh
bun .agents/skills/computer-use/scripts/browser-cdp.mjs eval \
  --endpoint http://127.0.0.1:9222 \
  --target-id TARGET_ID \
  --expression '({title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 4000) ?? ""})'
```

The result is `{target, result}`. `Runtime.evaluate` uses
`awaitPromise: true` and `returnByValue: true`; return serializable summaries,
not node handles or whole HTML. `eval` fails when `--target-id` is missing, unknown, or has no debugger WebSocket. It never selects another target.

`Runtime.evaluate` can execute arbitrary JavaScript; `userGesture: false` is not a read-only guarantee. Use inspection expressions by default and send a DOM mutation only when the task authorizes that action. A timeout does not prove that a mutation did not run; re-observe before deciding.

Requests have bounded defaults: 2 seconds, at most 10 seconds when explicitly
raised, 32 KiB of output, and 16 KiB of expression text. Use
`--timeout-ms` and `--max-output-bytes` only when the task needs a larger
bounded budget. Oversized responses fail with `cdp_output_limit`; they are not
silently truncated.

The helper exposes only `targets` and scoped `Runtime.evaluate`. Use the
browser tool or its CDP command surface for actions that need DOM node ids,
events, or file transfer. It is intentionally not a browser automation
framework.

## What to inspect

Ask the page for the smallest state that answers the question:

- title, URL, and visible text;
- headings, buttons, links, labels, and their disabled/selected state;
- form controls, their names, types, values that are safe to read, and
  validation state;
- a short list of matching nodes with stable attributes.

Once this answers the page question, stop taking screenshots and stop using
native AX for the same DOM fact. Use native computer-use only for an actual
native window, an inaccessible/canvas-only surface, or a browser chooser whose
native behavior is the subject of the test.

## File inputs

When a browser tool or CDP client provides a DOM node id, set a file input with
the CDP `DOM.setFileInputFiles` command and the intended absolute path. Keep
the path explicit and verify the page state afterward. The small helper in
this skill does not implement arbitrary CDP commands.

Use a native file dialog only when the user is testing the native chooser or
the browser exposes no usable file-input/CDP path. A visible chooser is not a
reason to switch the entire page flow to screenshots or AppleScript.

## Failure and fallback

Classify a failed CDP request before changing routes:

- endpoint unavailable or target missing: discover again and resolve by the task URL or title; ask only when the match is
  ambiguous;
- DOM result incomplete because the content is a canvas, shadow boundary, or
  native child window: use AX or a fresh image observation for that region;
- page navigation changes the target: list targets and bind the new id;
- timeout or output limit: reduce the expression and returned fields first.

Do not brute-force ports, relaunch the browser, activate a window, or retry a
timed-out mutation blindly. A fresh target list and a smaller read are safe
next steps; a visual action still needs fresh image evidence.
