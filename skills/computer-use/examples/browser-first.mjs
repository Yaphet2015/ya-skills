// Browser-first inspection example.
// Set CDP_TARGET_ID from an explicit `targets` result. This example never
// chooses a tab by position and never launches or foregrounds a browser.
//
//   bun ../scripts/browser-cdp.mjs targets
//   CDP_TARGET_ID=<id> bun browser-first.mjs

import { evaluateTarget, listTargets } from "../scripts/browser-cdp.mjs";

const targetId = process.env.CDP_TARGET_ID;
if (!targetId) {
  throw new Error("set CDP_TARGET_ID to an id returned by browser-cdp.mjs targets");
}

const targets = await listTargets({ timeoutMs: 1_500, maxOutputBytes: 16 * 1024 });
const target = targets.find((entry) => entry.id === targetId);
if (!target) throw new Error(`CDP target ${targetId} is no longer listed; discover again`);

const result = await evaluateTarget({
  targetId: target.id,
  expression: `({
    title: document.title,
    url: location.href,
    text: document.body?.innerText?.slice(0, 4000) ?? "",
    forms: [...document.forms].map((form) => ({
      action: form.action,
      controls: [...form.elements].map((element) => ({
        tag: element.tagName,
        name: element.getAttribute("name"),
        type: element.getAttribute("type"),
        aria: element.getAttribute("aria-label")
      }))
    }))
  })`,
  timeoutMs: 1_500,
  maxOutputBytes: 16 * 1024
});

console.log(result.result);
