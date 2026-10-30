---
name: stage
description: Show read-only repository task status for the current repository, same-project sibling repositories, or explicitly registered repositories, including sourced session and review candidates when available.
---

# Stage

Show what is known about the requested repository work, with source links and observation times. Query only. Never initialize a task, bind a session, claim a writer, accept a receipt, repair records, or resume work. Execution belongs to an explicit `/bankai` invocation. Opening a project does not invoke either workflow.

## Scope

- `/stage current`: inspect only the current repository and its relevant tasks, sessions, and artifacts. Do not query other repositories' Git, sessions, or runtime state.
- `/stage all`: show the current task first, then matching sibling repositories and explicitly registered repositories, deduplicated by canonical path.
- `/stage`: show the current repository and automatically include matching repositories directly under the same parent directory. If none match, report only the current repository.

Accept an unambiguous scope stated in natural language. For unsupported or ambiguous scopes, explain `current` and `all` without silently broadening the query. `/stage continue` does not authorize execution; explain the explicit `/bankai continue [run-id]` entry.

Resolve this skill's canonical directory before locating the sibling `bankai` skill and `~/.ya-skills/bankai/workspaces.json` (or the explicitly configured runtime root). Default queries inspect only direct sibling Git roots to discover the same project. Confirm relationships through a shared Git common directory, matching normalized origin URLs, or a local origin pointing directly at the other repository. Folder names, manifest names, and equal working files do not prove identity. Normalize SSH/HTTPS forms and a terminal `.git` suffix; retain host, repository path and non-default ports. Skip directory symlinks, nested repositories and unmatched projects. Do not fetch remotes or traverse history to guess a relationship. Show unavailable identity sources and the discovery limits. Discovery never registers repositories. An unregistered matching repository can still show its branch, dirty file count, and relevant session evidence; mark its task history as unregistered.

## Read registered status

Run the existing helper with Python bytecode disabled:

```text
python3 -B <canonical-bankai>/scripts/pipeline.py --repo <canonical-repo-root> [--session <actual-session-id>] status [current|all]
```

Omit the scope argument for the default query with automatic sibling discovery. Explicit `current` must never inspect other repositories.

Supply only a session ID actually known from the host. The helper reads the registration and execution records; do not replace it with a new registry. If it fails, show the error and mark that source unavailable. Missing registration or task binding is a result, not permission to create state. Do not let a missing binding suppress other available evidence within the selected scope.

Treat recorded task state, host execution state, and completion evidence as different facts. The helper's `running` record does not prove a writer is currently alive. A host `busy` session does not prove task progress; an `idle` session does not prove completion, abandonment, or safe takeover. Retain conflicts and stale evidence explicitly.

## Supplement with sessions and review evidence

When connected Youkai tools are available, discover their current descriptions and use read-only queries. Match each selected local project by **canonical path and machine identity**, not its display name or shared Git remote. Query sessions using that exact local project ID and machine filter where available. A branch or similar title alone is insufficient to associate a session with a task.

Start with one recent page per selected repository. Read histories only for plausible matches or user-linked sessions; use a batch status query for selected session IDs when needed. Follow pagination when the requested coverage needs it. Otherwise state the page/time limits and never describe a partial result as all history. If tools or project identity are unavailable, report that limit and continue with local evidence.

For a session without an explicit run binding, display **candidate association / 候选关联** with its title, link, repository, branch when known, last activity, and the evidence connecting it to the work. An explicit task/run reference is stronger than a title match. Preserve multiple plausible candidates; do not select a winner by recency alone or rewrite the registered task's status from an inferred association.

Read review and check artifacts from helper links, relevant session references, or the repository's established artifact directory. Prefer specific referenced reports over recursive scans. Check that a file exists and identify its recorded branch, HEAD or diff, result, and timestamp where available. File modification time is not proof of when a check ran. An old report stays historical; without matching inputs, say applicability is unknown. An assistant's completion claim is attributed session evidence until supported by actual results.

Deduplicate a session or artifact already linked to a registered task. Label missing artifacts, absent timestamps, mismatched revisions, unverified fixes, and unavailable host observations. Do not fetch Git remotes, dispatch agents, regenerate reports, repeat checks, or write association files while displaying status. Candidate association becomes a binding only through an explicitly invoked Bankai workflow.

## Present the result

Write in the user's language. Lead with the current task's goal, completed work, blockers, and next action. If no task is bound, say so and summarize relevant candidates without inventing a current task. Distinguish a suggested next action from an action you executed.

For `all` or a default query with matching siblings, use a compact table: repository/current marker, branch, task or candidate, recorded status, host observation/owner, blocker or next action. For explicit `current` or a default query with no matching siblings, omit the cross-repository table. Put the most useful plan, check, review, and session links next to the relevant task; use absolute clickable paths for local artifacts. Link additional history rather than dumping logs.

Include the observation time and material coverage limits. Report “no registered task,” “no matching evidence in the queried range,” and “source unavailable” as distinct outcomes. Keep unresolved candidate associations visible without presenting them as confirmed execution state.

Catalog installation supplies the sibling `bankai` helper. Status is read-only; an unregistered repository is reported without creating state.
