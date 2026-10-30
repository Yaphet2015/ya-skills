#!/usr/bin/env python3
"""Bankai task engine: evidence, ownership, handoffs and interruption recovery."""


import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import quote
import uuid


ROLES = ('planner', 'builder', 'worker', 'challenger', 'ultraviewer', 'verifier', 'e2e-tester', 'hook')
LEAD_ROLES = ('planner', 'builder', 'verifier', 'ultraviewer', 'hook')
STATUSES = ('completed', 'needs_decision', 'needs_changes', 'blocked')
ACTIVE = ('prepared', 'running')
MAX_DELIVERIES = 2


class DeliveryError(ValueError):
    """Missing or invalid receipt, distinct from implementation failure."""


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def path_segment(value):
    if not isinstance(value, str) or not value.strip() or value in ('.', '..'):
        raise ValueError('Project and branch names must be nonempty path segments')
    return quote(value, safe='')


def project_identity(repo):
    # A display label is independent of language manifests and repository identity.
    return Path(repo).name or 'repository', 'git root'


def output_path(run, raw):
    path = Path(raw)
    if not path.is_absolute():
        raise ValueError('Output paths must be absolute')
    path = path.resolve()
    reports = Path(read(run / 'state.json')['reports']).resolve()
    if not (path.is_relative_to(run.resolve()) or path.is_relative_to(reports)):
        raise ValueError('Output must be inside this run logs or reports')
    return path


def destination_rules(target):
    instructions = []
    for ancestor in (*reversed(target.parents), target):
        path = ancestor / 'AGENTS.md'
        try:
            content = path.read_text()
        except FileNotFoundError:
            continue
        instructions.append({'path': str(path), 'content': content})
    return instructions


def create_run(args):
    repo = Path(args.repo).resolve()
    required = args.require_skill
    check = preflight(repo, args.skill_root, required)
    if not check['ok']:
        print(json.dumps(check, ensure_ascii=False))
        return 2
    if not args.dependencies_checked:
        raise ValueError('Complete documented dependency and native-subagent capability checks before init')
    project, source = project_identity(repo)
    try:
        branch = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').decode().strip()
    except subprocess.CalledProcessError:
        branch = 'detached-' + git(repo, 'rev-parse', '--short', 'HEAD').decode().strip()
    baseline = snapshot(repo)
    run_id = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    root = Path(args.root).expanduser().resolve()
    if root.is_relative_to(repo):
        raise ValueError('Keep pipeline logs and reports outside the target repository')
    run = root / 'logs' / run_id
    reports = root / 'reports' / path_segment(project) / path_segment(branch) / run_id
    # Read destination rules before creating any output. Main checks native tools separately.
    instruction_paths = []
    for target in (run, reports):
        for rule in destination_rules(target):
            if rule['path'] not in instruction_paths:
                instruction_paths.append(rule['path'])
    run.mkdir(parents=True)
    reports.mkdir(parents=True)
    save_baseline(repo, run)
    shutil.copytree(Path(__file__).resolve().parent.parent, run / 'skill',
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    state = {'run_id': run_id, 'project': project, 'project_source': source,
          'branch': branch, 'repo': str(repo), 'root': str(root), 'logs': str(run), 'reports': str(reports),
          'instruction_paths': instruction_paths, 'leader': args.leader, 'goal': args.goal,
          'baseline': baseline, 'preflight': check, 'protocol_version': 3,
          'helper': str(run / 'skill/scripts/pipeline.py')}
    state['profile'] = 'bankai'
    write(run / 'state.json', state)
    return run


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE)


def snapshot(repo):
    """Include staged, unstaged and untracked content, including dirty baseline."""
    head = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--verify', 'HEAD'], capture_output=True).stdout.strip()
    status = git(repo, 'status', '--porcelain=v1', '-z')
    digest = hashlib.sha256(head)
    digest.update(status)
    digest.update(git(repo, 'diff', '--cached', '--binary'))
    digest.update(git(repo, 'diff', '--binary'))
    for raw in git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0'):
        if raw:
            path = Path(repo) / os.fsdecode(raw)
            digest.update(raw)
            digest.update(os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes())
    return {'head': head.decode(),
            'status': status.decode(errors='replace'), 'fingerprint': digest.hexdigest()}


