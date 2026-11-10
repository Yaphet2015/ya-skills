---
name: show-pr
description: Explicit-only PR report entrypoint using show-me for change evidence and archify for HTML generation.
disable-model-invocation: true
---

# Show PR

Use this entrypoint only when the user explicitly invokes `show-pr` or asks for
this PR report. For visual explanations and architecture reports, use `show-me`.

`show-me` owns the explanation scope, change evidence and host delivery.
`archify` generates every HTML report and diagram.
Read the sibling [show-me skill](../show-me/SKILL.md), then its
[architecture and PR report workflow](../show-me/references/architecture-reports.md).
Use the PR workflow with the actual diff and available verification evidence.
Keep an explicitly supplied Git range and output directory.

Include working-tree changes when requested. Use the actual diff, current-file
excerpts, real verification results and evidence under show-me's change rules.
Follow its HTML handoff to archify, then its host-delivery steps. A new HTML
report uses archify's native diagrams or explainer components and finalizer.

The default report archive is
`~/.ya-skills/show-me/reports/<project>/<branch>/<timestamp>/report.html`.
The old graph.json schema and generator are preserved in the ya-skills source
repository at `archive/show-me-html/`. Legacy tool paths explain this migration;
they no longer generate new reports.
