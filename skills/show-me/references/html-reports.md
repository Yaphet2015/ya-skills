# HTML handoff and delivery

Locate and read the independently installed archify skill as described in
[HTML generation](../SKILL.md#html-generation). Its native diagram and explainer
workflows own HTML generation, layout, themes, interactions and checks. This
reference supplies show-me's output and host-delivery contract.

## Author through archify

- Keep a focused explanation in chat when that answers the question.
- Use archify's explainer workflow for an HTML report with a conclusion and
  supporting panels. Use its native diagram workflow for a requested diagram.
- Write the conclusion first. Keep relevant uncertainty and limits visible;
  use the actual task's data and sources. Preserve requested complete records.
- Run archify's full `finalize` command and inspect its receipt. A failure remains
  a failure; repair the source draft and repeat the applicable checks.
- Retain the draft, diagram specifications, evidence and receipts with the result.
  Follow archify's instructions for revisions and local panel patches.

For a change report, apply [change evidence](architecture-reports.md), including
its handling of uncommitted files, before writing the archify draft.

## Preserve the report archive

By default, keep the complete artifact folder at:

`~/.ya-skills/show-me/reports/<project>/<branch>/<timestamp>/`

Keep the final reading file as `report.html`; retain its source draft, receipts
and evidence. An explicit destination from the user or invoking workflow takes
precedence. Supply this resolved folder as archify's explicit destination. Run
its CLI from that folder with a relative output such as `report.html`, and use
absolute source and repository paths. This satisfies archify's output-path
contract while retaining show-me's report archive.

Resolve the archive names from the actual target project:

- `project`: the declared project name, then the Git-root directory name, then
  the current directory name.
- `branch`: the current Git branch; use `detached-<short-sha>` for detached HEAD,
  or `no-git` outside a repository.
- Encode each name as one path segment: percent-encode characters outside
  `A-Z a-z 0-9 _ -`, including dots. Never interpret a project or branch name as
  a path.
- `timestamp`: local `YYYYMMDD-HHmmss`. Create a fresh directory; add `-2`, `-3`
  and so on on collision. Follow-up edits update the same artifact folder.

Resolve `~` before invoking tools and read applicable destination instructions.

## Verify and deliver

For Youkai, the complete HTML preview budget is **30 MiB (31,457,280 bytes)**,
including embedded images and recordings. Check the final file size. Keep the
main report focused; deliver large original evidence as ordinary attachments
when needed. Preserve the finding and the requested evidence.

Read the active artifact tool's description before delivery. An older running
host may still advertise a smaller limit; obey the active host and report its
specific rejection if delivery fails. A source-code limit change does not
reconfigure a running host.

If the tool accepts files only inside the session workspace, resolve that actual
workspace from host metadata. A shell working directory may differ. Use the
checked report directly when it is already inside that workspace. Otherwise,
keep the archive and make a real copy at the host's established artifact location,
or `reports/show-me/<timestamp>/report.html`. Refresh that copy after rebuilding.
Copy the checked HTML without rewriting it so receipts still refer to its bytes.

When Youkai's file-delivery tool is available, request its preview presentation:

```js
youkai_upload_files({
  paths: ["reports/show-me/<timestamp>/report.html"],
  presentation: "preview"
})
```

Use the actual path. Check the returned success or failure. This local delivery
uses the host's artifact capability; publishing or external sharing requires its
own user request. Comments and Agent replies stay with the host.

Check the report in the target preview environment when available, including
narrow panes around 320 and 480 pixels and a wider 960-pixel view. Check visible
content, wrapping, controls and the host's script policy. Preserve readable
static meaning when a host blocks optional interactions. Report unverified
browser or host behavior plainly; automated artifact checks alone do not prove
that the user's side panel opened.

Return a short takeaway and a Markdown link to the delivered file. Distinguish
file saved, preview requested and preview observed. If delivery fails, give its
specific reason and the saved file link. Without an artifact tool, use the normal
file link.