def preflight(repo, extra_roots=(), required=()):
    roots = [repo / '.agents/skills', repo / '.claude/skills', repo / '.coldx/skills', repo / '.codex/skills', repo / '.logoscode/skills']
    roots += [Path.home() / name for name in ('.agents/skills', '.claude/skills', '.coldx/skills', '.codex/skills', '.logoscode/skills', '.bangboo/agent/skills')]
    if os.environ.get('CODEX_HOME'):
        roots.append(Path(os.environ['CODEX_HOME']) / 'skills')
    roots += [Path(p).expanduser().resolve() for p in extra_roots]
    found = {}
    for root in roots:
        if root.is_dir():
            # Explicit children include installed skill directories that are symlinks.
            candidates = set(root.rglob('SKILL.md'))
            candidates.update(child / 'SKILL.md' for child in root.iterdir() if (child / 'SKILL.md').is_file())
            for path in sorted(candidates):
                found.setdefault(path.parent.name, str(path.resolve()))
    missing = []
    resolved = {}
    pending = list(required)
    while pending:
        name = pending.pop(0)
        if name in resolved or name in missing:
            continue
        if name not in found:
            missing.append(name)
            continue
        resolved[name] = found[name]
        manifest = Path(found[name]).with_name('skill.json')
        if manifest.exists():
            deps = read(manifest).get('dependsOn', [])
            if not isinstance(deps, list) or any(not isinstance(x, str) for x in deps):
                raise ValueError(f'Invalid dependsOn: {manifest}')
            pending.extend(deps)
    cli = {name: shutil.which(name) for name in ('git', 'python3')}
    return {'ok': not missing and all(cli.values()), 'missing_skills': missing,
            'missing_tools': [k for k, v in cli.items() if not v], 'skills': resolved, 'tools': cli,
            'manual_checks': ['Main can create, message and observe native subagents sharing the run files', 'Read resolved skills for additional required dependencies', 'Task-specific tools, permissions and test targets']}


def save_baseline(repo, run):
    baseline = run / 'baseline'
    baseline.mkdir()
    (baseline / 'index.patch').write_bytes(git(repo, 'diff', '--cached', '--binary'))
    (baseline / 'worktree.patch').write_bytes(git(repo, 'diff', '--binary'))
    untracked = {}
    for raw in git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0'):
        if not raw:
            continue
        source = Path(repo) / os.fsdecode(raw)
        key = hashlib.sha256(raw).hexdigest()
        if source.is_symlink():
            untracked[os.fsdecode(raw)] = {'symlink': os.readlink(source)}
        else:
            shutil.copyfile(source, baseline / key)
            untracked[os.fsdecode(raw)] = {'copy': key}
    write(baseline / 'untracked.json', untracked)


@contextlib.contextmanager
def task_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Task already running') from None
        yield


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', value):
        raise ValueError('IDs must be safe single path segments')
    return value


def unit_dir(run, unit):
    return run / 'units' / safe_id(unit)


def attempt_path(run, attempt):
    path = Path(attempt).resolve()
    relative = path.relative_to((run / 'tasks').resolve())
    if len(relative.parts) != 2 or not re.fullmatch(r'attempt-\d+', relative.parts[1]):
        raise ValueError('Expected a task attempt inside this run')
    if not (path / 'execution.json').is_file():
        raise ValueError('Attempt does not exist')
    return path


def evidence_hashes(paths):
    hashes = {}
    for raw in paths:
        path = Path(raw)
        if not path.is_absolute() or not path.is_file():
            raise ValueError(f'Evidence missing or not absolute: {raw}')
        hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def check_evidence(hashes, message, error_type=ValueError):
    if evidence_hashes(hashes) != hashes:
        raise error_type(message)


