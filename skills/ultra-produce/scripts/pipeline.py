#!/usr/bin/env python3
"""File contracts for native subagents. Main owns dispatch and stage acceptance."""
import argparse
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

REQUIRED = ('brainstorming', 'grill-with-docs', 'simplify', 'ultra-cr', 'eli10', 'computer-e2e', 'show-pr')
ROLES = ('planner', 'builder', 'worker', 'challenger', 'ultraviewer', 'verifier', 'e2e-tester', 'hook')
LEAD_ROLES = ('planner', 'builder', 'verifier', 'ultraviewer', 'hook')
HOOKS = ('before-plan', 'after-plan', 'before-impl', 'after-impl', 'before-verify', 'after-verify', 'before-finish')
DEFAULT_HOOKS = ('after-plan', 'after-verify', 'before-finish')
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


def project_identity(repo, project_name=None, project_file=None):
    if project_name is not None:
        path_segment(project_name)
        return project_name, 'explicit --project-name'
    selected = Path(project_file) if project_file else None
    if selected and not selected.is_absolute():
        selected = repo / selected
    files = [selected.resolve()] if selected else [repo / name for name in
            ('package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod')]
    candidates = []
    for path in files:
        path.relative_to(repo)
        if not path.is_file():
            if project_file:
                raise ValueError('Project manifest does not exist')
            continue
        name = None
        if path.name == 'package.json':
            name = read(path).get('name')
        elif path.name in ('pyproject.toml', 'Cargo.toml'):
            try:
                import tomllib
            except ImportError as error:
                raise ValueError('TOML project names require Python 3.11+; alternatively supply --project-name') from error
            data = tomllib.loads(path.read_text())
            if path.name == 'pyproject.toml':
                name = data.get('project', {}).get('name') or data.get('tool', {}).get('poetry', {}).get('name')
            else:
                name = data.get('package', {}).get('name')
        elif path.name == 'go.mod':
            match = re.search(r'^\s*module\s+("[^"\n]+"|[^\s/][^\s]*)', path.read_text(), re.MULTILINE)
            if match:
                name = match.group(1).strip('"')
        if name is not None:
            path_segment(name)
            candidates.append((name, str(path)))
    if not candidates:
        raise ValueError('No declared project name; supply --project-name or --project-file')
    if len({name for name, _ in candidates}) > 1:
        raise ValueError('Ambiguous project names; supply --project-name or --project-file')
    return candidates[0]


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


def initialize(args):
    repo = Path(args.repo).resolve()
    check = preflight(repo, args.skill_root)
    if not check['ok']:
        print(json.dumps(check, ensure_ascii=False))
        return 2
    if not args.dependencies_checked:
        raise ValueError('Complete documented dependency and native-subagent capability checks before init')
    project, source = project_identity(repo, args.project_name, args.project_file)
    try:
        branch = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').decode().strip()
    except subprocess.CalledProcessError:
        branch = 'detached-' + git(repo, 'rev-parse', '--short', 'HEAD').decode().strip()
    baseline = snapshot(repo)
    run_id = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    root = (Path(args.root).expanduser() if args.root else Path.home() / '.ya-skills/ultra-produce').resolve()
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
    write(run / 'state.json', {'run_id': run_id, 'project': project, 'project_source': source,
          'branch': branch, 'repo': str(repo), 'root': str(root), 'logs': str(run), 'reports': str(reports),
          'instruction_paths': instruction_paths, 'leader': args.leader, 'goal': args.goal,
          'baseline': baseline, 'preflight': check, 'protocol_version': 3,
          'helper': str(run / 'skill/scripts/pipeline.py')})
    print(run)
    return 0


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE)


def snapshot(repo):
    """Include staged, unstaged and untracked content, including dirty baseline."""
    status = git(repo, 'status', '--porcelain=v1', '-z')
    digest = hashlib.sha256(git(repo, 'rev-parse', 'HEAD'))
    digest.update(status)
    digest.update(git(repo, 'diff', '--cached', '--binary'))
    digest.update(git(repo, 'diff', '--binary'))
    for raw in git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0'):
        if raw:
            path = Path(repo) / os.fsdecode(raw)
            digest.update(raw)
            digest.update(os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes())
    return {'head': git(repo, 'rev-parse', 'HEAD').decode().strip(),
            'status': status.decode(errors='replace'), 'fingerprint': digest.hexdigest()}


def preflight(repo, extra_roots=()):
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
    pending = list(REQUIRED)
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


