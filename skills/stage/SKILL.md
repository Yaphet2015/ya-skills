---
name: stage
description: Show read-only Cowork task status for the current clone or all four registered clones, including sourced session and review candidates when available.
---

# Stage

Show what is known about the requested Cowork work, with source links and observation times. Query only. Never initialize a task, bind a session, claim a writer, accept a receipt, repair records, or resume work. Execution belongs to an explicit `/bankai` invocation. Opening a project does not invoke either workflow.

## Scope

- `/stage current`: inspect only the current clone and its relevant tasks, sessions, and artifacts. Do not query other clones' Git, sessions, or runtime state.
- `/stage all`: show the current task first, then the four registered clones, marking the current clone.
- `/stage`: use `all`.

Accept an unambiguous scope stated in natural language. For unsupported or ambiguous scopes, explain `current` and `all` without silently broadening the query. `/stage continue` does not authorize execution; explain the explicit `/bankai continue [run-id]` entry.

Resolve this skill's canonical directory before locating the sibling `bankai` skill and the repository parent's `.fleet/workspaces.json`. Use only the registered clone paths; do not install user-level skills, change registration, or search unrelated repositories. If the current repository is outside the registration, report that fact and require an explicit registered target before querying its state.

## Read registered status

Run the existing helper with Python bytecode disabled:

```text
python3 -B <canonical-bankai>/scripts/pipeline.py cowork --repo <canonical-repo-root> [--session <actual-session-id>] status <current|all>
```

Supply only a session ID actually known from the host. The helper reads the registration and execution records; do not replace it with a new registry. If it fails, show the error and mark that source unavailable. Missing registration or task binding is a result, not permission to create state. Do not let a missing binding suppress other available evidence within the selected scope.

Treat recorded task state, host execution state, and completion evidence as different facts. The helper's `running` record does not prove a writer is currently alive. A host `busy` session does not prove task progress; an `idle` session does not prove completion, abandonment, or safe takeover. Retain conflicts and stale evidence explicitly.

## Supplement with sessions and review evidence

When connected Youkai tools are available, discover their current descriptions and use read-only queries. Match each selected local project by **canonical path and machine identity**, not its display name or shared Git remote. Query sessions using that exact local project ID and machine filter where available. A branch or similar title alone is insufficient to associate a session with a task.

Start with one recent page per selected clone. Read histories only for plausible matches or user-linked sessions; use a batch status query for selected session IDs when needed. Follow pagination when the requested coverage needs it. Otherwise state the page/time limits and never describe a partial result as all history. If tools or project identity are unavailable, report that limit and continue with local evidence.

For a session without an explicit run binding, display **candidate association / 候选关联** with its title, link, clone, branch when known, last activity, and the evidence connecting it to the work. An explicit task/run reference is stronger than a title match. Preserve multiple plausible candidates; do not select a winner by recency alone or rewrite the registered task's status from an inferred association.

Read review and check artifacts from helper links, relevant session references, or the clone's established artifact directory. Prefer specific referenced reports over recursive scans. Check that a file exists and identify its recorded branch, HEAD or diff, result, and timestamp where available. File modification time is not proof of when a check ran. An old report stays historical; without matching inputs, say applicability is unknown. An assistant's completion claim is attributed session evidence until supported by actual results.

Deduplicate a session or artifact already linked to a registered task. Label missing artifacts, absent timestamps, mismatched revisions, unverified fixes, and unavailable host observations. Do not fetch Git remotes, dispatch agents, regenerate reports, repeat checks, or write association files while displaying status. Candidate association becomes a binding only through an explicitly invoked Bankai workflow.

## Present the result

Write in the user's language. Lead with the current task's goal, completed work, blockers, and next action. If no task is bound, say so and summarize relevant candidates without inventing a current task. Distinguish a suggested next action from an action you executed.

For `all`, use a compact table: clone/current marker, branch, task or candidate, recorded status, host observation/owner, blocker or next action. For `current`, omit the cross-clone table. Put the most useful plan, check, review, and session links next to the relevant task; use absolute clickable paths for local artifacts. Link additional history rather than dumping logs.

Include the observation time and material coverage limits. Report “no registered task,” “no matching evidence in the queried range,” and “source unavailable” as distinct outcomes. Keep unresolved candidate associations visible without presenting them as confirmed execution state.

The former Fleet overview is included in `/stage all`; there is no separate Fleet skill. Catalog installation supplies the sibling `bankai` helper. Registration remains an explicit local setup step described in its `references/cowork.md`.