def corrections(run, unit):
    path = unit_dir(run, unit) / 'corrections.json'
    return read(path) if path.exists() else {}


def applicable_corrections(run, record):
    return {issue: entry for issue, entry in corrections(run, record['unit']).items()
            if not entry.get('retracted_at') and not entry.get('accepted_at')
            and (entry.get('task_id') is None or entry['task_id'] == record['task_id'])}


def check_corrections(run, attempt, output):
    record = read(attempt / 'execution.json')
    if not record.get('unit'):
        return
    path = attempt / 'acknowledgements.json'
    received = read(path) if path.exists() else {}
    for issue, correction in applicable_corrections(run, record).items():
        resolution = output.get('corrections', {}).get(issue, {})
        if (received.get(issue) != correction['revision'] or resolution.get('revision') != correction['revision']
                or not resolution.get('evidence')):
            raise DeliveryError(f'Unacknowledged or unresolved correction: {issue} revision {correction["revision"]}')
        evidence_hashes(resolution['evidence'])


def check_task(attempt, record):
    actual = hashlib.sha256((attempt / 'task.md').read_bytes()).hexdigest()
    if record.get('task_hash') != actual:
        raise ValueError('Startup task changed; publish a correction and deliver through a new attempt')


def dependency_receipts(run, task_ids):
    receipts = []
    for task_id in task_ids:
        attempt = latest_attempt(run, task_id)
        record = read(attempt / 'execution.json') if attempt else {}
        if record.get('status') != 'completed' or not record.get('accepted_at'):
            raise ValueError(f'Dependency not accepted: {task_id}')
        check_task(attempt, record)
        check_evidence(record['evidence_hashes'], f'Dependency evidence changed: {task_id}')
        check_corrections(run, attempt, read(attempt / 'result.json'))
        receipts.append({'task_id': task_id, 'attempt': str(attempt), 'accepted_at': record['accepted_at']})
    return receipts


def check_dependencies(run, record):
    expected = record.get('dependencies', [])
    actual = dependency_receipts(run, [entry['task_id'] for entry in expected])
    if actual != expected:
        raise ValueError('Dependency acceptance changed since preparation; recheck integration evidence')


def accept(run, task_id, review=None):
    attempt = latest_attempt(run, task_id)
    if not attempt:
        raise ValueError('No attempt to accept')
    with task_lock(attempt.parent):
        record = read(attempt / 'execution.json')
        if record['status'] != 'completed':
            raise ValueError('Only a completed result can be accepted')
        check_task(attempt, record)
        check_dependencies(run, record)
        check_evidence(record['evidence_hashes'], 'Delivery evidence changed since completion; recheck and deliver again')
        current = snapshot(read(run / 'state.json')['repo'])
        if current['fingerprint'] != record['after_snapshot']['fingerprint']:
            if review is None:
                raise ValueError('Workspace changed since result; supply a stage-owner --review after rechecking evidence')
            review_path = output_path(run, review)
            assessment = read(review_path)
            if (assessment.get('attempt') != str(attempt)
                    or assessment.get('fingerprint') != current['fingerprint']
                    or not assessment.get('evidence')):
                raise ValueError('Review must bind this attempt, current fingerprint and recheck evidence')
            reviewed_files = [str(output_path(run, path)) for path in assessment['evidence']]
            record['evidence_hashes'].update(evidence_hashes([str(review_path), *reviewed_files]))
            record.setdefault('reviews', []).append({'path': str(review_path), 'previous_snapshot': record['after_snapshot']})
            record['after_snapshot'] = current
        directory = unit_dir(run, record['unit']) if record.get('unit') else attempt
        with task_lock(directory / 'control'):
            output = read(attempt / 'result.json')
            check_corrections(run, attempt, output)
            evidence_hashes(output['artifacts'])
            now = record.get('accepted_at') or time.time()
            if record.get('unit'):
                entries = corrections(run, record['unit'])
                for issue in applicable_corrections(run, record):
                    entries[issue].update(accepted_at=now, accepted_by=str(attempt))
                write(directory / 'corrections.json', entries)
            record['accepted_at'] = now
            write(attempt / 'execution.json', record)


