---
name: ultra-simplify
description: Use when the user asks for a massive simplification pass: LOC down 40%+, god files split, helpers unified, if-chains flattened, PRs delivered.
---

# Ultra Simplify

Run an autonomous, whole-codebase simplification sprint. The deliverable is a PR or a set of PRs, not a plan, not a proposal, not a list of things you would do.

## Mandate

Non-negotiable requirements, in the user's own words:

- LOC drops dramatically. Minimum 40% overall. This is a floor, not a stretch goal.
- God files get broken up.
- Simplification happens across the board, not only in the easy corners.
- Helpers and methods that can be reused get unified.
- if-if-if-if-if-if-else routing goes away.
- Code legibility goes up.
- Interpretability of the codebase and how things connect to each other goes up.
- Elegance.
- Superfluous excess bloat code gets cleaned up and removed.
- It all gets done fully. No excuses. No waiting for the user's decisions.

You have full authority to make every simplification decision yourself. Record what you decided and why in the PR description instead of asking mid-run.

## Ground Rules

- Behavior is preserved. Public CLI contracts, documented APIs, and tests keep working. If a behavior must change to hit the target, do the simplification without it first, then flag the behavior change as a follow-up PR.
- Verification gates are mandatory: typecheck, test suite, and build must all pass before delivery.
- The LOC target is measured on source code, excluding lockfiles, generated files, and vendored third-party assets. Report the measurement command so the number is reproducible.

## Workflow

1. Baseline. Record current LOC with a reproducible command (`git ls-files | grep -E '\.(ts|tsx|js|mjs|py)$' | xargs wc -l` or `cloc`). Run typecheck, tests, and build once to confirm the repo is green before you touch anything.
2. Inventory. Rank files by size to find god files. Grep for duplicated helper names and near-identical functions. Hunt for deep if/else chains, dead code, commented-out code, and over-abstraction layers that forward calls without adding logic.
3. Plan the cut. List every intended change with its estimated LOC reduction. Order by risk (lowest first) so early commits protect later ones.
4. Execute. One theme per commit or per branch. Keep tests green between steps; when they break, fix before moving on.
5. Measure again. If overall reduction is below 40%, go back to step 2 and find more. Do not deliver under target.
6. Deliver. Open a single monolithic PR, or a set of PRs ordered so each one is independently mergeable. The PR description must include: before/after LOC with the measurement command, the list of simplifications, and any decisions you made autonomously.

## Tactics

- God files: split by responsibility into modules with one job each. Move shared logic to the package that already owns that concern.
- Duplicated helpers: merge into one canonical implementation in the shared layer; delete the copies.
- if-if-if-else chains: replace with lookup tables, maps from key to handler, early returns, or polymorphism. Routing on shape should read as data, not as nested branches.
- Bloat: delete dead exports, unused parameters, defensive checks for impossible states, wrappers that only forward arguments, and abstractions with a single caller.
- Legibility: rename to what the thing does. Delete indirection layers that exist only to look enterprise. Prefer one obvious file over five clever ones.

## Done Means

- Overall LOC reduction ≥ 40%, measured and reported.
- Typecheck, tests, and build all green on the final state.
- PR or PR set opened, each described and independently reviewable.

Anything less is not done. Keep working.
