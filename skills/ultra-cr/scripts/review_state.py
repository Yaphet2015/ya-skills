#!/usr/bin/env python3
"""Canonical artifact paths and checkpoints for the ultra-cr coordinator."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile

PHASES = ("0", "1", "2", "3", "4", "5", "5.5", "7", "8")
VERDICTS = {"CONFIRMED", "REFINED", "FALSE_ALARM", "UNVERIFIED"}
CATEGORIES = {"bug", "security", "data-loss", "regression", "performance", "contract"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def safe_path(session, relative):
    path = session / relative
    require(path.resolve().is_relative_to(session), f"Path escapes session: {relative}")
    return path


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".review-state-")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def paths(session, state):
    round_dir = f"rounds/round-{state['round']}"
    relative = {
        "0": [], "1": ["discovered-standards.md"], "2": ["context.md"],
        "3": ["context.md"],
        "4": [f"{round_dir}/reviews/{item['id']}.md" for item in state["reviewers"]],
        "5": [f"{round_dir}/findings.json"],
        "5.5": [f"{round_dir}/verifications/verification-summary.md"] + [
            f"{round_dir}/verifications/{item['id']}.json" for item in state["batches"]
        ],
        "7": [f"{round_dir}/final.md", f"{round_dir}/decision.json"],
        "8": [f"{round_dir}/final.md", f"{round_dir}/decision.json"],
    }
    return {phase: [safe_path(session, name) for name in names] for phase, names in relative.items()}


def records(value, label):
    require(isinstance(value, list), f"{label} must be a list")
    require(all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in value),
            f"{label} requires object records with string IDs")
    require(len({item['id'] for item in value}) == len(value), f"Duplicate IDs in {label}")
    return value


def evidence(value):
    return isinstance(value, list) and bool(value) and all(isinstance(item, str) and item.strip() for item in value)


def findings(session, state):
    items = records(read_json(paths(session, state)["5"][0]), "findings")
    for item in items:
        require(item.get("status") in {"CONFIRMED", "UNVERIFIED", "EXCLUDED"}, "Invalid finding status")
        require(item.get("severity") in {"blocker", "high", "medium", "low"}, "Invalid finding severity")
        require(isinstance(item.get("category"), str), "Missing finding category")
        require(item["category"] in CATEGORIES or item["status"] == "EXCLUDED",
                "Non-defect categories must be explicitly excluded with a reason")
        require(isinstance(item.get("location"), str) and re.search(r":\d+(?:-\d+)?$", item["location"]),
                "Finding requires a file and line")
        if item["status"] == "CONFIRMED":
            require(evidence(item.get("evidence")) and item.get("trigger") and item.get("impact"),
                    "Confirmed finding requires evidence, trigger and impact")
        if item["status"] == "EXCLUDED":
            require(item.get("reason"), "Excluded finding requires a reason")
    return {item["id"]: item for item in items}


def batch_results(session, state):
    result = {}
    for batch, path in zip(state["batches"], paths(session, state)["5.5"][1:]):
        items = records(read_json(path), batch["id"])
        require({item['id'] for item in items} == set(batch["finding_ids"]),
                f"Batch {batch['id']} must return one verdict per assigned finding")
        for item in items:
            require(item.get("verdict") in VERDICTS, "Invalid verification verdict")
            if "severity" in item:
                require(item["severity"] in {"blocker", "high", "medium", "low"}, "Invalid verified severity")
            if item["verdict"] == "UNVERIFIED":
                require(item.get("reason"), "UNVERIFIED requires a reason")
            else:
                require(evidence(item.get("evidence")), "Verification verdict requires evidence")
            if item["verdict"] == "REFINED":
                require(item.get("description"), "REFINED requires a corrected description")
            result[item["id"]] = item
    return result


def validate_decision(session, state):
    ledger = findings(session, state)
    verified = batch_results(session, state)
    confirmed, unresolved, blockers = set(), set(), set()
    for item in ledger.values():
        verification = verified.get(item["id"], {})
        severity = verification.get("severity", item["severity"])
        if item["status"] == "EXCLUDED" or item["category"] not in CATEGORIES or severity == "low":
            continue
        verdict = verification.get("verdict", item["status"])
        # A blocker's author cannot independently establish its blocking status.
        if severity == "blocker" and item["id"] not in verified:
            verdict = "UNVERIFIED"
        if verdict in {"CONFIRMED", "REFINED"}:
            require(item.get("trigger") and item.get("impact"),
                    "Published finding requires a trigger and concrete impact")
            confirmed.add(item["id"])
            if severity == "blocker":
                blockers.add(item["id"])
        elif verdict == "UNVERIFIED":
            unresolved.add(item["id"])
    decision = read_json(paths(session, state)["7"][1])
    require(isinstance(decision, dict), "decision.json must be an object")
    for key, expected in (("finding_ids", confirmed), ("unverified_ids", unresolved)):
        actual = decision.get(key)
        require(isinstance(actual, list) and all(isinstance(item, str) for item in actual)
                and len(actual) == len(set(actual)) and set(actual) == expected,
                f"{key} does not match the evidence ledger")
    expected = "NO_FINDINGS"
    if confirmed:
        expected = "FINDINGS"
    if unresolved:
        expected = "INCOMPLETE"
    if blockers:
        expected = "REQUEST_CHANGES"
    require(decision.get("verdict") == expected, f"Evidence requires verdict {expected}")
    if expected != "INCOMPLETE":
        for phase in ("1", "2", "3", "4", "5.5"):
            validate_phase(session, state, phase)


def validate_phase(session, state, phase):
    if phase in {"3", "4"}:
        require(bool(state["reviewers"]) or state["snapshot"].get("empty_diff") is True,
                "Reviewer assignments have not been registered")
    for path in paths(session, state)[phase]:
        require(path.is_file() and bool(path.read_text(encoding="utf-8").strip()), f"Missing or empty artifact: {path}")
    if phase == "4":
        for path in paths(session, state)[phase]:
            require("## Summary" in path.read_text(encoding="utf-8"), f"Missing reviewer summary: {path}")
    elif phase == "5":
        findings(session, state)
    elif phase == "5.5":
        batch_results(session, state)
    elif phase in {"7", "8"}:
        validate_decision(session, state)


def save(session, state):
    atomic_write(safe_path(session, "state.json"), json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    lines = ["# 审查进度", "", f"当前轮次: {state['round']}", "", "| 阶段 | 状态 |", "|---|---|"]
    lines.extend(f"| {phase} | {state['phases'][phase]} |" for phase in PHASES)
    lines.extend(["", "状态来源: state.json；产物与代码证据仍需分别检查。", ""])
    atomic_write(safe_path(session, "PROGRESS.md"), "\n".join(lines))


def plan(session, state, kind, value):
    items = records(value, kind)
    for item in items:
        require(re.fullmatch(r"[a-z][a-z0-9-]*-\d+", item["id"]), "Invalid artifact ID")
        if kind == "reviewers":
            require(isinstance(item.get("risk"), str) and item["risk"].strip(), "Reviewer requires a risk")
            require(evidence(item.get("paths")) and evidence(item.get("checks")),
                    "Reviewer requires non-empty path and check lists")
    if items == state[kind]:
        return
    affected = "4" if kind == "reviewers" else "5.5"
    require(all(state['phases'][phase] != "DONE" for phase in PHASES[PHASES.index(affected):]),
            "Cannot change a completed plan; use a new session")
    require(not state[kind] or not any(path.exists() for path in paths(session, state)[affected]),
            "Cannot change assignments after artifacts exist; use a new session")
    if kind == "batches":
        ledger = findings(session, state)
        assigned = []
        for item in items:
            ids = item.get("finding_ids")
            require(isinstance(ids, list) and ids and all(isinstance(key, str) and key in ledger for key in ids),
                    "Batch requires known finding IDs")
            assigned.extend(ids)
        require(len(assigned) == len(set(assigned)), "A finding belongs to exactly one verification batch")
    state[kind] = items
    for names in paths(session, state).values():
        for path in names:
            path.parent.mkdir(parents=True, exist_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "plan", "paths", "status", "complete"))
    parser.add_argument("--session", required=True)
    parser.add_argument("--snapshot")
    parser.add_argument("--round", type=int, default=1)
    parser.add_argument("--kind", choices=("reviewers", "batches"))
    parser.add_argument("--input")
    parser.add_argument("--phase", choices=PHASES)
    args = parser.parse_args()
    session = Path(args.session).resolve()
    session.mkdir(parents=True, exist_ok=True)
    state_path = safe_path(session, "state.json")
    if state_path.exists():
        state = read_json(state_path)
        require(state.get("version") == 1, "Unsupported review state version")
    else:
        require(args.command == "init" and args.snapshot, "Initialize state with --snapshot first")
        require(args.round > 0, "Round must be positive")
        state = {"version": 1, "round": args.round, "snapshot": read_json(args.snapshot),
                 "reviewers": [], "batches": [], "phases": {phase: "NOT_STARTED" for phase in PHASES}}
        require(isinstance(state["snapshot"], dict) and state["snapshot"], "Snapshot must be a non-empty object")
        state["phases"]["0"] = "DONE"
        progress = safe_path(session, "PROGRESS.md")
        if progress.exists():
            backup = safe_path(session, "PROGRESS.legacy.md")
            require(not backup.exists(), "Legacy progress backup already exists")
            atomic_write(backup, progress.read_text(encoding="utf-8"))
        for names in paths(session, state).values():
            for path in names:
                path.parent.mkdir(parents=True, exist_ok=True)
    errors = {}
    if args.command == "init":
        require(args.snapshot and state["snapshot"] == read_json(args.snapshot) and state["round"] == args.round,
                "Snapshot or round changed; use a new session")
    elif args.command == "plan":
        require(args.kind and args.input, "plan requires --kind and --input")
        plan(session, state, args.kind, read_json(args.input))
    elif args.command == "complete":
        require(args.phase, "complete requires --phase")
        validate_phase(session, state, args.phase)
        state["phases"][args.phase] = "DONE"
    elif args.command == "status":
        for phase in PHASES:
            if state["phases"][phase] == "DONE":
                try:
                    validate_phase(session, state, phase)
                except (OSError, ValueError) as error:
                    state["phases"][phase] = "NOT_STARTED"
                    errors[phase] = str(error)
    save(session, state)
    output = paths(session, state) if args.command == "paths" else state
    if args.command == "status":
        output = {**state, "validation_errors": errors}
    print(json.dumps(output, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