def latest_attempt(run, task_id):
    paths = sorted((run / 'tasks' / safe_id(task_id)).glob('attempt-*/execution.json'))
    return paths[-1].parent if paths else None


def active_attempt(run, attempt):
    attempt = attempt_path(run, attempt)
    record = read(attempt / 'execution.json')
    if record['status'] not in ACTIVE or latest_attempt(run, record['task_id']) != attempt:
        raise ValueError('Operation requires the current active attempt')
    return attempt, record


def notification(attempt):
    record = read(attempt / 'execution.json')
    value = {key: record[key] for key in ('task_id', 'role', 'status', 'agent_id', 'previous_agent_id',
                                        'parent_task_id', 'accepted_at', 'mode')
             if record.get(key) is not None}
    value.update(attempt=str(attempt), task=str(attempt / 'task.md'), result=str(attempt / 'result.json'))
    for name in ('checkpoint', 'handoff', 'recovery'):
        path = attempt / f'{name}.json' if name != 'handoff' else attempt / 'handoff.md'
        if path.is_file():
            value[name] = str(path)
    return value


def parse_requests(run, paths):
    tasks = []
    hashes = {}
    for raw in paths:
        path = output_path(run, raw)
        data = read(path)
        if not isinstance(data, dict) or not isinstance(data.get('tasks'), list):
            raise ValueError('Dispatch file requires a tasks array')
        hashes.update(evidence_hashes([str(path)]))
        for item in data['tasks']:
            if not isinstance(item, dict) or item.get('role') not in ROLES:
                raise ValueError('Dispatch task requires a known role')
            safe_id(item.get('task_id', ''))
            prompt = output_path(run, item['prompt_path'])
            hashes.update(evidence_hashes([str(prompt)]))
            after = item.get('after', [])
            if not isinstance(after, list):
                raise ValueError('Dispatch dependencies must be an array')
            for task_id in after:
                safe_id(task_id)
            if item.get('unit'):
                safe_id(item['unit'])
            tasks.append({'task_id': item['task_id'], 'role': item['role'], 'prompt_path': str(prompt),
                          'unit': item.get('unit'), 'after': after})
    if len({item['task_id'] for item in tasks}) != len(tasks):
        raise ValueError('Duplicate dispatched task ID')
    return tasks, hashes


def checkpoint(run, attempt, summary, next_action, evidence, handoff=None, requests=(), references=()):
    attempt, record = active_attempt(run, attempt)
    if not summary.strip() or not next_action.strip():
        raise ValueError('Checkpoint requires completed facts and a concrete next action')
    for path in evidence:
        output_path(run, path)
        if Path(path).name in ('task.md', 'execution.json', 'checkpoint.json', 'progress.json', 'run.log'):
            raise ValueError('Control files and raw agent logs are not progress evidence')
    with task_lock(attempt / 'control'):
        path = attempt / 'checkpoint.json'
        old = read(path) if path.exists() else {'snapshot': record['snapshot'], 'seen_evidence_hashes': [],
                                              'last_progress_at': record['started_at']}
        current = snapshot(read(run / 'state.json')['repo'])
        hashes = evidence_hashes(evidence)
        seen = set(old['seen_evidence_hashes'])
        advanced = current['fingerprint'] != old['snapshot']['fingerprint'] or bool(set(hashes.values()) - seen)
        saved = {**old, 'task': str(attempt / 'task.md'), 'result': str(attempt / 'result.json'),
                 'summary': summary, 'next_action': next_action, 'snapshot': current,
                 'evidence': hashes, 'seen_evidence_hashes': sorted(seen | set(hashes.values())),
                 'updated_at': time.time(), 'last_progress_at': time.time() if advanced else old['last_progress_at']}
        if handoff is not None:
            handoff = output_path(run, handoff)
            if handoff != attempt / 'handoff.md' or not handoff.read_text().strip():
                raise ValueError('Write this attempt handoff.md before publishing the checkpoint')
            tasks, dispatch_hashes = parse_requests(run, requests)
            if record['task_id'] in {item['task_id'] for item in tasks}:
                raise ValueError('A phase owner cannot dispatch itself')
            saved.update(handoff=str(handoff), handoff_hashes=evidence_hashes([str(handoff)]),
                         requests=[str(Path(item).resolve()) for item in requests],
                         dispatch_hashes=dispatch_hashes,
                         references=evidence_hashes(map(str, references)))
        elif requests or references:
            raise ValueError('Dispatch and recovery references require a full handoff')
        write(path, saved)
    return notification(attempt)


