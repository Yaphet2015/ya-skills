---
name: design-grill
description: Use when stress-testing an idea, design, plan, architecture, PRD, or implementation approach before coding.
---

# Design Grill

Use this skill to force shared understanding before implementation. The output is a cleaned-up decision summary, not code.

Inspired by gstack `office-hours` and Matt Pocock's `grill-me`, `grilling`, `grill-with-docs`, and `domain-modeling` skills. This is a rewrite for this catalog's workflow.

## Hard Gate

Do not implement, scaffold, edit production code, run migrations, or perform mutating implementation commands while grilling. This skill produces decisions and documentation only.

If the user asks to implement during the session, stop the grill cleanly: finalize `DESIGN-GRILL.md`, report the accepted decisions, and wait for a separate implementation request.

## Start With Repo Truth

Before asking anything the repository can answer:

1. Inspect relevant docs, plans, existing `DESIGN-GRILL.md`, `CONTEXT.md`, `CONTEXT-MAP.md`, and ADRs if present.
2. Search the codebase for the named feature, API, workflow, command, page, schema, or error.
3. State assumptions explicitly and name conflicts instead of averaging them.

Ask only for product intent, trade-offs, missing constraints, or preferences that are not discoverable from the repo.

Use the same language as the user for questions, recommendations, and the final summary. Keep canonical technical terms such as ADR, PRD, API, and `CONTEXT.md` when they are clearer than translation.

## Grilling Loop

Ask one question at a time. Every question must include your recommended answer and why.

For each answer:

1. Record the decision immediately in the running `DESIGN-GRILL.md`.
2. Note rejected alternatives when they matter.
3. Resolve dependencies before moving to the next branch.
4. Challenge vague words, broad audiences, weak success criteria, hidden distribution assumptions, and "build the platform first" thinking.

If the user gets impatient, ask only the two highest-leverage unresolved questions, then move to synthesis.

## Decision Document

Maintain a repo-root `DESIGN-GRILL.md` as you go. If writes are unavailable, keep the same structure in chat.

During the session, it is a working log:

```md
# Design Grill

## Goal

## Decisions

## Rejected Alternatives

## Open Questions
```

After the grill is complete, rewrite the file as a concise final summary:

```md
# Design Grill

## Goal

## Accepted Decisions

## Rejected Alternatives

## Open Questions

## Recommended Approach

## Next Action
```

The final summary should be clean enough for an implementation agent to use without reading the whole conversation.

## Domain Documentation

Use domain docs selectively:

- Update `CONTEXT.md` only when a project-specific term is resolved. Keep it a glossary, not a spec or scratchpad.
- Offer an ADR only when the decision is hard to reverse, surprising without context, and the result of a real trade-off.
- Do not convert every decision into an ADR. Most decisions belong only in `DESIGN-GRILL.md`.

## Final Synthesis

Before ending, present 2-3 implementation approaches:

- one minimal viable approach;
- one stronger long-term approach;
- an optional third approach only when it is genuinely distinct.

Recommend one approach, explain the trade-off in one paragraph, then make the final `DESIGN-GRILL.md` match that recommendation.

## Common Mistakes

| Mistake | Correction |
| --- | --- |
| Asking questions the repo can answer | Search first, then ask only for intent or trade-offs. |
| Asking a batch of questions | Ask one question, wait, record the decision, continue. |
| Treating `CONTEXT.md` as the plan | Keep glossary terms in `CONTEXT.md`; keep decisions in `DESIGN-GRILL.md`. |
| Creating ADRs for every choice | ADRs are only for hard-to-reverse, surprising trade-offs. |
| Slipping into implementation | Stop, finalize the decision summary, and wait for a separate implementation request. |
