# Find behavior gaps before writing cases

Use the changed conditions and their callers to select risks. This is a discovery pass over the diff, not a claim that every possible combination can be covered.

## Removed behavior

For removed or replaced branches, fallbacks, guards, subscriptions, and retries, trace the input that used to reach them. Find its new owner, or record the missing path. A refactor description or an equality test does not prove that the old behavior survives.

Include transient inputs: an event may arrive before its owner row exists; cached data may become authoritative before a later update. Inspect tests for whether their fixtures actually enter the removed branch. Two empty results can satisfy equality while both violate the requirement.

## Select conditions from the code

| Changed logic | Questions that can expose a missing case |
| --- | --- |
| Ownership, attachment, merge | What is visible before an owner exists, after attachment, and after replacement? Does required content exist, and is it duplicated? |
| Snapshot, cache, refresh | What happens before/during completion, and after the final refresh has already finished? Can a later write change data without changing the refresh key? |
| Async lifecycle | Can events arrive late, out of order, or after switching identity? Which order reaches a different branch? |
| Capacity, omission, truncation | What makes the fallback active? Once active, what do subsequent ordinary updates read, transfer, or render? Does a failed request repeat work? |
| Failure/recovery | Which control failed, which handler retries it, and what cache/request state must exist? Does prior evidence reach this exact path? |

Use only relevant rows. Choose combinations where conditions interact, such as a fallback active during text-only updates or a saved edit after terminal refresh. Include a way to observe each required condition. If a fixture or diagnostic is unavailable, name that gap; do not replace it with an easier condition.

Record a small ledger in the sheet:

| Changed branch/behavior | Required state/order/entrypoint | Case or gap | Evidence or exclusion reason |
| --- | --- | --- | --- |

This complements the file inventory. Several conditions can come from one file; several files can support one condition. Split detailed sheets when necessary while retaining all selected risks in the index.

## Make the check reject a regression

- **Presence and identity:** Confirm the expected item exists, has the intended identity/content, and appears the expected number of times. Comparing two surfaces is supplementary.
- **Ordering:** Name the event that must finish before the next action. “Edit and refresh” does not establish that an edit occurred after the terminal refresh. Use an existing event/state observation or mark the timing setup blocked.
- **Repeated work:** Establish initial load, record a counter or byte baseline, change only the relevant input, then record the delta. Separate initial loading, intentional retries, and detail reads. Use a requirement's limit; if none exists, report counts/bytes and a proposed criterion. Do not invent a frequency or infer one from a single-response size cap.
- **Recovery identity:** Record the surface, control, handler, request kind, and relevant cache state. A detail retry and a document retry may share a label while exercising different paths.

## Preserve the boundary of evidence

If setup fails, keep the intended case blocked. A substitute can support a separate narrower case; name which prerequisite it bypasses. Existing content cannot establish behavior at first arrival, and normal-size data cannot establish behavior after omission.

In `again` mode, retain earlier observations with their exact fixture and path. Do not promote them to coverage for newly discovered conditions. Update the risk ledger as well as the file inventory.

Finish by scanning the diff again without relying on the existing case rows. Record open conditions and what would close them. Distinguish a planned case, an actual observed path, and a code-level inference; report only the evidence available for each.
