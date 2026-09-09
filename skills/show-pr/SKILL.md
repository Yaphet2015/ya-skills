---
name: show-pr
description: Use only when the user explicitly invokes show-pr to turn a branch diff or code change into a self-contained offline Chinese PR report — animated architecture / data-flow diagrams, mermaid diagrams, per-case test coverage with real results, verification screenshots or video, a decision-point design doc, and suggested manual tests in one HTML page. It never triggers implicitly.
disable-model-invocation: true
---

# Show PR (offline Chinese report)

This skill turns a diff or a codebase into one JSON document (lanes, nodes, edges, ordered flows, evidence sections) and renders it as a **self-contained, offline, dark-theme HTML report with all display text in Chinese**: `.show-pr/report.html`.

It runs entirely on local Node — no `npx` package, no network, no canvas, no PR attachment. Deliver the file path; the user opens it in a browser.

## Invocation Gate

Run only when the user explicitly invokes `show-pr` or explicitly asks for this PR report. Never trigger from a request to diagram, visualise, explain, review, or summarise a change or an architecture — even when a report would clearly help. "This would be useful" is not an invocation.

## Operating manual

1. **Read the diff.** For a code change: `git diff --find-renames <base>...HEAD` where `<base>` is the merge base (`git merge-base HEAD origin/master`), not the tip of the base branch. If not expressing a diff, read the code to be visually represented.

2. **Collect the evidence before writing a word of it.**

   - Run the tests and record the real per-case results — the numbers you actually observed, including failures on the base commit. A result you did not watch is fabrication.
   - Capture the screenshot or screen recording that proves you verified the behaviour yourself, into `.show-pr/evidence/`.
   - List the decision points you actually faced: what the options were, what you chose, why. Rejected options count.
   - If something was not run or not captured, that entry is simply absent from the document — never written from memory.

3. **Write the document** to `.show-pr/graph.zh.json`, following `references/graph-document.md`. `references/example.graph.json` is a valid reference with three lanes, all four delta states, a hero edge, a seven-step flow, a walkthrough, and all five evidence sections — read it before writing your first one; it is quicker than reading the reference.

4. **Validate, and fix.**

   ```bash
   node .agents/skills/show-pr/tools/validate.cjs .show-pr/graph.zh.json
   ```

   If this skill is installed elsewhere (for example `.claude/skills/show-pr`), adjust the tool path accordingly. Fix every failure and re-run until it prints `VALID`. Do not build a report from an invalid document; do not "work around" a failure by deleting the element it names. The validator enforces the full contract offline: enums, limits, referential integrity, evidence files existing under their size caps, and every design `chosen` being a declared option.

5. **Build the report.**

   ```bash
   node .agents/skills/show-pr/tools/build-report.cjs .show-pr/graph.zh.json .show-pr/report.html
   ```

6. **Deliver.** Hand back the path `.show-pr/report.html` and one or two sentences on what it shows. Nothing is pushed, attached or committed: `.show-pr/` is scratch space (keep it in `.gitignore`; the report is rebuilt from the document whenever needed).

A follow-up such as "rename that node" or "add the queue" is: edit `.show-pr/graph.zh.json`, validate, build again.

## Language rules (Chinese report)

