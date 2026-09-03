---
name: validator
description: Use only when the user explicitly invokes /validator after a Plan is complete to establish its Completion Standard.
disable-model-invocation: true
---

# Validator

Establish the Completion Standard for a completed Plan. This skill defines what evidence would prove the work complete; it does not perform the work or judge its result.

## Invocation Gate

Run only when the user explicitly invokes `/validator`. Never trigger from a request to plan, implement, review, test, or validate in general.

This skill has one mode: **establish**. There is no verify mode.

## Hard Boundaries

- Do not implement code, fix bugs, write patches, or change implementation steps.
- Do not run tests, builds, typechecks, migrations, smoke tests, or other implementation validation.
- Do not claim the task is complete or issue validation verdicts.
- Do not create `VALIDATION.md`.
- Do not produce Findings or result-status sections.
- Do not lower the standard because the Plan or implementation is difficult, late, or incomplete.

Reading relevant requirements, contracts, documentation, configuration, and existing behavior is allowed when needed to establish the standard. Treat implementation artifacts as context, not proof that criteria have been met.

## Locate the Plan

A Plan may have exactly one of these carriers:

1. A writable Plan file: add or update only its `## Completion Standard` section.
2. Mutable runtime Plan state or a Plan tool: update that state using the available mechanism.
3. Historical messages or read-only context: output an authoritative appended section in the current response and say that the historical Plan could not be rewritten.

If no Plan exists, ask the user for one. If multiple candidate Plans exist and the target is ambiguous, ask which Plan to extend. Never guess.

Do not rewrite, reorder, add, or remove the Plan's implementation steps.

## Establish the Source of Truth

Derive the standard primarily from:

1. the user's stated requirements and explicit decisions;
2. an accepted SPEC or equivalent product/design agreement;
3. public contracts such as documented API, CLI, UI, schema, and compatibility behavior;
4. repository constraints and contributor instructions;
5. independently observed established behavior, citing the exact artifact, location, or observation that must be preserved.

Use Plan TODOs to understand scope, but do not merely restate them as acceptance criteria. An Implementer report may help locate code or documentation, but it is neither a standards source nor acceptable evidence.

Never cite generic labels such as “existing behavior” or “pre-change baseline” without a specific contract, file location, user decision, or direct observation. If the supposed baseline cannot be confirmed, put the missing decision in `Unresolved Questions` instead of turning the assumption into a criterion.

The latest explicit user decision may override an older source. Cite that decision in affected criteria. For any other source conflict, expose it in `Unresolved Questions`; do not average, silently choose, or weaken both sides.

Change an established criterion only when a genuine requirement change has a named source. Implementation difficulty is not a requirement change.

## Build a Risk-Selected Surface Inventory

Before writing criteria, identify only the surfaces whose observable behavior or release safety can be affected. For each included surface, state why it matters.

Consider, without mechanically enumerating:

- primary happy paths;
- edge, invalid-input, and failure paths;
- empty, missing, and null states;
- persistence, reload, restart, and recovery;
- backward compatibility and existing defaults;
- interactions with adjacent features;
- API shape, errors, status, and serialization;
- CLI arguments, stdout, stderr, exit codes, help, and compatibility;
- UI states, responsiveness, interaction, and accessibility;
- call sites and integration boundaries;
- state, configuration, migration, and rollback behavior;
- side effects, idempotency, security, privacy, and performance where relevant;
- tests, build, typecheck, packaging, and documentation where they provide necessary evidence.

Omit irrelevant surfaces. Risk, public exposure, persistence, compatibility, and failure impact should drive selection.

## Write Acceptance Criteria

Every criterion must be:

- **Atomic:** one independently decidable behavior for one input category and one public boundary; split behaviors that could pass or fail separately.
- **Observable:** stated at a public or externally inspectable boundary.
- **Falsifiable:** includes conditions that could clearly disprove it.
- **Traceable:** names a precise source, such as a user decision, SPEC section, contract, instruction file, or preserved behavior.

Use stable IDs such as `AC-01`. Assign `Blocker`, `Major`, or `Minor` severity according to user impact and release risk; severity does not relax the criterion.

Each row must contain:

- **ID:** unique stable identifier.
- **Severity:** `Blocker`, `Major`, or `Minor`.
- **Source:** precise requirement or contract citation, not “the Plan” alone.
- **Observable Behavior:** precondition, action, and externally visible result where applicable.
- **Verification:** an executable command or concrete procedure whenever possible; otherwise explicit manual observation steps.
- **Required Evidence:** the artifact needed for later independent review, such as command output, parsed output, snapshot, screenshot, recording, log, or documented observation.

Verification describes what a later verifier must do. Do not execute it during establish mode. “Tests pass,” “works as expected,” Implementer testimony, and code existence alone are insufficient.

Before finalizing, check every row for atomicity and source grounding. Split rows that combine independently failing inputs, states, or public boundaries; move any unconfirmed baseline assumption to `Unresolved Questions`.

## Reconcile an Existing Standard

When `## Completion Standard` already exists:

1. preserve criteria that remain sourced, atomic, and verifiable;
2. repair criteria with no valid source or no falsifiable verification;
3. add material omissions found through the Surface Inventory;
4. merge duplicates without losing source traceability or evidence requirements;
5. retain stable IDs when the underlying criterion is unchanged.

Do not preserve a criterion merely because it is already written, and do not replace valid content wholesale.

## Required Plan Section

Use exactly this structure:

```markdown
## Completion Standard

### Surface Inventory

| Surface | Why Relevant |
| --- | --- |
| ... | ... |

### Acceptance Criteria

| ID | Severity | Source | Observable Behavior | Verification | Required Evidence |
| --- | --- | --- | --- | --- | --- |
| AC-01 | Blocker | ... | ... | ... | ... |

### Unresolved Questions

None
```

Replace `None` with concise source conflicts or missing decisions that prevent a sound criterion. Do not turn ordinary implementation work into an unresolved question.

## Response

Use the user's language. State which Plan carrier was updated, or that the authoritative section follows because the source was read-only. Keep the response focused on the Completion Standard and unresolved source questions, without implementation advice, execution claims, verdicts, or extra validation documents.