def check_handoff(run, attempt, required=True):
    path = attempt / 'checkpoint.json'
    saved = read(path) if path.is_file() else {}
    if not saved.get('handoff'):
        if required:
            raise DeliveryError('Full handoff.md and checkpoint are required before ending this turn')
        return None
    for key in ('handoff_hashes', 'dispatch_hashes'):
        check_evidence(saved[key], 'Published handoff or dispatch input changed', DeliveryError)
    output_path(run, saved['handoff'])
    return saved


def dispatch_requests(run, attempt):
    attempt = attempt_path(run, attempt)
    record = read(attempt / 'execution.json')
    if record['status'] not in ('needs_decision', 'completed'):
        raise ValueError('Dispatch requires a collected owner receipt and a released turn')
    check_evidence(record['evidence_hashes'], 'Owner receipt or evidence changed')
    saved = check_handoff(run, attempt)
    tasks, _ = parse_requests(run, saved.get('requests', []))
    return tasks


def child_results(run, parent_attempt):
    parent_attempt = str(Path(parent_attempt).resolve())
    children = []
    for directory in sorted((run / 'tasks').glob('*')):
        paths = sorted(directory.glob('attempt-*/execution.json'))
        if paths and read(paths[-1]).get('parent_attempt') == parent_attempt:
            children.append(notification(paths[-1].parent))
    return children


def recovery_files(run, prior):
    record = read(prior / 'execution.json')
    if record['status'] in ACTIVE:
        raise ValueError('Confirm the previous agent ended before recovery')
    check_task(prior, record)
    saved = check_handoff(run, prior)
    check_evidence(record.get('evidence_hashes') or {}, 'Previous receipt or evidence changed; inspect before recovery')
    tasks, _ = parse_requests(run, saved.get('requests', []))
    children = child_results(run, prior)
    states = {item['task_id']: item for item in children}
    if any(item['task_id'] not in states or states[item['task_id']]['status'] in ACTIVE for item in tasks):
        raise ValueError('Dispatched children are still pending; recover after their completion or reconciliation')
    for child in children:
        child_record = read(Path(child['attempt']) / 'execution.json')
        hashes = child_record.get('evidence_hashes', {})
        check_evidence(hashes, 'Child receipt or evidence changed before owner recovery')
    changed = []
    for path, digest in saved.get('references', {}).items():
        if not Path(path).is_file() or evidence_hashes([path])[path] != digest:
            changed.append(path)
    return {'source_attempt': str(prior), 'handoff': saved['handoff'],
            'checkpoint': str(prior / 'checkpoint.json'), 'children': children,
            'changed_references': changed, 'workspace_changed':
            snapshot(read(run / 'state.json')['repo'])['fingerprint'] != saved['snapshot']['fingerprint']}


