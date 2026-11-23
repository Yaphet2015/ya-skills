import json
import sys
import tomllib
from pathlib import Path

import tomli_w
from harbor.models.trial.result import TrialResult


def configure(path, agent_image, verifier_image):
    config = tomllib.loads(path.read_text())
    environment = config.setdefault("environment", {})
    verifier = config.setdefault("verifier", {})
    if config.get("steps") or environment.get("os", "linux") != "linux":
        raise ValueError("PBench requires a single-step Linux task")
    verifier["environment_mode"] = "separate"
    verifier_environment = verifier.setdefault("environment", {})
    if agent_image:
        environment["docker_image"] = agent_image
        verifier_environment["docker_image"] = verifier_image
    else:
        environment.pop("docker_image", None)
        verifier_environment.pop("docker_image", None)

    path.write_text(tomli_w.dumps(config))


def summarize(root):
    results = []
    for path in sorted(root.glob("*/result.json")):
        trial = TrialResult.model_validate_json(path.read_text())
        inputs, _, outputs, cost = trial.compute_token_cost_totals()
        model = trial.agent_info.model_info
        start = trial.started_at
        end = trial.finished_at
        results.append({
            "id": str(trial.id),
            "directory": str(path.parent),
            "agentVersion": trial.agent_info.version,
            "model": "/".join(filter(None, [model.provider, model.name])) if model else None,
            "rewards": trial.verifier_result.rewards if trial.verifier_result else {},
            "rewardValid": trial.reward_valid,
            "error": trial.exception_info.exception_type if trial.exception_info else None,
            "durationMs": round((end - start).total_seconds() * 1000) if start and end else None,
            "inputTokens": inputs,
            "outputTokens": outputs,
            "costUsd": cost,
        })
    print(json.dumps(results))


command, path, *args = sys.argv[1:]
if command == "configure":
    configure(Path(path), *args)
elif command == "summarize":
    summarize(Path(path))