def correct(run, unit, issue, message, task_id=None):
    safe_id(issue)
    if task_id is not None:
        safe_id(task_id)
        for path in (run / 'tasks' / task_id).glob('attempt-*/execution.json'):
            if read(path).get('unit') != unit:
                raise ValueError('Correction target belongs to another unit')
    if not message.strip():
        raise ValueError('Correction requires an actionable message')
    directory = unit_dir(run, unit)
    with task_lock(directory / 'control'):
        entries = corrections(run, unit)
        old = entries.get(issue)
        if old and old.get('task_id') != task_id:
            raise ValueError('Correction scope cannot change; retract and publish a new issue')
        revision = old['revision'] + 1 if old else 1
        history = [*old.get('history', []), {k: v for k, v in old.items() if k != 'history'}] if old else []
        entries[issue] = {'revision': revision, 'message': message, 'created_at': time.time(),
                          'task_id': task_id, 'history': history}
        write(directory / 'corrections.json', entries)
    return {'issue': issue, 'revision': revision, 'delivery': 'unacknowledged'}


def retract(run, unit, issue, revision, reason):
    safe_id(issue)
    if not reason.strip():
        raise ValueError('Retraction requires a reason')
    directory = unit_dir(run, unit)
    with task_lock(directory / 'control'):
        entries = corrections(run, unit)
        entry = entries.get(issue)
        if not entry or entry['revision'] != revision:
            raise ValueError('Correction revision changed; read the current correction')
        if entry.get('retracted_at') or entry.get('accepted_at'):
            raise ValueError('Correction already closed')
        entry.update(retracted_at=time.time(), retraction_reason=reason)
        write(directory / 'corrections.json', entries)
    return {'issue': issue, 'revision': revision, 'status': 'retracted'}


def acknowledge(run, attempt, issue, revision):
    attempt = attempt_path(run, attempt)
    record = read(attempt / 'execution.json')
    if record['status'] not in ACTIVE:
        raise ValueError('Cannot acknowledge for a terminal attempt')
    directory = unit_dir(run, record['unit'])
    with task_lock(directory / 'control'):
        entries = applicable_corrections(run, record)
        if entries.get(issue, {}).get('revision') != revision:
            raise ValueError('Correction revision changed; read the current correction')
        path = attempt / 'acknowledgements.json'
        received = read(path) if path.exists() else {}
        received[issue] = revision
        write(path, received)


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
        if role == 'planner':
            brief += destination_instructions('after-plan', state, {})
        frozen_outputs = {}
        if extra and extra.get('hook') == 'after-plan':
            versioned = hook_outputs(state, 'after-plan', extra['context'])[1]
            if versioned.exists():
                frozen_outputs = evidence_hashes([str(versioned)])
        if redeliver:
            brief += (f'\nReceipt repair only. Prior attempt: {prior}\nReuse completed work. '
                      'Do not edit product code, commit, rerun tests or overwrite prior receipts/evidence.\n')
        if recovery:
            brief += f'\nRestore all working context from {attempt / "recovery.json"} before proceeding.\n'
        brief += (f'\nRead protocol: {run / "skill/references/protocol.md"}\n'
                  f'Read role contract: {run / "skill/references/roles.md"}\n'
                  f'Run state: {run / "state.json"}\nAttempt: {attempt}\n'
                  f'Helper script: {state["helper"]}\nRequired task_id: {task_id}\n'
                  f'Result file: {attempt / "result.json"}\nHandoff file: {attempt / "handoff.md"}\n'
                  f'Internal outputs: {attempt / "artifacts"}\nPublic reports: {state["reports"]}\n'
                  'Main alone creates native subagents. If you or any invoked skill needs workers, '
                  'write dispatch cards and a full handoff/checkpoint, then end this turn. '
                  'Write complete findings, questions and evidence into files. '
                  'Your final reply MUST contain only task_id, status and the absolute result.json path. '
                  'Preserve scope, permissions and user changes; report unavailable capabilities as blocked.\n')
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


def hook_outputs(state, name, context):
    root = Path(state['reports'])
    if name == 'after-plan':
        version = context['plan_version']
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ValueError('Plan version must be a positive integer')
        return [root / 'plan.md', root / f'plan-v{version}.md']
    if name == 'after-verify':
        return [root / f'verify-r{context["attempt"]}' / 'report.html']
    if name == 'before-finish':
        return [root / 'retrospective.md']
    return []


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


def check_hook_delivery(state, record, output):
    expected = hook_outputs(state, record['hook'], record['context'])
    if any(not path.is_file() for path in expected) or (expected and str(expected[0]) not in output['artifacts']):
        raise ValueError('Hook receipt is missing its required public deliverable')
    if expected and (output.get('output_dir') != str(expected[0].parent)
                     or not isinstance(output.get('instruction_paths'), list)):
        raise ValueError('Hook receipt requires actual output_dir and instruction_paths')
    check_evidence(record.get('frozen_outputs', {}), 'An immutable Plan version was overwritten; use a new version')
    if record['hook'] == 'after-plan' and expected[0].read_bytes() != expected[1].read_bytes():
        raise ValueError('Latest plan differs from its immutable version')
    return evidence_hashes(map(str, expected))


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
                    if record.get('hook'):
                        record['evidence_hashes'].update(check_hook_delivery(state, record, output))
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