def prepare(run, task_id, role, brief, retry=False, unit=None, after=(), parent_attempt=None,
            prompt_path=None, continue_from=None, redeliver=False, extra=None):
    safe_id(task_id)
    if role not in ROLES or (role == 'builder' and not unit):
        raise ValueError('Known role required; Builder also requires --unit')
    if unit:
        safe_id(unit)
    if task_id in after or sum(bool(x) for x in (retry, continue_from, redeliver)) > 1:
        raise ValueError('Invalid dependency or conflicting recovery modes')
    state = read(run / 'state.json')
    with task_lock(run / 'registry'):
        directory = run / 'tasks' / task_id
        prior = latest_attempt(run, task_id)
        record = read(prior / 'execution.json') if prior else None
        if record and (record['status'] in ACTIVE or not (retry or continue_from or redeliver)):
            raise ValueError('Task already prepared; inspect its host status before retrying')
        if record and (record['unit'] != unit or record['role'] != role):
            raise ValueError('Task role and module cannot change between attempts')
        if (retry or continue_from or redeliver) and not prior:
            raise ValueError('Recovery requires a previous task attempt')
        if role == 'builder':
            for path in (run / 'tasks').glob('*/attempt-*/execution.json'):
                other = read(path)
                if other.get('role') == 'builder' and other.get('unit') == unit and other['status'] in ACTIVE:
                    raise ValueError('Module already has an active Builder')
        recovery = None
        if continue_from:
            if attempt_path(run, continue_from) != prior:
                raise ValueError('Continue from the latest attempt of this same task')
            recovery = recovery_files(run, prior)
        parent_task_id = None
        if parent_attempt:
            parent_attempt = attempt_path(run, parent_attempt)
            parent_task_id = read(parent_attempt / 'execution.json')['task_id']
            requests = dispatch_requests(run, parent_attempt)
            request = next((item for item in requests if item['task_id'] == task_id), None)
            if (not request or request['role'] != role or request['unit'] != unit
                    or prompt_path is None or request['prompt_path'] != str(Path(prompt_path).resolve())
                    or list(after) != request['after'] or brief != Path(prompt_path).read_text()):
                raise ValueError('Child must match its published owner task card and dependencies')
        elif record:
            parent_attempt = record.get('parent_attempt')
            parent_task_id = record.get('parent_task_id')
        if record and (continue_from or redeliver) and not after:
            after = [item['task_id'] for item in record.get('dependencies', [])]
        dependencies = dependency_receipts(run, after)
        before = snapshot(state['repo'])
        prior_hashes = {}
        if redeliver:
            if role != 'builder':
                raise ValueError('Receipt repair requires Builder')
            entries = (read(path) for path in (run / 'tasks').glob('*/attempt-*/execution.json'))
            deliveries = sum(item.get('unit') == unit and item.get('mode') == 'delivery' for item in entries)
            if deliveries >= MAX_DELIVERIES:
                raise ValueError('Receipt repair limit reached; diagnose the delivery failure')
            if (record['status'] != 'completed' and record.get('failure_kind') != 'delivery'):
                raise ValueError('Inspect implementation before repairing only the receipt')
            if record['after_snapshot']['fingerprint'] != before['fingerprint']:
                raise ValueError('Workspace changed since receipt; review implementation first')
            check_dependencies(run, record)
            prior_files = [str(prior / 'execution.json'), str(prior / 'task.md')]
            if (prior / 'result.json').is_file():
                prior_files.append(str(prior / 'result.json'))
            prior_hashes = {**record.get('evidence_hashes', {}), **evidence_hashes(prior_files)}
            check_evidence(prior_hashes, 'Prior receipt or evidence changed')
        attempt = directory / f'attempt-{len(list(directory.glob("attempt-*/execution.json"))) + 1:04d}'
        (attempt / 'artifacts').mkdir(parents=True)
        if recovery:
            write(attempt / 'recovery.json', recovery)
        frozen_outputs = {}
        if redeliver:
            brief += (f'\nReceipt repair only. Prior attempt: {prior}\nReuse completed work. '
                      'Do not edit product code, commit, rerun tests or overwrite prior receipts/evidence.\n')
        if recovery:
            brief += f'\nRestore all working context from {attempt / "recovery.json"} before proceeding.\n'
        brief += (f'\nRead execution contract: {run / "skill/references/execution.md"}\n'
                  f'Run: {run}\nAttempt: {attempt}\n'
                  'The current agent may execute a bounded task. Preserve user changes. '
                  'Check the workspace claim before edits, commands or delegation. '
                  'Write the result, full handoff and evidence before completing this step.\n')
        if unit:
            brief += f'Module: {unit}\nCorrections: {unit_dir(run, unit) / "corrections.json"}\nRead/ack revisions before edits, tests, commit and result; gate before commit.\n'
        (attempt / 'task.md').write_text(brief)
        entry = {'task_id': task_id, 'role': role, 'status': 'prepared', 'unit': unit,
                 'agent_id': None, 'parent_task_id': parent_task_id,
                 'parent_attempt': str(parent_attempt) if parent_attempt else None,
                 'snapshot': before, 'started_at': time.time(), 'dependencies': dependencies,
                 'task_hash': hashlib.sha256((attempt / 'task.md').read_bytes()).hexdigest(),
                 'frozen_outputs': frozen_outputs,
                 **(extra or {})}
        if continue_from:
            entry['continued_from'] = str(prior)
        if redeliver:
            entry.update(mode='delivery', prior_hashes=prior_hashes, resumed_from=str(prior))
        if record:
            entry['previous_agent_id'] = record.get('agent_id')
        write(attempt / 'execution.json', entry)
    return notification(attempt)


