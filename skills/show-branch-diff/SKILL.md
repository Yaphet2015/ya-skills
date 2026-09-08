---
name: show-branch-diff
description: Use only when the user explicitly invokes show-branch-diff to turn a branch diff or code change into an animated architecture / data-flow report — a self-contained offline Chinese HTML page. It never triggers implicitly.
disable-model-invocation: true
---

# Show Branch Diff (offline Chinese report)

This skill turns a diff or a codebase into one JSON document (lanes, nodes, edges, ordered flows) and renders it as a **self-contained, offline, dark-theme HTML report with all display text in Chinese**: `.show-branch-diff/report.html`.

It runs entirely on local Node — no `npx` package, no network, no canvas, no PR attachment. Deliver the file path; the user opens it in a browser.

## Invocation Gate

Run only when the user explicitly invokes `show-branch-diff` or explicitly asks for this branch-diff report. Never trigger from a request to diagram, visualise, explain, review, or summarise a change or an architecture — even when a report would clearly help. "This would be useful" is not an invocation.

## Operating manual

1. **Read the diff.** For a code change: `git diff --find-renames <base>...HEAD` where `<base>` is the merge base (`git merge-base HEAD origin/master`), not the tip of the base branch. If not expressing a diff, read the code to be visually represented.

2. **Write the document** to `.show-branch-diff/graph.zh.json`, following `references/graph-document.md`. `references/example.graph.json` is a valid reference with three lanes, all four delta states, a hero edge, a seven-step flow, a nested drill-down tree and a six-step walkthrough — read it before writing your first one; it is quicker than reading the reference.

3. **Validate, and fix.**

   ```bash
   node .agents/skills/show-branch-diff/tools/validate.cjs .show-branch-diff/graph.zh.json
   ```

   If this skill is installed elsewhere (for example `.claude/skills/show-branch-diff`), adjust the tool path accordingly. Fix every failure and re-run until it prints `VALID`. Do not build a report from an invalid document; do not "work around" a failure by deleting the element it names. The validator enforces the full contract offline: enums, limits, referential integrity, self-message endpoints, walkthrough flow-step focus, and the parser-level rules that JSON Schema cannot express.

4. **Build the report.**

   ```bash
   node .agents/skills/show-branch-diff/tools/build-report.cjs .show-branch-diff/graph.zh.json .show-branch-diff/report.html
   ```

5. **Deliver.** Hand back the path `.show-branch-diff/report.html` and one or two sentences on what it shows. Nothing is pushed, attached or committed: `.show-branch-diff/` is scratch space (keep it in `.gitignore`; the report is rebuilt from the document whenever needed).

A follow-up such as "rename that node" or "add the queue" is: edit `.show-branch-diff/graph.zh.json`, validate, build again.

## Language rules (Chinese report)

- **Chinese**: `title`, `summary`, lane `label`/`subtitle`, node `label`/`subtitle`/`summary`/`group`/`badges`, edge `label`/`summary`, flow `title`/`summary`, participant `label`, message `label`/`note`, view `title`/`summary`, walkthrough `heading`/`body`, stats chip `label`/`value`.
- **English (unchanged)**: every id (`lanes[].id`, `nodes[].id`, `edges[].id`, `flows/messages/views/steps ids — the id regex `^[A-Za-z0-9][A-Za-z0-9._:/-]*$` rejects CJK), every `kind`, every `delta` (`added`/`modified`/`removed`/`unchanged`), every `emphasis`/`tone`, every file path, and code identifiers inside prose (module/function names like `sessionActions`, IPC channels like `quick:command`, protocols like `STOMP`). The report chrome (导览 / 上一步 / 下一步 / 新增·修改·移除·未变 badges / legend) is hardcoded in the build tool — never put it in the document.
- Write prose for a smart twelve-year-old: short common words, one idea per line, active voice, numbers as digits. This holds in Chinese: 用短句和常用词，一行为一件事。

## What makes a document worth reading

- **Include what did not change.** A diagram of only the changed nodes says nothing about blast radius. Mark the unchanged neighbours `delta: "unchanged"`.
- **Lanes are the reader's mental model** (a runtime, a tier, a boundary), not the folder tree.
- **One hero edge**, two at the outside: the connection the change is really about.
- **Add a flow only when there is a sequence worth animating.** One good flow beats three thin ones.
- **Attach file refs** — they become the hover tooltips (summary + file list) on node cards.
- **Write a walkthrough anyway** for anything non-trivial: more than one diagram, several changed parts, or any flow. Two to twelve steps; the headline change is step one; an overview of everything touched is the last step. Each step is one change (added / removed / replaced / now / moved), never a description of the diagram.

## What the report contains

- Header: title, summary paragraph, stats chips, commit range and diff size.
- Architecture view: one column band per lane, node cards colour-coded by delta (hover shows summary + file paths), animated edges, hero edge emphasised, removed elements dashed.
- Drill-down: one nav button per view (child views indented); clicking switches the visible node/edge selection.
- One sequence diagram per flow, with self-messages, repeats and notes.
- 导览 sidebar: every walkthrough step; click or ←/→ switches the diagram and dims everything except the step's focus.

## What ships with this skill

| File                              | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `references/graph-document.md`    | the document, field by field: enums, limits, common failures   |
| `references/example.graph.json`   | one complete document that validates, to copy the shape of     |
| `tools/validate.cjs`               | offline contract validator (run with the graph path as argv)   |
| `tools/build-report.cjs`           | renders the graph document into the Chinese `report.html`      |