def run_status(run, task_id=None, parent_task_id=None):
    tasks = []
    for directory in sorted((run / 'tasks').glob('*')):
        attempt = latest_attempt(run, directory.name)
        if not attempt:
            continue
        item = notification(attempt)
        if task_id and item['task_id'] != task_id:
            continue
        if parent_task_id and item.get('parent_task_id') != parent_task_id:
            continue
        record = read(attempt / 'execution.json')
        if record.get('unit'):
            ack_path = attempt / 'acknowledgements.json'
            acks = read(ack_path) if ack_path.exists() else {}
            item['pending_corrections'] = {issue: {'revision': value['revision'],
                'acknowledged': acks.get(issue) == value['revision']}
                for issue, value in applicable_corrections(run, record).items()}
        tasks.append(item)
    return {'fingerprint': snapshot(read(run / 'state.json')['repo'])['fingerprint'],
            'tasks': tasks, 'noop_hooks': [str(path) for path in sorted((run / 'tasks').glob('*/noop.json'))]}


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


def destination_instructions(name, state, context):
    expected = hook_outputs(state, name, context) if name != 'after-plan' or context else [Path(state['reports']) / 'plan.md']
    target = expected[0].parent if expected else Path(state['reports'])
    selected = context.get('output_dir')
    if selected is not None and Path(selected).resolve() != target:
        raise ValueError('Hook output_dir must match the unified run reports directory')
    metadata = {'output_dir': str(target), 'outputs': [str(path) for path in expected],
                'branch': state['branch'], 'project': state['project'], 'instructions': destination_rules(target)}
    return ('\nOutput destination rules (read before writing):\n' + json.dumps(metadata, ensure_ascii=False)
            + '\nThe user requires this unified layout. Apply destination language and content rules; '
              'read any deeper destination AGENTS.md before writing. Report instruction_paths and output_dir.\n')


