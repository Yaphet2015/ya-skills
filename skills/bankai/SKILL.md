---
name: bankai
description: Explicitly launch or resume the registered Cowork workflow with persistent tasks, evidence and interruption recovery. Use only when the user invokes Bankai.
---

Use this skill only for an explicit `/bankai` invocation or an explicitly selected Bankai skill. A generic requirement, project entry, new session, or ordinary "continue" does not activate it. Once started, advance authorized phases without asking the user to invoke each stage. `/stage` is the separate read-only status interface.

Resolve this skill's canonical directory. Read [the execution contract](references/cowork.md) for commands and file formats. Use this skill's bundled `scripts/pipeline.py cowork` interface. Do not start in a repository that is not explicitly registered in the repository parent's `.fleet/workspaces.json`.

For `/bankai <requirement>`, establish the task goal, acceptance criteria, appropriate steps and existing task authorization. Save the contract, then explicitly start it. A short change can run in the current agent; an architectural change uses applicable planning and independent challenge. Required dependencies follow the actual steps. Preserve the task's existing user changes and authorization provenance.

For `/bankai continue [run-id]`, including the localized continuation keyword U+7EE7 U+7EED, inspect the selected run and reconcile ownership, processes, unfinished actions, current source and evidence before continuing. Follow the returned frozen helper. Ambiguous task selection needs a short task choice. An unknown or live previous writer is not permission to take over.

Continue selecting and executing eligible steps until the task is complete, paused by the user, blocked by a concrete missing fact, or at its actual authorization boundary. Reuse accepted evidence only when its inputs still apply. Review required findings before declaring completion. Register delegated writers and commands; check the owner token before edits, Git operations, commands and delegation. Reconcile side effects before replaying them.

Before yielding, publish the full handoff/checkpoint and release ownership only after all registered writers have stopped. Report the run ID, completed work, next action or final result, actual checks, and artifact links. Do not invent successful checks or treat a pushed branch as task completion.

Bankai includes its engine, registration helper and execution contract. Register the intended clones separately using the installation command in `references/cowork.md`; installing a skill does not register repositories or start tasks.
