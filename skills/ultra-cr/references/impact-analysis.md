# Architecture Impact Analysis

Use this during Phase 2 to identify how the scoped changes affect callers, consumers and shared state. Work from the pinned comparison and reviewed source snapshot. Prefer `rg` for references, then read the actual implementations and contracts; a text match alone is not a dependency proof.

## Identify the Changed Paths

Reuse the resolved scope, `BASE_SHA` and `REVIEW_SHA` from workflow.md. Do not recompute a repository-root range. For branch/range comparisons:

```bash
git diff "$BASE_SHA..$REVIEW_SHA" --name-only
git diff "$BASE_SHA..$REVIEW_SHA" --stat
```

The same quoted range works in PowerShell. For staged/index changes or a root commit, use the existing scope-specific commands in workflow.md. With `all-branches`, analyze each recorded range separately. Source/configuration reads must match the reviewed snapshot; use `git show "$REVIEW_SHA:path/to/file"` when the ref differs from the working checkout.

## Follow Relevant Dependencies

Start with changed functions and assigned risks, expanding only to the boundary context needed to answer a concrete question:

1. **Callers and entry points**: Search the changed symbol or public contract, then inspect actual call sites. Account for event handlers, registration tables, configuration and dynamic dispatch where relevant.
2. **Callees and resource owners**: Read the operations they invoke, transaction/queue boundaries and success/failure/cancellation cleanup.
3. **Shared contracts**: Find consumers of changed types, schemas, IPC/API payloads, configuration keys and persisted records. Check compatibility against the documented contract and old behavior.
4. **Existing tests**: Read assertions for relevant triggers and consequences. A matching name does not establish coverage; an empty search is not proof that coverage is absent. State unresolved cases.

Use the host's source-search/read tools or shell equivalents. Typical `rg` starting points are:

```bash
rg -n -F 'ChangedSymbol' src tests
rg -n -F 'shared_state_key' src tests
```

Adapt paths and symbols to the project. Record source locations rather than dumping search output. Keep uncertain relationships explicit, especially for generated code, reflection and external consumers.

## Check Boundary Effects

| Changed boundary | Evidence to inspect |
|---|---|
| Public API, IPC or module interface | Existing callers, accepted inputs, output/error contract and compatibility |
| Persistent schema or serialized data | Readers, migration behavior, old records and mixed-version consumers |
| External dependency or configuration | Actual usage, failure propagation, default values and deployment assumptions |
| Shared resource or asynchronous state | Ownership, synchronization, cancellation and acquire/release paths |

A boundary crossing identifies where to investigate; it is not itself a defect or reason to add another reviewer. The coordinator assigns the relevant risk to the resolved team.

## Trace Shared-State Visibility

For changes to cache/DB/global state, events or cross-instance replication:

1. Identify the write site and the data it adds, removes, filters or changes.
2. Find the readers that consume that state, including readers outside the changed module.
3. Compare the reader's branch before and after the change: absent to present, present to absent, or changed shape/content.
4. Check the resulting branch against the business invariant and any companion state it requires.

Record the chain as **write site → read site → branch change → invariant to verify**, with file/line evidence. The behavior-regression reviewer or assigned boundary owner uses this context to establish whether a regression is real. No shared-state change means this step can be omitted.

## Record Impact in context.md

Keep the summary focused on the changed behavior and review assignments:

- Changed feature and affected interfaces/state owners.
- Necessary caller/callee locations and configuration consumers.
- Boundary contracts and concrete failure scenarios to investigate.
- Shared-state write/read chain when applicable.
- Relevant test evidence, assumptions and missing context.
- Which reviewer owns each risk and where overlap is intentional.

Separate observed facts from hypotheses. Broader impact can justify deeper inspection, but severity and blocking status require verified trigger, consequence and evidence. This summary feeds Phase 3 risk assignment and each Phase 4 reviewer's source navigation; it does not replace their independent code review.