def hook(args):
    run = Path(args.run).resolve()
    state = read(run / 'state.json')
    context = read(args.context)
    required = ('stage', 'attempt', 'plan_version', 'git_range', 'outcome', 'evidence')
    if not isinstance(context, dict) or any(key not in context for key in required):
        raise ValueError('Hook context requires: ' + ', '.join(required))
    if not isinstance(context['evidence'], list):
        raise ValueError('Hook evidence must be an array of absolute file paths')
    evidence_hashes([str(output_path(run, path)) for path in context['evidence']])
    if not isinstance(context['attempt'], int) or isinstance(context['attempt'], bool) or context['attempt'] < 1:
        raise ValueError('Hook attempt must be a positive integer')
    task_id = safe_id(f'hook-{args.name}-{args.key}')
    if args.name not in DEFAULT_HOOKS and not args.prompt:
        directory = run / 'tasks' / task_id
        with task_lock(directory):
            path = directory / 'noop.json'
            value = {'hook': args.name, 'status': 'noop', 'context': context}
            if path.exists() and read(path) != value:
                raise ValueError('Hook key already has different context')
            write(path, value)
        return {'task_id': task_id, 'status': 'noop', 'result': str(path)}
    instructions = destination_instructions(args.name, state, context)
    brief = (run / 'skill/references/hooks.md').read_text()
    brief += '\nExecute only hook: ' + args.name + '\nContext:\n' + json.dumps(context, ensure_ascii=False)
    brief += instructions
    if args.prompt:
        brief += '\nAdditional hook instructions:\n' + Path(args.prompt).read_text()
    return prepare(run, task_id, 'hook', brief, retry=args.retry, extra={'hook': args.name, 'context': context})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for name in ('preflight', 'init'):
        p = sub.add_parser(name)
        p.add_argument('--repo', default='.')
        p.add_argument('--skill-root', action='append', default=[])
        if name == 'init':
            p.add_argument('--goal', required=True)
            p.add_argument('--leader')
            p.add_argument('--dependencies-checked', action='store_true')
            p.add_argument('--root', '--state-root', dest='root', help='Unified logs/reports root; defaults to ~/.ya-skills/ultra-produce')
            p.add_argument('--project-name')
            p.add_argument('--project-file')
    for name in ('prepare', 'bind', 'collect', 'requests', 'brief', 'hook', 'status', 'checkpoint', 'correct', 'retract', 'ack', 'gate', 'accept', 'reconcile'):
        p = sub.add_parser(name)
        p.add_argument('--run', required=True)
        if name == 'prepare':
            p.add_argument('--task-id', required=True)
            p.add_argument('--role', choices=ROLES, required=True)
            p.add_argument('--prompt', required=True)
            p.add_argument('--unit')
            p.add_argument('--after', action='append', default=[])
            p.add_argument('--parent-attempt')
            modes = p.add_mutually_exclusive_group()
            modes.add_argument('--retry', action='store_true')
            modes.add_argument('--continue-from')
            modes.add_argument('--redeliver', action='store_true')
        if name in ('bind', 'collect', 'requests', 'brief', 'checkpoint', 'ack', 'gate'):
            p.add_argument('--attempt', required=True)
        if name == 'brief':
            p.add_argument('--offset', type=int, default=0)
            p.add_argument('--question-id')
        if name == 'bind':
            p.add_argument('--agent-id', required=True)
        if name == 'hook':
            p.add_argument('--name', choices=HOOKS, required=True)
            p.add_argument('--key', required=True)
            p.add_argument('--context', required=True)
            p.add_argument('--prompt')
            p.add_argument('--retry', action='store_true')
        if name in ('correct', 'retract'):
            p.add_argument('--unit', required=True)
        if name in ('correct', 'retract', 'ack'):
            p.add_argument('--issue', required=True)
        if name in ('retract', 'ack'):
            p.add_argument('--revision', type=int, required=True)
        if name == 'correct':
            p.add_argument('--message', required=True)
            p.add_argument('--task-id')
        if name == 'checkpoint':
            p.add_argument('--summary', required=True)
            p.add_argument('--next', required=True)
            p.add_argument('--evidence', action='append', default=[])
            p.add_argument('--handoff')
            p.add_argument('--request', action='append', default=[])
            p.add_argument('--reference', action='append', default=[])
        if name in ('retract', 'reconcile'):
            p.add_argument('--reason', required=True)
        if name in ('accept', 'reconcile'):
            p.add_argument('--task-id', required=True)
        if name == 'accept':
            p.add_argument('--review', help='Stage-owner recheck receipt when parallel work changed the workspace')
        if name == 'reconcile':
            p.add_argument('--agent-ended', action='store_true')
        if name == 'status':
            p.add_argument('--task-id')
            p.add_argument('--parent-task-id')
    args = parser.parse_args()
    try:
        if args.action == 'preflight':
            result = preflight(Path(args.repo).resolve(), args.skill_root)
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result['ok'] else 2
        if args.action == 'init':
            return initialize(args)
        run = Path(args.run).resolve()
        state = read(run / 'state.json')
        if state.get('protocol_version') != 3:
            raise ValueError('Use the existing run snapshot to finish an older protocol')
        pinned = Path(state['helper']).resolve()
        if args.action != 'status' and pinned != Path(__file__).resolve():
            raise ValueError(f'Use the pinned run helper: {pinned}')
        if args.action == 'prepare':
            result = prepare(run, args.task_id, args.role, Path(args.prompt).read_text(),
                             retry=args.retry, unit=args.unit, after=args.after,
                             parent_attempt=args.parent_attempt, prompt_path=args.prompt,
                             continue_from=args.continue_from, redeliver=args.redeliver)
        elif args.action == 'bind':
            result = bind(run, args.attempt, args.agent_id)
        elif args.action == 'collect':
            result = collect(run, args.attempt)
        elif args.action == 'requests':
            result = dispatch_requests(run, args.attempt)
        elif args.action == 'brief':
            result = brief(run, args.attempt, args.offset, args.question_id)
        elif args.action == 'hook':
            result = hook(args)
        elif args.action == 'checkpoint':
            result = checkpoint(run, args.attempt, args.summary, args.next, args.evidence,
                                handoff=args.handoff, requests=args.request, references=args.reference)
        elif args.action == 'correct':
            result = correct(run, args.unit, args.issue, args.message, args.task_id)
        elif args.action == 'retract':
            result = retract(run, args.unit, args.issue, args.revision, args.reason)
        elif args.action == 'ack':
            acknowledge(run, args.attempt, args.issue, args.revision)
            result = notification(Path(args.attempt).resolve())
        elif args.action == 'gate':
            gate(run, args.attempt)
            result = notification(Path(args.attempt).resolve())
        elif args.action == 'accept':
            accept(run, args.task_id, args.review)
            result = notification(latest_attempt(run, args.task_id))
        elif args.action == 'reconcile':
            result = reconcile(run, args.task_id, args.reason, args.agent_ended)
        else:
            result = run_status(run, args.task_id, args.parent_task_id)
        print(json.dumps(result, ensure_ascii=False))
        return 2 if isinstance(result, dict) and result.get('status') in ('blocked', 'needs_changes') else 0
    except (ValueError, OSError, TypeError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error)[:300], file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
