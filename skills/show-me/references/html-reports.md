# Standalone visual reports

Use this guidance when the task calls for a report or a focused visual artifact
that benefits from HTML. Make the first screen understandable by scanning, then
let the reader explore evidence at their own pace.

## HTML styling

Default to [shadcn/ui](https://ui.shadcn.com/) for the visual design of HTML
reports, including the shell and controls around bundled architecture diagrams.
An explicit user style, supplied template or existing product's visual language
takes precedence.

- Consult the relevant official component examples and
  [theming guidance](https://ui.shadcn.com/docs/theming) when choosing styles.
  Use restrained surfaces, clear typography, subtle borders, consistent spacing
  and corner radii. Follow patterns such as Button, Badge, Tabs, Table and
  Accordion where they serve the content.
- Use semantic CSS variables for background/foreground, card, primary, muted,
  accent, border, ring and radius. Keep text/surface pairs legible and provide
  visible keyboard focus. Reserve status colors for meaningful findings.
- For standalone HTML, translate the relevant component styles into ordinary
  embedded CSS and semantic HTML. Embed any compiled utility styles and required
  assets. The delivered file must work offline without React, a Tailwind CDN,
  remote fonts or runtime package loading.
- When using the bundled renderer, preserve its graph behavior and apply the
  same styling to the generated HTML shell and controls. Keep report-specific
  diagram and change colors where they convey meaning.

## Structure and emphasis

- Lead with a one-sentence conclusion and a small set of highlighted findings.
  The first screen should show what matters, why, and the useful next action.
- Use short labels and one idea per paragraph. Explain necessary technical terms
  where they appear. Avoid long introductions and repeated summaries.
- Group by the decision or causal relationship rather than investigation order.
  Put sources, detailed evidence, assumptions, and secondary cases in labelled
  expandable sections. Keep a qualification visible when it changes the conclusion.
- Preserve the evidence. Distinguish observed facts from proposals and uncertainty;
  do not invent quantities, rankings, or precision to make a chart look complete.
- Highlight conclusions, meaningful differences, and required actions. Keep
  supporting detail visually quieter. Use a small, consistent color vocabulary
  with text labels, never color as the only signal.

## Make relationships visible

Choose a visual that explains the actual material:

| Reader needs to understand | Useful form |
| --- | --- |
| Cause, execution order, or dependencies | Labelled flow or sequence |
| Ownership or component relationships | Small architecture map |
| Alternatives and trade-offs | Comparison cards or a compact matrix |
| Quantities with an actual shared measure | Bars, a chart, or a labelled scale |
| Change over time or ordered milestones | Timeline |
| Priority and next actions | Ranked short list with evidence and status |

For architecture and PR reports, follow [the bundled graph workflow](architecture-reports.md).
For custom reports, use semantic HTML, CSS and inline SVG for the visual structure. Keep essential
explanations as selectable HTML text. Add captions and legends where they change
interpretation. Match an existing product or template when one is supplied. Do
not turn every paragraph into a card or make an illustration replace the evidence.

## Let the reader explore

Prefer native `details`/`summary`, labelled radio groups, checkboxes, and
in-document links for disclosure and view selection. A control should reveal an
actual comparison, evidence, or explanation. Keep the main conclusion readable
without interacting.

Respect the host's script policy. For custom reports, keep readable content and
core controls available without JavaScript. The bundled architecture renderer
uses inline JavaScript for SVG construction, view selection and guided focus.
Use it where scripts are supported. If the target blocks scripts, provide a
readable static diagram and the same explanations. Reports need no dev server,
CDN, network call or framework.

Keep comments and Agent communication with the host when it provides those
features. Do not invent an Agent endpoint inside the document. Preserve text
selection, focus, and keyboard operation.

## Fit a narrow pane

- Include viewport metadata. Use fluid widths, `min-width: 0`, wrapping text and
  flexible grids. Stack comparison columns and flow steps when the pane narrows.
- Around 320 CSS pixels, keep conclusions, labels, controls, and sources usable
  without horizontal page scrolling. Check a narrower pane when a discussion
  sidebar shares the available space.
- Let a genuinely wide table or diagram scroll inside its own labelled region.
  Keep its title and explanation in the normal reading flow. Do not shrink the
  whole report, use tiny type, or fix it to a desktop width.
- Avoid hover-only explanations, full-page pointer overlays, and fixed-height
  panels that clip content.

## Keep motion calm and smooth

Use brief transitions, typically 160–240 ms, to clarify changed selections or
newly revealed detail. Prefer opacity and small transforms; keep feedback
immediate. Avoid animating layout dimensions, continuous motion, scroll hijacking,
large entrance sequences, and automatic carousels. Honor `prefers-reduced-motion`
by removing nonessential movement. Animation must not be needed to understand a
finding.

## Verify and deliver

Use an available browser or rendering tool to inspect narrow and wide widths,
for example 320, 480, and 960 pixels. Check overflow, wrapping, focus, controls,
reduced motion, and whether the first screen makes the conclusion clear. Test
core interactions with scripts disabled when that matches the target host. If
rendering is unavailable, state what was checked structurally and what remains
unverified.

Default to one self-contained HTML file with embedded styles and assets:

`~/.ya-skills/show-me/reports/<project>/<branch>/<timestamp>/report.html`

An explicit destination from the user or invoking workflow takes precedence.
Resolve paths from the actual target project and the user's home directory:

- `project`: the declared project name (for example `package.json` `name`);
  otherwise the Git-root directory name, then the current directory name.
- `branch`: the current Git branch; use `detached-<short-sha>` for detached HEAD,
  or `no-git` outside a Git repository.
- Encode each project and branch value as one path segment (percent-encode
  characters outside `A-Z a-z 0-9 _ -`; encode dots too). Never interpret a name
  as a path. This keeps `feature/login` distinct from `feature-login`.
- `timestamp`: local time as `YYYYMMDD-HHmmss`; if it already exists, add `-2`,
  `-3`, and so on. Create a fresh directory; preserve prior reports.

Resolve `~` to the real home directory before passing paths to tools. Check the
applicable `AGENTS.md` instructions at the destination. Keep `graph.json` and
`evidence/` beside `report.html` when the graph workflow is used. Embed evidence
in the final HTML so it opens without those neighbouring files. Do not use a
temporary directory or an application-private chat directory as the default.

Return a short takeaway and a Markdown link to the saved file, using the host's
documented file-link convention when available. Use an existing preview when
supported; do not assume a file link automatically opens it. A local report does
not require uploading, publishing, starting a server or installing another tool.
Keep the document readable outside the host as well.
