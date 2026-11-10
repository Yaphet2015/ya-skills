# Archived show-me HTML generator

This snapshot preserves the complete show-me and show-pr skills immediately before
the migration to Archify 3.2.0 on 2026-11-10, including the uncommitted HTML report
improvements already present in the working tree.

New reports use the active `skills/show-me` workflow and an independently installed
Archify skill located through the host's skill list.
This directory is outside the installable catalog and release catalog. It retains
the old source, graph contract, examples, evidence, assets, licenses and sibling
compatibility entrypoints for inspecting or reproducing older reports.

Run the old tools explicitly from the repository root when reproducing history:

```sh
node archive/show-me-html/show-me/tools/validate.cjs archive/show-me-html/show-me/references/example.graph.json
node archive/show-me-html/show-me/tools/build-report.cjs archive/show-me-html/show-me/references/example.graph.json /absolute/path/report.html
```

`tests/show-me-html-archive.test.ts` retains their behavioral coverage. Instructions
inside the snapshot describe the historical implementation; active host limits
and current authoring instructions belong to the active skills.
