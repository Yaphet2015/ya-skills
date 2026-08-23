---
name: coding-recon
description: Use when implementing a non-trivial feature, fixing a non-obvious bug, refactoring unfamiliar code, changing behavior across modules, or when repository evidence could materially change the implementation.
---

# Coding Recon

## Overview

Gather only evidence that can change the target, approach, constraints, or verification.

## When to Use

Use Recon when unclear ownership, contracts, precedent, callers, or root causes could change the implementation.

Skip Recon when the exact location and edit are known, the change is fully local, and no material contract is uncertain.

## Recon Loop

### 1. Frame one uncertainty

State one decision-changing question. Do not start with a list of files to read.

### 2. Choose the cheapest discriminating observation

| Question | Start with |
| --- | --- |
| Where is behavior owned? | Symbol/reference search, then implementation and callers |
| What contract applies? | Types, tests, public interfaces, relevant configuration |
| What precedent exists? | One nearby implementation and its tests |
| Which root cause fits? | Competing hypotheses and a separating diagnostic |

Before each tool action, know its question and possible decision impact. Use history only when intent matters. Broaden only when targeted evidence fails.

### 3. Update the hypothesis

Classify each uncertainty as resolved, narrowed, or contradicted. Revise the likely target or approach, then choose the next material uncertainty.

Evidence contains only facts observed in code, tests, configuration, or history. Otherwise write exactly `Evidence: none collected`; move everything else to `Open uncertainty`.

For bugs, use `hypotheses → discriminating evidence → root cause`, not `error → guess → patch → retry`.

### 4. Stop on decision sufficiency

Stop when ownership, relevant contracts, the approach, and verification are clear, and remaining uncertainty is unlikely to change the decision.

## Handoff Contract

Recon is complete only when this brief exists:

```text
Target: <where the change belongs, or unknown>
Evidence: <observed repository facts, or none collected>
Constraints: <contracts and invariants to preserve>
Approach: <smallest implementation supported by the evidence>
Verification: <specific checks that can disprove correctness>
Open uncertainty: none | <remaining material unknowns or hypotheses>
```

For an investigation- or plan-only request, the response is exactly this brief and ends after `Open uncertainty`. For an implementation request, use it as the checkpoint before editing. Contradictory verification returns the task to Recon.

Ask the user only for intent or facts the repository cannot determine.

## Example

For a new monorepo command, search registration and inspect one tested sibling. Stop when ownership and contract agree.

## Common Mistakes

| Mistake | Correction |
| --- | --- |
| Reading every related file | Start from one uncertainty. |
| Asking the user where code lives | Search first; ask only about intent. |
| Accepting the first plausible cause | Compare hypotheses with separating evidence. |
| Continuing after the decision is stable | Produce the brief and stop. |
| Implementing a plan-only request | Return the brief and wait. |