- **Chinese**: `title`, `summary`, lane `label`/`subtitle`, node `label`/`subtitle`/`summary`/`group`/`badges`, edge `label`/`summary`, flow `title`/`summary`, participant `label`, message `label`/`note`, view `title`/`summary`, walkthrough `heading`/`body`, stats chip `label`/`value`, mermaid `title`/`summary` and the labels inside mermaid `code`, repro `title`/`note`/`result`/`steps`/`expected`, evidence `title`/`note`, design `title`/`context`/`options`/`rationale`, testStep `title`/`steps`/`expected`.
- **English (unchanged)**: every id (`lanes[].id`, `nodes[].id`, `edges[].id`, `flows/messages/views/steps ids — the id regex `^[A-Za-z0-9][A-Za-z0-9._:/-]*$` rejects CJK), every `kind`, every `delta` (`added`/`modified`/`removed`/`unchanged`), every `emphasis`/`tone`, every file path, code identifiers inside prose (module/function names like `sessionActions`, IPC channels like `quick:command`, protocols like `STOMP`), and the commands inside repro `command`/`steps` — commands are typed as they run, never translated. The report chrome (导览 / 上一步 / 下一步 / 新增·修改·移除·未变 badges / legend / the five section titles) is hardcoded in the build tool — never put it in the document.
- Write prose for a smart twelve-year-old: short common words, one idea per line, active voice, numbers as digits. This holds in Chinese: 用短句和常用词，一行为一件事。

## What makes a document worth reading

- **Include what did not change.** A diagram of only the changed nodes says nothing about blast radius. Mark the unchanged neighbours `delta: "unchanged"`.
- **Lanes are the reader's mental model** (a runtime, a tier, a boundary), not the folder tree.
- **One hero edge**, two at the outside: the connection the change is really about.
- **Add a flow only when there is a sequence worth animating.** One good flow beats three thin ones.
- **Add mermaid only for what lanes and flows cannot express** — a state machine, an ER model, a journey. A second drawing of the same architecture is noise.
- **测试覆盖是清单，不是教程**：逐条枚举改动涉及的用例，附真实结果；未被自动化覆盖的用例设 `manual: true` 单独列卡（黄色 warning 徽章 + 有序复现步骤 + 换行预期表现），不得混在自动化条目里。
- **Attach file refs** — they become the hover tooltips (summary + file list) on node cards.
- **Write a walkthrough anyway** for anything non-trivial: more than one diagram, several changed parts, or any flow. Two to twelve steps; the headline change is step one; an overview of everything touched is the last step. Each step is one change (added / removed / replaced / now / moved), never a description of the diagram.

## What makes the evidence worth trusting

The five evidence sections exist so a reviewer can check the work instead of taking your word. They are honest or they are worse than absent.

| 借口 | 现实 |
| ---- | ---- |
| "测试肯定能过，不用真跑" | 没跑过就没有结果行。跑一次，写下真实数字。 |
| "结果我记得大概" | 凭记忆写的结果是编造。回头重跑，或者不写。 |
| "复现步骤枚举不全" | 枚举分支涉及的全部用例；自动化覆盖的附真实结果，未覆盖的设 manual 并附步骤与预期。 |
| "截图以后补" | 说"已验证"之前必须有截图或录屏。没有就别写这条证据。 |
| "这个决策没有别的选项" | 没有备选的决策不是决策点，直接跳过，不要凑数。 |

**Red flags — 任一出现即停止并修正**：编造或凭记忆写结果；把测试覆盖的手工条目和建议手动测试写成两份一样的；证据图片与改动无关。

## What the report contains

- Header: title, summary paragraph, stats chips, commit range and diff size.
- Architecture view: one column band per lane, node cards colour-coded by delta (hover shows summary + file paths), animated edges, hero edge emphasised, removed elements dashed.
- Drill-down: one nav button per view (child views indented); clicking switches the visible node/edge selection.
- One sequence diagram per flow, with self-messages, repeats and notes.
- 导览 sidebar: every walkthrough step; click or ←/→ switches the diagram and dims everything except the step's focus.
- Five evidence sections, each rendered only when the document carries it, as one independent block at the very bottom of the page — fully below and outside the 导览 sidebar and the diagram stage (the 导览 filters diagrams only): Mermaid 图, 测试覆盖 (per-case command + result; manual cases flagged yellow with ordered steps + expected behaviour), 验证证据 (embedded screenshots / video), 建议手动测试 (ordered steps + expected behaviour), 设计决策 (context, options, chosen, rationale) — rendered last.

## What ships with this skill

| File                              | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `references/graph-document.md`    | the document, field by field: enums, limits, common failures   |
| `references/example.graph.json`   | one complete document that validates, to copy the shape of     |
| `references/evidence/`            | the placeholder screenshot referenced by the example document  |
| `tools/validate.cjs`              | offline contract validator (run with the graph path as argv)   |
| `tools/build-report.cjs`          | renders the graph document into the Chinese `report.html`      |
| `tools/vendor/mermaid.min.js`     | mermaid 9.4.3 (MIT), inlined into the report only when the document has mermaid diagrams |
