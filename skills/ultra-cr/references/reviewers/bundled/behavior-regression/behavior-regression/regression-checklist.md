# Cross-Module Behavior Regression Checklist

A reference for the behavior-regression reviewer. This checklist catalogs recurring regression patterns at the write-side / read-side seam. Use it as a detection knowledge base — run each pattern as a pass against the change, but always validate with the 5-step Review Approach (the checklist helps you SUSPECT, the approach helps you CONFIRM).

## How to Use This Checklist

1. After completing Review Approach Step 1 (identify write sites), scan each write site against the patterns below
2. When a pattern matches, it tells you WHERE to look on the read side — proceed to Steps 2-5 to confirm
3. A matching pattern is a SUSPECT, not a finding. Only report after the four-element chain (write → read → branch-change → invariant-break) is verified
4. Add new patterns discovered during review to this file — it gets smarter over time

---

## Pattern 1: Filtered-Write Read-Side Starvation

**The highest-frequency regression.** A write path deliberately excludes a subset of entities before writing to shared state. A downstream reader consumes the shared state and has no separate path to obtain the excluded subset.

### Detection signals
- Write path contains a conditional filter: `if !isX { write(...) }`, `where type != 'secondary'`, `exclude(...)` before persist/publish
- The written state is consumed by readers in a different module / instance / DR
- The excluded subset is logically paired with the included subset (primary/secondary, parent/child, main/companion)

### How to confirm
1. Identify the excluded subset (what is filtered out before writing)
2. Find readers of the written state (Step 2 of Review Approach)
3. For each reader, check: does it have ANY path to obtain the excluded subset that does NOT depend on the written state?
4. Check visibility transition: before this change, could the reader find the included subset at all? If the change NEWLY makes the included subset discoverable (e.g., cross-DR sync newly propagates it), the reader switches from the "absent" branch (which may have resolved the excluded subset correctly via a fallback) to the "present" branch (which cannot resolve the excluded subset) ⇒ confirmed regression

### Canonical example (anonymized from a real incident)
- **Write side**: cross-DR stream-event sync. The sync deliberately excludes secondary streams: `if !isSecVideoStream { ReportStreamEvent(...) }`. Only primary stream events propagate to the peer DR.
- **Read side**: a peer-DR subscription path calls `getWorkerStreamId` to find the primary stream, then resolves the secondary stream id from the primary.
- **Visibility transition**: before sync was enabled, `getWorkerStreamId` could NOT find the cross-DR primary stream (took the "absent" branch → OutRegionStream fallback → resolved secondary correctly). After sync enabled, `getWorkerStreamId` FINDS the cross-DR primary (takes the "present" branch → tries to resolve secondary from primary → but secondary was never synced → secondary subscription fails).
- **Broken invariant**: "primary stream and secondary stream must be jointly discoverable for subscription."
- **Why write-side review missed it**: the write-side filter `!isSecVideoStream` is correct in isolation (secondary streams should not be synced). The bug is at the seam — the read-side branch that is newly taken cannot resolve the secondary.

### Fix options (least invasive first)
1. Sync the excluded subset too (make write and read symmetric)
2. Give the read-side "present" branch a fallback to resolve the excluded subset
3. Make the reader's "present" branch detect the asymmetry and fall back to the "absent" branch

---

## Pattern 2: Visibility Transition (Not-Found → Found)

A change NEWLY writes a state that was previously absent. A reader that used to take the "not-found" branch now takes the "found" branch, and the "found" branch does not handle something the "not-found" branch did.

### Detection signals
- The change adds a new write / new propagation / new cache population for a state that did not exist before
- A reader branches on the existence/presence of that state
- The "found" branch was written assuming local-origin data, but the newly-written data is remote-origin / partial / differently-shaped

### How to confirm
1. Confirm the state was NOT present (for this reader) before the change
2. Read the reader's "found" branch in full — does it assume anything the new write violates (origin, completeness, field presence)?
3. Compare what the "not-found" branch provided to its caller vs what the "found" branch provides — any capability lost?

---

## Pattern 3: Visibility Transition (Found → Not-Found)

A change REMOVES or GATES a write that previously happened unconditionally. A reader that used to take the "found" branch now takes the "not-found" branch.

### Detection signals
- The change adds a condition around a previously-unconditional write, or removes a write path
- A reader's "not-found" branch was a rarely-exercised fallback that does not actually fulfill the caller's need

### How to confirm
1. Confirm the write now happens under a narrower condition than before
2. Find readers; for each, determine if the narrower condition can cause "not-found" where "found" used to occur
3. Verify the "not-found" branch can still satisfy the caller — if it was a stub/error path, that is the regression

---

## Pattern 4: Cross-Instance Replication Asymmetry

Sync/replication writes a subset of state to a peer instance/DR. The peer's readers assume the full state (or companion state) is present.

### Detection signals
- The change involves cross-instance/cross-DR/cross-region sync, replication, or event forwarding
- The synced payload is a subset of local state (by design — e.g., only "push-node" events, only primary entities)
- The peer has readers that resolve companion/derived state from the synced entity

### How to confirm
1. Enumerate what IS synced vs what is NOT synced
2. On the peer side, find readers that consume the synced entity and derive/resolve the non-synced companion
3. Verify the peer reader's derivation path still works when only the synced subset is present — if derivation depends on session-layer/metadata that is NOT synced, that is the regression

### Sub-pattern: metadata/pairing asymmetry
- Sync writes entity events but NOT the session-layer metadata that links entities (e.g., AccompanyingStreamId pairing, parent-child relationship)
- Peer readers that reconstruct relationships from the synced events cannot do so without the metadata
- Confirm: is the relationship-resolving data synced? If not, peer readers that depend on it regress

---

## Pattern 5: Write-Shape Change Misinterpreted by Old Readers

A change alters the shape/fields/format of a written record. Existing readers parse the new shape using old assumptions.

### Detection signals
- The change modifies a serialized struct/DTO/protocol message that is written to shared state and read by existing code
- Fields are added, removed, renamed, or change optionality
- Readers use defensive parsing that silently defaults missing fields

### How to confirm
1. Diff the written record's schema before vs after
2. For each reader, check how it handles the changed fields — does a defaulted/missing field cause a different branch?
3. Verify the defaulted branch does not violate an invariant the old (present-field) branch upheld

---

## Anti-Patterns (NOT this reviewer's job — defer to others)

- **Single-module internal logic bugs** (null check, off-by-one) → @backend / @principal
- **Concurrency races within one module** → @backend / @principal
- **Security injection, auth bypass** → @security
- **Architectural style / coupling / boundary cleanliness** → @architect
- **Code smells, naming, duplication** → @quality / @martin-fowler
- **Test coverage gaps** → flagged by graph, validated by @testing

This reviewer ONLY reports findings with a verified write→read→branch→invariant chain across a module/instance/DR seam. If you cannot form that chain, defer to the appropriate reviewer.

---

## Self-Check Before Reporting

For every candidate finding, answer before writing it up:
- [ ] Write site identified? (file:line, what state, full-set or filtered-subset)
- [ ] Read site identified? (file:line, in a different module/instance/DR than the write)
- [ ] Visibility transition confirmed? (before vs after, which direction)
- [ ] Branch-direction change traced? (which branch before, which branch after, quote the condition)
- [ ] Broken invariant named explicitly?
- [ ] Read the FULL reader function (not just the diff hunk)?

If any box is unchecked, you do not yet have a valid finding — keep tracing or defer.