def bind(run, attempt, agent_id):
    if not isinstance(agent_id, str) or not agent_id.strip():
        raise ValueError('Use the actual native tool agent ID')
    with task_lock(run / 'registry'):
        attempt, record = active_attempt(run, attempt)
        if record.get('agent_id') and record['agent_id'] != agent_id:
            raise ValueError('This attempt is already bound to another agent')
        for path in (run / 'tasks').glob('*/attempt-*/execution.json'):
            other = read(path)
            if path.parent != attempt and other['status'] in ACTIVE and other.get('agent_id') == agent_id:
                raise ValueError('Native agent is already executing another attempt')
        record.update(agent_id=agent_id, status='running')
        write(attempt / 'execution.json', record)
    return notification(attempt)


def gate(run, attempt):
    attempt = attempt_path(run, attempt)
    record = read(attempt / 'execution.json')
    check_task(attempt, record)
    check_dependencies(run, record)
    check_corrections(run, attempt, read(attempt / 'result.json'))


def read_delivery(run, attempt, record):
    try:
        output = read(attempt / 'result.json')
    except (OSError, ValueError) as error:
        raise DeliveryError('Missing or invalid result.json') from error
    if (not isinstance(output, dict) or output.get('task_id') != record['task_id']
            or output.get('status') not in STATUSES or not isinstance(output.get('summary'), str)
            or not isinstance(output.get('artifacts'), list)):
        raise DeliveryError('Invalid receipt task_id, status, summary or artifacts')
    if not isinstance(output.get('evidence', []), list):
        raise DeliveryError('Receipt evidence must be an array of paths')
    questions = output.get('questions', [])
    if not isinstance(questions, list) or any(not isinstance(item, dict) for item in questions):
        raise DeliveryError('Receipt questions must be an array of objects')
    files = [str(attempt / 'task.md'), str(attempt / 'result.json')]
    for artifact in [*output['artifacts'], *output.get('evidence', [])]:
        files.append(str(output_path(run, artifact)))
    for resolution in output.get('corrections', {}).values():
        for path in resolution.get('evidence', []):
            files.append(str(output_path(run, path)))
    saved = check_handoff(run, attempt, record['role'] in LEAD_ROLES)
    if saved:
        files.extend([str(attempt / 'checkpoint.json'), *saved['handoff_hashes'], *saved['dispatch_hashes']])
    return output, evidence_hashes(files)


