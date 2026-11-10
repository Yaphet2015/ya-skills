# Architecture and change evidence

Use these rules to gather facts for chat explanations and archify reports.
HTML generation follows [the archify handoff](html-reports.md).

## Choose the real scope

For an architecture question, read the relevant modules and callers. Trace the
actual input, operation, output and side effect. Include boundaries and conditions
that change the answer. Omit invented commit ranges or change statistics.

For a PR or change report, retain the range supplied by the user or invoking
workflow. Otherwise identify the actual base branch and its merge base with HEAD.
Read working-tree changes when they are part of the requested scope. Keep the
before and after versions distinct and include unchanged direct neighbours when
they explain ownership or execution order.

## Preserve working-tree evidence

An uncommitted edit is valid report material. Read its current bytes and the
actual diff. Identify it as working-tree content, with its path and relevant
lines. Save the used diff and selected source excerpts beside the report so the
reader can later check what the report described.

Archify's repository-backed `@source` and `@code` use bytes from a pinned Git
commit. Use them only when that exact version proves the claim. A changed working
file cannot stand in for that commit, and local-only links do not change this.

For an uncommitted change report, use archify's explainer workflow: show the
actual diff with `@diff` or a diff fence, and show current source excerpts in
literal code fences labelled with their path and working-tree origin. State the
scope near the conclusion. Compact diagrams can explain the observed change;
keep their relevant evidence next to them. Do not label those current-file claims
as commit-verified. Cite unaffected committed code separately when useful.

User-supplied code, non-Git projects and proposed changes can also use literal
code and diagram blocks with their actual origin stated. Keep proposals distinct
from observed behavior. Never create commits merely to satisfy a report format.

## Keep verification evidence truthful

- Record actual commands and observed results. Reuse existing results when their
  inputs are unchanged; do not rerun checks just to populate the report.
- Distinguish passed, failed and unrun checks. Mark proposed manual checks as
  proposals and preserve material failures or limits near the conclusion.
- Include real screenshots or recordings only when they support the answer.
  Keep detailed logs and large original evidence alongside the report or in
  separate attachments. Link to them and preserve requested complete records.
- Include design decisions and rejected options only when they were actual
  alternatives. Omit empty sections.

Write short explanations, place visuals beside the claims they support, and use
one term for each module across chat, panels and diagrams. Archify owns the page
components and graphical form. Finish with its checks and the host-delivery steps.
