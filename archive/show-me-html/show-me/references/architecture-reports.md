# Interactive architecture and PR reports

Use the bundled Node tools for offline HTML reports about architecture, module
relationships, data flow or code changes. The first diagram shows the key module relationship. Keep that overview small;
put the full topology in a child view instead of filling the opening screen.
Preserve useful connections, view switching, node details and optional guided focus.
The renderer also provides sequence views and optional evidence sections.

## Read the source

For an architecture explanation, read the actual modules and callers. Use
`delta: "unchanged"` for existing parts. Omit commit ranges and diff statistics
when the question is not about a change; never invent commits to satisfy a form.

For a PR or change report, use the range supplied by the user or workflow. Otherwise
identify the real base branch and its merge base with HEAD before reading the diff.
Do not assume that the base branch is named `master`. Read working-tree changes
when they are part of the requested scope. Attach only actual repository and commit
metadata. Include unchanged direct neighbours to show which parts the change touches.

Use available verification evidence. Record actual commands and observed results.
Do not rerun unchanged tests just to populate a report. Do not invent results,
screenshots or decisions. Label proposed manual checks as proposals. Include rejected
options only when they were actual alternatives. Omit sections without material.

## Write the graph

Read [the complete example](example.graph.json) for a PR report and
[the graph contract](graph-document.md) for field details and limits. The example's
data and screenshot are sample material; they are not evidence for the current task.

Write the conclusion before collecting fields. Include only the nodes and edges
needed to explain it in the initial view. Do not fill every optional section
because the example contains it. Put full test inventories and large evidence
collections in separate supporting artifacts when they would overwhelm reading.

Use one lane per runtime, responsibility or boundary, rather than per folder.
Use short node labels with explanations in `summary` and actual file references.
Mark one key edge `emphasis: "hero"`; use at most 2. Add child views only when they
show a narrower scope. Add a sequence view only when execution order matters.
Use Mermaid for state machines or other relationships that lanes cannot express.

Start small for a plain architecture:

```json
{
  "schemaVersion": "0.2.0",
  "kind": "graph",
  "title": "页面把请求交给服务",
  "summary": "页面发送请求。服务处理请求并返回结果。",
  "lenses": ["architecture"],
  "lanes": [
    { "id": "client", "label": "客户端" },
    { "id": "server", "label": "服务端", "order": 1 }
  ],
  "nodes": [
    {
      "id": "page",
      "label": "页面",
      "kind": "ui",
      "delta": "unchanged",
      "lane": "client",
      "summary": "用户在页面上提交请求。"
    },
    {
      "id": "api",
      "label": "服务",
      "kind": "service",
      "delta": "unchanged",
      "lane": "server",
      "summary": "服务接收请求并返回结果。"
    }
  ],
  "edges": [
    {
      "id": "request",
      "from": "page",
      "to": "api",
      "kind": "http",
      "delta": "unchanged",
      "label": "发送请求",
      "emphasis": "hero"
    }
  ]
}
```

`edges`, `flows`, `stats`, `views`, node `files` and node `badges` have empty
defaults. Omitted or empty views produce one architecture overview. `provenance`
is optional. If either a base or head commit is supplied, supply both; they must
be real, distinct commits. Omit `walkthrough` for a small diagram. When a relationship needs a guided explanation, add short steps. The guide
starts collapsed; each step must add information rather than repeat the overview.

Write short Chinese sentences by default. Keep code identifiers and paths intact.
Explain what a named module does in the same sentence. Put `file:line` after the
plain claim. For example: “sendBroadcastBulk 先从队列取出这一路广播。然后每 500 封发送一次。”
Follow an explicit language request when supplied; the bundled report controls are Chinese.

## Validate, build and inspect

Resolve the output directory using [the output rules](html-reports.md#verify-and-deliver).
Write `graph.json` there and copy real screenshots or recordings to its `evidence/`
subdirectory. Evidence paths are relative to the JSON document. Resolve the actual
installed `show-me` directory; do not assume a `.agents` or `.claude` target.

```bash
node <show-me-dir>/tools/validate.cjs <output-dir>/graph.json
node <show-me-dir>/tools/build-report.cjs <output-dir>/graph.json <output-dir>/report.html
```

Replace placeholders with resolved absolute paths and quote paths for the shell.
Fix validation failures before building; preserve the intended content while fixing
its references and fields. The tools use local Node and bundled assets, with no
network, package download or server required.

The renderer embeds [the shared CSS](../assets/report.css). It emits readable
HTML and SVG before scripts run; views and node disclosures use native controls.
Scripts add guided focus and supplementary Mermaid rendering. Check both modes.
For a host with a preview limit, pass `--max-bytes N` after the output path. If
it fails, reduce embedded evidence or deliver the full record separately; do not
remove necessary findings just to fit.

Inspect 320, 480 and 960 pixel widths. Check the initial reading view, native view
selection, node details, guide steps, keyboard use and sequences when present.
Honour reduced motion. If browser verification is unavailable, state that limit.
Follow [the host delivery steps](html-reports.md#verify-and-deliver), including
workspace staging and explicit preview intent when available. Public uploads and
publishing require their own user request.

A follow-up edit updates the source JSON, validates it and rebuilds the same report.
A new report gets a fresh output directory.