def collect(run, attempt):
    attempt = attempt_path(run, attempt)
    with task_lock(attempt.parent):
        record = read(attempt / 'execution.json')
        if record['status'] not in ACTIVE:
            check_evidence(record.get('evidence_hashes') or {}, 'Collected receipt or evidence changed')
            return notification(attempt)
        if not record.get('agent_id'):
            raise ValueError('Bind the actual agent before collecting its result')
        state = read(run / 'state.json')
        try:
            output, hashes = read_delivery(run, attempt, record)
            record.update(status=output['status'], evidence_hashes=hashes)
            if output['status'] == 'completed':
                try:
                    gate(run, attempt)
                except ValueError as error:
                    record.update(status='needs_changes', error=str(error))
                    if isinstance(error, DeliveryError):
                        record['failure_kind'] = 'delivery'
        except (OSError, ValueError, TypeError, AttributeError) as error:
            record.update(status='blocked', failure_kind='delivery', error=str(error))
        record.update(finished_at=time.time(), after_snapshot=snapshot(state['repo']))
        if record.get('mode') == 'delivery':
            if record['after_snapshot']['fingerprint'] != record['snapshot']['fingerprint']:
                record.update(status='needs_changes', failure_kind='workspace_changed', error='Receipt-only repair changed workspace')
            try:
                check_evidence(record['prior_hashes'], 'Prior receipt or evidence was overwritten')
            except (OSError, ValueError) as error:
                record.update(status='needs_changes', failure_kind='delivery_evidence_changed', error=str(error))
        write(attempt / 'execution.json', record)
    return notification(attempt)


def reconcile(run, task_id, reason, agent_ended):
    if not agent_ended or not reason.strip():
        raise ValueError('Confirm native agent termination and inspect side effects before reconciliation')
    attempt = latest_attempt(run, task_id)
    if not attempt:
        raise ValueError('Task does not exist')
    with task_lock(attempt.parent):
        attempt, record = active_attempt(run, attempt)
        record.update(status='blocked', failure_kind='interrupted', reconciliation=reason,
                      finished_at=time.time(), after_snapshot=snapshot(read(run / 'state.json')['repo']))
        write(attempt / 'execution.json', record)
    return notification(attempt)


def brief(run, attempt, offset=0, question_id=None):
    """Opt-in, bounded phase summary; worker notifications never include its body."""
    attempt = attempt_path(run, attempt)
    record = read(attempt / 'execution.json')
    if record['status'] in ACTIVE or offset < 0:
        raise ValueError('Read a collected receipt with a nonnegative offset')
    check_evidence(record.get('evidence_hashes') or {}, 'Receipt or evidence changed')
    output = read(attempt / 'result.json')
    questions = output.get('questions', [])
    if question_id:
        item = next((item for item in questions if item.get('id') == question_id), None)
        if item is None:
            raise ValueError('Question ID not found')
        value = {key: str(item[key])[:600] for key in ('id', 'audience', 'question', 'recommendation') if key in item}
        value['truncated'] = any(len(str(item.get(key, ''))) > 600 for key in value)
        return {'result': str(attempt / 'result.json'), 'question': value}
    summary = str(output.get('summary', ''))
    artifacts = output.get('artifacts', [])
    return {'task_id': record['task_id'], 'status': record['status'], 'result': str(attempt / 'result.json'),
            'summary': summary[:600], 'summary_truncated': len(summary) > 600,
            'questions': [{key: str(item[key])[:80] for key in ('id', 'audience') if key in item}
                          for item in questions[offset:offset + 10]],
            'question_count': len(questions), 'artifacts': artifacts[offset:offset + 10],
            'artifact_count': len(artifacts)}


def main():
    import workflow
    return workflow.main(sys.argv[1:], sys.modules[__name__])


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    sys.exit(main())
