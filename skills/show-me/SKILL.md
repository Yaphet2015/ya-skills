---
name: show-me
description: Explain topics and code changes with concise Markdown, focused sketches and evidence; use separately installed archify for HTML reports.
---

# Show Me

Help the reader understand the current question with the smallest useful answer.
Start from the conversation's actual context, skip the preamble, and keep prose
brief. Follow explicit language, format, destination, and template requests.

## Tone

- Use a tone that follows ASD-STE100 Simplified Technical English, but expressed in Chinese.
- Always talk to me like I have ADHD.
- Keep necessary code identifiers, then explain what they do in the same sentence.
  Put file references after the plain claim. Use the requested language when specified.

## Edit before choosing a format

Answer the current question first. Select the few facts that explain the result
or change the decision. Remove the investigation diary, repeated conclusions,
background the reader already knows, and exhaustive lists that were not requested.
Keep a material risk, uncertainty or blocking condition visible beside the claim.
Do not shorten by clipping text or hiding qualifications.

Default to one conclusion and up to three supporting points. Treat this as a
reading budget, not a quota: fewer points are fine; a requested full audit or a
necessary qualification can need more. Explain code names in ordinary words.
If the question is already answered, stop. Apply this rule to Markdown and HTML.

## Choose the right amount of output

- For a focused explanation, stay in chat. A compact sketch and a short explanation
  are usually enough; invoking this skill does not require creating a file.
- Use HTML when a diagram, comparison or real interaction makes the answer
  easier to understand than a brief chat response, or when HTML is requested.
  Asking for a report alone does not require HTML. All HTML reports and diagrams
  use the installed `archify` skill. Read [HTML handoff and delivery](references/html-reports.md)
  when creating one. For a PR or code-change report, also read
  [change evidence](references/architecture-reports.md).
- Use the requested format when the user specifies one. Apply the visual and
  clarity principles that fit it rather than silently substituting HTML.

## Pick the form that answers the question

| What needs to become clear                               | Useful form                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Logic, an algorithm, or state transitions                | Pseudocode                                                                              |
| Runtime execution and call order                         | Call tree                                                                               |
| UI composition or module ownership                       | Component tree or shallow file tree                                                     |
| Communication or data flow between components            | Inline flow diagram, or interactive layered architecture and sequence views in a report |
| A change whose surrounding structure is already familiar | Focused diff                                                                            |
| Alternatives and their practical differences             | Compact comparison matrix                                                               |
| Dense relationships or interactive views                 | Focused HTML diagram or report                                                          |

Use real labels, paths, and data from the task. Include the calls, files, props,
states, and boundaries that change the reader's understanding. Match the product's
visual language when explaining its UI. Do not invent metrics or add decorative
diagrams to facts a short list already explains.

## HTML generation

`archify` is an independently installed skill. When HTML is needed, find it in
the current host's available-skills list and read the `SKILL.md` at its advertised
path. If the host provides a separate skill-discovery tool, use that when needed.
Resolve its CLI and references from that installation. Load only the references
needed for the selected workflow; the same Agent continues the task.

Archify owns HTML authoring, components, layout, diagrams, styling and generation
checks. Follow its explainer workflow for a report that combines a conclusion,
comparisons, code changes and verification evidence. Follow its native diagram
workflow for a requested standalone system or flow diagram, and run the applicable
finalizer.

`show-me` owns the explanation's scope, brevity, change evidence and host delivery.
Preserve explicit language, format and output requests during the handoff. Use the
same verified facts in chat and HTML. If archify cannot be found, explain that it
must be installed separately; finish with a useful chat explanation when possible.
`yk install show-me` installs this skill only. Archify's installation and upgrades
are independent; its location is supplied by the host. The former HTML generator
is archived in the ya-skills source repository at `archive/show-me-html/`;
new HTML uses archify.

Simple chat explanations still stay in chat. This skill explains and reports;
it does not implement applications or rewrite repository documentation.

## Output location

Default the report archive to
`~/.ya-skills/show-me/reports/<project>/<branch>/<timestamp>/report.html`.
Keep the authoring document, receipts and evidence beside the report. Give
archify this resolved directory as its explicit destination, as described in
[HTML handoff and delivery](references/html-reports.md).
An explicit destination from the user or invoking workflow takes precedence.
Follow the host delivery steps in [HTML report guidance](references/html-reports.md#verify-and-deliver).
Return a concise takeaway and a Markdown link to the delivered file. A file link
alone is not proof that a side-panel preview opened.

## Make the important change visible

Lead with the conclusion or relationship the reader needs to see. Put each
visual next to the short explanation it supports. Keep evidence separate from
proposals, and keep a qualification visible when it changes the conclusion.

For changes, use a diff of the actual shape: a component, file tree, call chain,
or state transition. For example:

```diff
on(save)
-  write content
+  if content is unchanged
+    return cached result
+  write content
+  invalidate cache
```

Show the complete block when most of it is new, omitted context would hide
ownership or execution order, or the reader needs a copyable target. Combine
forms only when each answers a different part of the question. Stop when the
key point is clear.
