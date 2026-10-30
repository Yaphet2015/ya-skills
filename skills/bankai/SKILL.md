---
name: bankai
description: Explicitly launch or resume the current repository task workflow with persistent tasks, evidence and interruption recovery. Use only when the user invokes Bankai.
---

Use this skill only for an explicit `/bankai` invocation or an explicitly selected Bankai skill. A generic requirement, project entry, new session, or ordinary "continue" does not activate it. Once started, advance authorized phases without asking the user to invoke each stage. `/stage` is the separate read-only status interface.

Resolve this skill's canonical directory. Read [the execution contract](references/execution.md) for commands and file formats. Use this skill's bundled `scripts/pipeline.py` interface. Use the canonical Git root of the requested repository. State defaults to `~/.ya-skills/bankai/`; explicit task start registers only that repository. A remote and package manifest are not required.

For `/bankai <requirement>`, establish the task goal, acceptance criteria, appropriate steps and existing task authorization. Save the contract, then explicitly start it. A short change can run in the current agent; an architectural change uses applicable planning and independent challenge. Required dependencies follow the actual steps. Preserve the task's existing user changes and authorization provenance.

For `/bankai continue [run-id]`, including the localized continuation keyword U+7EE7 U+7EED, inspect the selected run and reconcile ownership, processes, unfinished actions, current source and evidence before continuing. Follow the returned frozen helper. Ambiguous task selection needs a short task choice. An unknown or live previous writer is not permission to take over.

Continue selecting and executing eligible steps until the task is complete, paused by the user, blocked by a concrete missing fact, or at its actual authorization boundary. Reuse accepted evidence only when its inputs still apply. Review required findings before declaring completion. Register delegated writers and commands; check the owner token before edits, Git operations, commands and delegation. Reconcile side effects before replaying them.

Before yielding, publish the full handoff/checkpoint and release ownership only after all registered writers have stopped. Report the run ID, completed work, next action or final result, actual checks, and artifact links. Do not invent successful checks or treat a pushed branch as task completion.

Bankai includes its engine and execution contract. Install it with `yk install bankai`. Optional registration uses the bundled helper's `register` command; installing or inspecting a skill does not start tasks.

Read the repository instructions, relevant source, project scripts and CI configuration to select checks for the task. Bind acceptance criteria to concrete evidence. Report unavailable checks as missing coverage; do not substitute a trivial passing command. Repository-specific tools and independent review follow the actual change risk.
