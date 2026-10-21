# Session State and Artifact Formats

The coordinator uses `scripts/review_state.py` with Python 3.9+ and the standard library. Use `python3` on macOS/Linux or the installed `python` on Windows. The examples use Bash variable names; on PowerShell use `$SkillRoot` and `$SessionDir` with the same arguments. Reviewers never update state.

## Commands

Write a non-empty snapshot JSON object containing resolved scope, pinned target/head/base refs and SHAs, relevant working-tree fingerprints, requirements fingerprint and review options/reviewer-definition fingerprints. Exclude generated session artifacts. For a verified empty comparison, set `empty_diff: true` in this snapshot; this allows empty reviewer assignments without fabricating work. Do not set it for a missing/failed diff. The helper compares this object exactly; the coordinator is responsible for computing the actual fingerprints.

```bash
python3 "$SKILL_ROOT/scripts/review_state.py" init --session "$SESSION_DIR" --snapshot "$SESSION_DIR/snapshot.json"
python3 "$SKILL_ROOT/scripts/review_state.py" status --session "$SESSION_DIR"
python3 "$SKILL_ROOT/scripts/review_state.py" paths --session "$SESSION_DIR"
python3 "$SKILL_ROOT/scripts/review_state.py" plan --session "$SESSION_DIR" --kind reviewers --input "$SESSION_DIR/reviewers.json"
python3 "$SKILL_ROOT/scripts/review_state.py" complete --session "$SESSION_DIR" --phase 4
```

`init` creates round 1 by default; use `--round N` for a known existing round. It never increments the round automatically. Repeating init requires the same snapshot and round. Changed inputs need a new session path.

`plan` registers assignments before dispatch; `paths` then returns absolute canonical report paths. Register batches with `--kind batches --input <batch-plan.json>`. Once a plan has artifacts or a downstream phase is complete, changing it requires a new session. Identical registration is idempotent.

After writing each phase's artifacts, use `complete --phase N`. The helper validates those artifacts before recording DONE. It does not execute phases or infer that evidence is correct. `status` rechecks DONE checkpoints, downgrades missing/invalid ones and regenerates `PROGRESS.md`. State/progress writes use atomic file replacement. Only one coordinator may mutate a session at a time.

For legacy sessions, first compare saved scope/code/requirements/options with the current snapshot. Initializing a matching session preserves the old progress as `PROGRESS.legacy.md`. Register the saved team assignments and batch mapping, adopt valid existing artifacts with `complete`, and recover only missing work. Keep legacy Markdown verification reports as evidence; normalize their per-finding verdicts into the new batch JSON without dispatching a new verifier just to change the format. A wrong-named file must be inspected and moved to the exact canonical path; the helper never guesses which file to rename.

## Reviewer Assignments

Save a JSON array and register it before Phase 4. Repeated personas get different risk assignments. Explicitly record overlaps and coverage gaps in `context.md`.

```json
[
  {"id":"principal-1","risk":"behavior and requirements","paths":["src/load.ts"],"checks":["cancellation preserves caller state"],"exclusions":["database write contracts owned by principal-2"]},
  {"id":"principal-2","risk":"cross-layer contracts","paths":["src/db/write.ts"],"checks":["all writers share the same serialization boundary"],"exclusions":["UI presentation owned by frontend-1"]}
]
```

IDs use lowercase letters/digits/hyphens and a numeric instance suffix. The helper uses IDs for filenames, not arbitrary caller-provided paths. Every instance remains independent and may read necessary boundary code.

## Candidate Ledger

The Phase 5 path returned by `paths` is `rounds/round-N/findings.json`. Store a JSON array, including excluded/uncertain candidates and their original source references. Keep IDs stable through deduplication and verification.

```json
[
  {"id":"F1","sources":["principal-1:1"],"category":"bug","severity":"blocker","status":"UNVERIFIED","location":"src/load.ts:42-48","trigger":"cancel after response arrival","impact":"an obsolete result overwrites the active state","evidence":["src/load.ts:42-48"],"title":"Cancelled request can overwrite active state"},
  {"id":"F2","sources":["quality-1:2"],"category":"style","severity":"low","status":"EXCLUDED","location":"src/load.ts:12","reason":"naming preference with no documented failure consequence"}
]
```

- Meaningful categories: `bug`, `security`, `data-loss`, `regression`, `performance`, `contract`.
- Severity: `blocker`, `high`, `medium`, `low`. Low-impact items remain in artifacts.
- Initial status: `CONFIRMED`, `UNVERIFIED`, `EXCLUDED`. CONFIRMED requires checked trigger, impact and evidence. EXCLUDED needs a reason. The helper cannot judge whether prose/code evidence is true.
- Record pre-existing findings as excluded with a reason unless the reviewed change introduces/exposes their failure path.
- A raw CONFIRMED blocker still requires independent batch confirmation before publication as blocking.

## Verification Batches

Group by shared call chain, state owner or lifecycle, not by source reviewer. Register the plan; the helper rejects unknown IDs or assignment of the same finding to multiple batches.

```json
[{"id":"batch-1","finding_ids":["F1","F3"],"scope":"load cancellation and state commit"}]
```

The helper returns `rounds/round-N/verifications/batch-1.json`. The verifier writes one JSON object per assigned finding in an array:

```json
[
  {"id":"F1","verdict":"CONFIRMED","evidence":["src/load.ts:42-48 bypasses the cancellation guard in src/state.ts:91"]},
  {"id":"F3","verdict":"UNVERIFIED","evidence":[],"reason":"caller ownership contract could not be established"}
]
```

Other verdicts: `FALSE_ALARM` with evidence of an existing protection; `REFINED` with evidence and a corrected `description`. A verifier may supply an evidence-backed `severity` (`blocker`, `high`, `medium`, `low`); synthesis uses it instead of the original proposal. Do not use `CONFIRMED (unverified)`. Missing batch results are not confirmation: after the permitted recovery attempt, write explicit UNVERIFIED records and preserve the failure reason. Keep partial originals before replacing them.

Write `verification-summary.md` with per-ID conclusions, source links and uncertainty counts. With no dispatched batches, register `[]` and write the skip reason. The helper still checks the summary artifact. Proposed blockers remain unresolved when verification is skipped.

## Final Decision

Write both `final.md` and `decision.json` to the returned Phase 7 paths. The machine decision records which IDs the prose publishes; it must agree with the prose and evidence ledger.

```json
{"verdict":"REQUEST_CHANGES","finding_ids":["F1"],"unverified_ids":["F3"]}
```

The helper combines ledger entries with batch verdicts and checks that published/unverified ID sets are complete and disjoint. Excluded/low-impact/pure-style items and false alarms stay out of the main findings list. It requires independent batch evidence for blockers.

- Confirmed blocker → `REQUEST_CHANGES`, with remaining uncertainty stated separately.
- No confirmed blocker and unresolved meaningful candidates → `INCOMPLETE`.
- Confirmed meaningful non-blocking issues without unresolved candidates → `FINDINGS`.
- No meaningful confirmed/unresolved issues and all assigned reviewer reports present → `NO_FINDINGS`.

A partial report may be written early as INCOMPLETE. The session is complete only when all active checkpoints are DONE; a missing checkpoint cannot be replaced by a clean final verdict.
