---
name: show-pr
description: Explicit-only compatibility entrypoint for show-me's offline Chinese PR reports and interactive architecture diagrams.
disable-model-invocation: true
---

# Show PR

Use this entrypoint only when the user explicitly invokes `show-pr` or asks for
this PR report. For visual explanations and architecture reports, use `show-me`.

`show-me` owns the report workflow, schema, examples, validator and renderer.
Read the sibling [show-me skill](../show-me/SKILL.md), then its
[architecture and PR report workflow](../show-me/references/architecture-reports.md).
Use the PR workflow with the actual diff and available verification evidence.
Keep an explicitly supplied Git range and output directory.

The default output is now
`~/.ya-skills/show-me/reports/<project>/<branch>/<timestamp>/report.html`.
Existing reports stay at their original paths. The installed `show-me` dependency
contains the examples and Mermaid bundle. Legacy tool paths still forward to it:

```bash
node <show-pr-dir>/tools/validate.cjs <graph.json>
node <show-pr-dir>/tools/build-report.cjs <graph.json> <report.html>
```
