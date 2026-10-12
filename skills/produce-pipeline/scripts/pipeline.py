#!/usr/bin/env python3
"""Small process/artifact helpers. The Leader owns phase and acceptance decisions."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid

REQUIRED = ('brainstorming', 'grill-with-docs', 'simplify', 'ultra-cr', 'eli10', 'computer-e2e', 'show-pr')
ROLES = {
    'planner': ['coldx', 'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="medium"', '--enable', 'multi_agent'],
    'builder': ['logoscode', 'run'],
    'ultraviewer': ['logoscode', 'run'],
    'verifier': ['bangboo', '--model', 'zai-coding-cn/glm-5.3', '--thinking', 'max', '-p'],
    'hook': ['bangboo', '--model', 'zai-coding-cn/glm-5.3', '--thinking', 'max', '-p'],
    'e2e-tester': ['coldx', 'exec', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="max"'],
}
HOOKS = ('before-plan', 'after-plan', 'before-impl', 'after-impl', 'before-verify', 'after-verify', 'before-finish')
DEFAULT_HOOKS = ('after-plan', 'after-verify', 'before-finish')
STATUSES = ('completed', 'needs_decision', 'needs_changes', 'blocked')
DEFAULT_BUDGET = {'seconds': 3600, 'max_retries': 3, 'idle_seconds': 600}
MAX_DELIVERIES = 2
PROCESS_UNREAD = object()


class DeliveryError(ValueError):
    """A missing/invalid receipt, distinct from an implementation failure."""


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def slug(value):
    return re.sub(r'[^A-Za-z0-9._-]+', '-', value).strip('.-') or 'project'


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
    cli = {name: shutil.which(name) for name in ('coldx', 'logoscode', 'bangboo', 'git', 'python3', 'node', 'yk')}
    return {'ok': not missing and all(cli.values()), 'missing_skills': missing,
            'missing_tools': [k for k, v in cli.items() if not v], 'skills': resolved, 'tools': cli,
            'manual_checks': ['Main agent can launch CLIs and exchange task/result files', 'Read resolved skills for additional required dependencies', 'Task-specific tools, permissions and test targets']}


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


def stop_group(group):
    """Only called with the current invocation's owned/inherited group, never saved PIDs."""
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass


def initialize(args):
    repo = Path(args.repo).resolve()
    check = preflight(repo, args.skill_root)
    if not check['ok']:
        print(json.dumps(check, ensure_ascii=False, indent=2))
        return 2
    if not args.dependencies_checked:
        raise ValueError('Complete documented dependency checks before init')
    baseline = snapshot(repo)
    run_id = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    root = Path(args.state_root).expanduser().resolve() if args.state_root else Path.home() / '.ya-skills/produce-pipeline'
    run = root / slug(repo.name) / run_id
    run.mkdir(parents=True)
    save_baseline(repo, run)
    shutil.copytree(Path(__file__).resolve().parent.parent, run / 'skill',
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    write(run / 'state.json', {'run_id': run_id, 'project': slug(repo.name), 'repo': str(repo),
          'leader': args.leader, 'goal': args.goal, 'baseline': baseline, 'preflight': check,
          'protocol_version': 2, 'helper': str(run / 'skill/scripts/pipeline.py')})
    print(run)
    return 0


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
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', value):
        raise ValueError('IDs must be safe single path segments')
    return value


def unit_dir(run, unit):
    return run / 'units' / safe_id(unit)


def lock_held(directory):
    """Check the launcher lock, not an old PID that the OS may have reused."""
    path = directory / '.lock'
    if not path.exists():
        return False
    with path.open('r') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def process_table():
    """Read process identity without signalling a historical PID. macOS/Linux ps."""
    try:
        output = subprocess.check_output(
            ['ps', '-axo', 'pid=,pgid=,lstart=,stat='], stderr=subprocess.PIPE,
            env={**os.environ, 'LC_ALL': 'C'}, timeout=5).decode()
        entries = {}
        for line in output.splitlines():
            fields = line.split()
            if len(fields) != 8:
                return None
            pid, group = int(fields[0]), int(fields[1])
            entries[pid] = {'pid': pid, 'pgid': group, 'started': ' '.join(fields[2:7]),
                            'zombie': fields[7].startswith('Z')}
        return entries
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def process_identity(pid):
    table = process_table()
    entry = table.get(pid) if table is not None else None
    return {key: entry[key] for key in ('pid', 'pgid', 'started')} if entry else None


def owned_process_state(run, attempt, record, table=PROCESS_UNREAD):
    """Observe the worker and recorded nested workers; never claim unknown ownership."""
    table = process_table() if table is PROCESS_UNREAD else table
    if table is None:
        return 'unknown'
    records = {str(attempt): record}
    candidates = {str(path.parent): read(path) for path in (run / 'tasks').glob('*/attempt-*/execution.json')}
    while True:
        children = {path: item for path, item in candidates.items()
                    if item.get('parent_attempt') in records and path not in records}
        if not children:
            break
        records.update(children)
    unknown = False
    for item in records.values():
        identity = item.get('process_identity')
        if not identity:
            unknown = True
            continue
        current = table.get(identity['pid'])
        if current is not None:
            if any(current.get(key) != value for key, value in identity.items()):
                unknown = True
            elif not current['zombie']:
                return 'alive'
        # Unregistered children may survive a process that owned a dedicated group.
        if identity['pgid'] == identity['pid'] and any(
                entry['pgid'] == identity['pgid'] and entry['pid'] != identity['pid']
                and not entry['zombie'] for entry in table.values()):
            unknown = True
    return 'unknown' if unknown else 'exited'


def configure_budget(run, unit, seconds, max_retries, idle_seconds, reason, evidence=()):
    directory = unit_dir(run, unit)
    with task_lock(directory):
        path = directory / 'budget.json'
        old = read(path) if path.exists() else {**DEFAULT_BUDGET, 'history': []}
        before = {key: old[key] for key in DEFAULT_BUDGET}
        values = {'seconds': seconds, 'max_retries': max_retries, 'idle_seconds': idle_seconds}
        merged = {key: before[key] if value is None else value for key, value in values.items()}
        seconds, max_retries, idle_seconds = (merged[key] for key in ('seconds', 'max_retries', 'idle_seconds'))
        if not all(math.isfinite(value) and value > 0 for value in (seconds, idle_seconds)) or max_retries < 0 or not reason.strip():
            raise ValueError('Budget requires positive time limits, nonnegative retries and a reason')
        records = unit_records(run, unit)
        stalled = len(records) >= 2 and all(entry.get('failure_kind') == 'no_progress' for entry in records[-2:])
        increases = seconds > old['seconds'] or max_retries > old['max_retries'] or idle_seconds > old['idle_seconds']
        hashes = evidence_hashes(evidence)
        if records and (stalled or increases) and not (set(hashes.values()) - set(old.get('recovery_evidence', {}).values())):
            raise ValueError('Increasing a used budget or recovering from no progress requires new diagnostic evidence')
        change = {'seconds': seconds, 'max_retries': max_retries, 'idle_seconds': idle_seconds,
                  'reason': reason, 'at': time.time()}
        if hashes:
            change.update(recovery_after=time.time(), recovery_evidence=hashes)
        write(path, {**old, **change, 'history': [*old['history'], change]})
        return {'before': before, 'after': merged,
                'changed': {key: {'before': before[key], 'after': value}
                            for key, value in merged.items() if value != before[key]}}


def unit_records(run, unit):
    entries = [entry for path in (run / 'tasks').glob('*/attempt-*/execution.json')
               if (entry := read(path)).get('unit') == unit]
    return sorted(entries, key=lambda entry: entry['started_at'])


def implementation_failure(entry):
    return (entry['status'] not in ('running', 'completed')
            and entry.get('failure_kind') != 'delivery'
            and (entry.get('mode') != 'delivery' or entry.get('failure_kind') == 'workspace_changed'))


def remaining_budget(run, unit, redeliver=False):
    path = unit_dir(run, unit) / 'budget.json'
    policy = read(path) if path.exists() else DEFAULT_BUDGET
    records = unit_records(run, unit)
    if any(entry['status'] == 'running' for entry in records):
        raise ValueError('Unit has an unreconciled running attempt; inspect status before recovery')
    if ((redeliver and sum(entry.get('mode') == 'delivery' for entry in records) >= MAX_DELIVERIES)
            or (not redeliver and sum(entry.get('failure_kind') == 'delivery' for entry in records) > MAX_DELIVERIES)):
        raise ValueError('Delivery retry limit reached; diagnose the protocol failure')
    if (len(records) >= 2 and all(entry.get('failure_kind') == 'no_progress' for entry in records[-2:])
            and records[-1]['finished_at'] >= policy.get('recovery_after', 0)):
        raise ValueError('Two consecutive no-progress attempts; stop and diagnose before further implementation')
    if not redeliver and sum(implementation_failure(entry) for entry in records) > policy['max_retries']:
        raise ValueError('Unit retry budget exhausted; do not reset it by renaming tasks')
    remaining = policy['seconds'] - sum(entry['duration_seconds'] for entry in records)
    if remaining <= 0:
        raise ValueError('Unit time budget exhausted')
    return remaining, policy['idle_seconds']


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


def checkpoint(run, attempt, summary, next_action, evidence):
    attempt = attempt_path(run, attempt)
    if not lock_held(attempt.parent):
        raise ValueError('Checkpoint requires a live launcher; reconcile stopped attempts first')
    if not summary.strip() or not next_action.strip():
        raise ValueError('Checkpoint requires completed facts and a concrete next action')
    if any(Path(path).name in ('run.log', 'checkpoint.json', 'execution.json', 'progress.json', 'task.md') for path in evidence):
        raise ValueError('Control files and raw agent logs are not progress evidence')
    with task_lock(attempt / 'control'):
        record = read(attempt / 'execution.json')
        if record['status'] != 'running':
            raise ValueError('Cannot checkpoint a terminal attempt')
        path = attempt / 'checkpoint.json'
        old = read(path) if path.exists() else {'snapshot': record['snapshot'],
            'last_progress_at': record['started_at'], 'seen_evidence_hashes': []}
        current = snapshot(read(run / 'state.json')['repo'])
        hashes = evidence_hashes(evidence)
        seen = set(old['seen_evidence_hashes'])
        advanced = current['fingerprint'] != old['snapshot']['fingerprint'] or bool(set(hashes.values()) - seen)
        write(path, {'run': str(run), 'task': str(attempt / 'task.md'), 'result': str(attempt / 'result.json'),
              'unit': record.get('unit'), 'summary': summary, 'next_action': next_action,
              'snapshot': current, 'evidence': hashes, 'seen_evidence_hashes': sorted(seen | set(hashes.values())),
              'updated_at': time.time(), 'last_progress_at': time.time() if advanced else old['last_progress_at']})


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
    if not lock_held(attempt.parent):
        raise ValueError('Only the active Builder acknowledges receipt')
    record = read(attempt / 'execution.json')
    if record['status'] != 'running':
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
        paths = sorted((run / 'tasks' / safe_id(task_id)).glob('attempt-*/execution.json'))
        record = read(paths[-1]) if paths else {}
        if record.get('status') != 'completed' or not record.get('accepted_at'):
            raise ValueError(f'Dependency not accepted: {task_id}')
        attempt = paths[-1].parent
        check_task(attempt, record)
        if evidence_hashes(record['evidence_hashes']) != record['evidence_hashes']:
            raise ValueError(f'Dependency evidence changed: {task_id}')
        check_corrections(run, attempt, read(attempt / 'result.json'))
        receipts.append({'task_id': task_id, 'attempt': str(attempt), 'accepted_at': record['accepted_at']})
    return receipts


def check_dependencies(run, record):
    expected = record.get('dependencies', [])
    actual = dependency_receipts(run, [entry['task_id'] for entry in expected])
    if actual != expected:
        raise ValueError('Dependency acceptance changed since launch; recheck integration evidence')


def accept(run, task_id):
    paths = sorted((run / 'tasks' / safe_id(task_id)).glob('attempt-*/execution.json'))
    if not paths:
        raise ValueError('No attempt to accept')
    attempt = paths[-1].parent
    with task_lock(attempt.parent):
        record = read(attempt / 'execution.json')
        if record['status'] != 'completed':
            raise ValueError('Only a completed result can be accepted')
        check_task(attempt, record)
        check_dependencies(run, record)
        if evidence_hashes(record['evidence_hashes']) != record['evidence_hashes']:
            raise ValueError('Delivery evidence changed since completion; recheck and deliver again')
        current = snapshot(read(run / 'state.json')['repo'])
        if current['fingerprint'] != record['after_snapshot']['fingerprint']:
            raise ValueError('Workspace changed since result; recheck evidence before accepting')
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


def run_status(run, inspect_workspace=True):
    state = read(run / 'state.json')
    current = snapshot(state['repo']) if inspect_workspace else None
    tasks = []
    processes = PROCESS_UNREAD
    for directory in sorted((run / 'tasks').glob('*')):
        paths = sorted(directory.glob('attempt-*/execution.json'))
        if not paths:
            continue
        path = paths[-1]
        entry = read(path)
        entry['path'] = str(path)
        entry['launcher_state'] = 'alive' if lock_held(directory) else 'absent'
        if entry['launcher_state'] == 'absent' and entry['status'] != 'completed':
            if processes is PROCESS_UNREAD:
                processes = process_table()
            entry['worker_state'] = owned_process_state(run, path.parent, entry, processes)
        elif entry['status'] == 'completed':
            entry['worker_state'] = 'not_observed'
        else:
            entry['worker_state'] = 'supervised'
        if entry['status'] == 'running' and entry['launcher_state'] == 'absent':
            entry['status'] = 'interrupted'
            entry['action'] = ('Inspect owned worker and artifacts; launcher is absent. '
                               'Do not relaunch until process ownership and side effects are reconciled.')
        checkpoint_path = path.with_name('checkpoint.json')
        saved = read(checkpoint_path) if checkpoint_path.exists() else {}
        last = saved.get('last_progress_at', entry.get('started_at'))
        observed_at = time.time() if entry['status'] in ('running', 'interrupted') else entry.get('finished_at', time.time())
        entry['seconds_without_progress'] = max(0, observed_at - last) if last else None
        entry['checkpoint'] = str(checkpoint_path) if saved else None
        entry['progress_at'] = saved.get('last_progress_at')
        entry['progress_summary'] = saved.get('summary', '')
        idle = entry.get('idle_seconds')
        entry['checkpoint_overdue'] = bool(entry['status'] == 'running' and idle is not None
                                          and last is not None and time.time() - last >= idle)
        if entry['checkpoint_overdue']:
            entry['inspection_since'] = last
            entry['action'] = ('Inspect current tool/process, permissions and recent evidence; missing checkpoint is not proof of a stall. '
                               'Keep the worker running while deciding whether to wait, request a checkpoint or intervene.')
        entry['workspace_changed_since_result'] = (entry['after_snapshot']['fingerprint'] != current['fingerprint']
            if current and entry.get('after_snapshot') else None)
        if entry.get('unit'):
            ack_path = path.with_name('acknowledgements.json')
            received = read(ack_path) if ack_path.exists() else {}
            entry['pending_corrections'] = {issue: {**value, 'acknowledged': received.get(issue) == value['revision']}
                for issue, value in applicable_corrections(run, entry).items()}
        tasks.append(entry)
    units = {}
    for unit in {entry['unit'] for entry in tasks if entry.get('unit')}:
        path = unit_dir(run, unit) / 'budget.json'
        policy = read(path) if path.exists() else DEFAULT_BUDGET
        records = unit_records(run, unit)
        spent = sum(entry.get('duration_seconds', max(0, time.time() - entry.get('started_at', time.time()))) for entry in records)
        units[unit] = {'budget': policy, 'spent_seconds': spent, 'remaining_seconds': max(0, policy['seconds'] - spent),
                       'unsuccessful_attempts': sum(implementation_failure(entry) for entry in records),
                       'delivery_attempts': sum(entry.get('mode') == 'delivery' for entry in records)}
    return {'state': state, 'current': current, 'tasks': tasks, 'units': units,
            'attention': [entry['task_id'] for entry in tasks
                if entry['status'] not in ('running', 'completed') or entry.get('pending_corrections') or entry['checkpoint_overdue']],
            'noop_hooks': [read(path) for path in sorted((run / 'tasks').glob('*/noop.json'))]}


def compact_task(entry):
    keys = ('task_id', 'role', 'unit', 'status', 'path', 'exit_code', 'failure_kind', 'mode',
            'checkpoint', 'progress_at', 'workspace_changed_since_result', 'accepted_at', 'checkpoint_overdue', 'inspection_since',
            'launcher_state', 'worker_state')
    result = {key: entry[key] for key in keys if key in entry}
    for key in ('error', 'action', 'progress_summary'):
        if entry.get(key):
            result[key] = entry[key][:300]
    result['pending_corrections'] = {issue: {'revision': value['revision'], 'acknowledged': value['acknowledged']}
        for issue, value in entry.get('pending_corrections', {}).items()}
    return result


def compact_status(status):
    return {'tasks': [compact_task(entry) for entry in status['tasks']], 'attention': status['attention'],
            'units': {unit: {key: value[key] for key in ('remaining_seconds', 'unsuccessful_attempts', 'delivery_attempts')}
                      for unit, value in status['units'].items()}}


def status_changes(status, previous):
    """Only semantic changes wake the host; elapsed time and heartbeat text do not."""
    changed = []
    for task in status['tasks']:
        stable = {key: value for key, value in task.items()
                  if key not in ('seconds_without_progress', 'progress_summary')}
        key = task['task_id']
        old = previous.get(key, {})
        if old != stable:
            previous[key] = stable
            needs_inspection = task.get('checkpoint_overdue') and (
                not old.get('checkpoint_overdue') or old.get('inspection_since') != task.get('inspection_since'))
            event = 'inspection_needed' if needs_inspection else 'task_changed'
            changed.append({'event': event, **task})
    return changed


def emit_changes(run, previous, task_id=None):
    status = compact_status(run_status(run, inspect_workspace=False))
    if task_id:
        status['tasks'] = [task for task in status['tasks'] if task['task_id'] == task_id]
    for event in status_changes(status, previous):
        print(json.dumps(event, ensure_ascii=False), flush=True)
    return status


def watch(run, timeout=3600):
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('Watch timeout must be positive and finite')
    deadline = time.monotonic() + timeout
    previous = {}
    while True:
        status = emit_changes(run, previous)
        if not any(task['status'] == 'running' or task.get('worker_state') == 'alive'
                   or (task['status'] == 'interrupted' and task.get('worker_state') == 'unknown')
                   for task in status['tasks']):
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print(json.dumps({'event': 'watch_expired', 'action': 'Inspect compact status; watcher does not stop tasks'}), flush=True)
            return
        time.sleep(min(1, remaining))


def capture_session(log, record):
    """Read only CLI JSON envelopes, never infer a session from prose or a global list."""
    while True:
        offset = log.tell()
        line = log.readline()
        if not line.endswith('\n'):
            log.seek(offset)
            return
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        session = event.get('sessionID')
        if event.get('type') in ('step_start', 'step_finish', 'text', 'tool_use', 'error') and isinstance(session, str) and re.fullmatch(r'ses_[A-Za-z0-9_-]+', session):
            if not record.get('session_id'):
                record['session_id'] = session


def reconcile(run, task_id, reason, processes_checked):
    if not processes_checked or not reason.strip():
        raise ValueError('Reconciliation requires checking owned processes, Git and artifacts, with a reason')
    directory = run / 'tasks' / safe_id(task_id)
    with task_lock(directory):
        paths = sorted(directory.glob('attempt-*/execution.json'))
        if not paths:
            raise ValueError('No attempt to reconcile')
        path = paths[-1]
        record = read(path)
        if record['status'] != 'running':
            raise ValueError('Attempt already has a terminal status; use its recorded outcome')
        if owned_process_state(run, path.parent, record) == 'alive':
            raise ValueError('Owned worker is still alive; inspect or wait before reconciliation')
        now = time.time()
        record.update(status='blocked', failure_kind='interrupted', reconciliation=reason,
                      finished_at=now, duration_seconds=now - record.get('started_at', path.stat().st_mtime),
                      after_snapshot=snapshot(read(run / 'state.json')['repo']))
        write(path, record)


def command(role, repo, prompt, result, session=None):
    args = list(ROLES[role])
    if role in ('builder', 'ultraviewer'):
        return args + ['--format', 'json', *(['--session', session] if session else []),
                       'Read the attached task and write the required result JSON.',
                       '--dir', repo, '--file', str(prompt)]
    if role in ('verifier', 'hook'):
        return args + ['@' + str(prompt)]
    return args + ['-C', repo, '-', '-o', str(result.with_name('agent-final.txt'))]


def execute(run, task_id, role, brief, retry=False, timeout=3600, extra=None, unit=None, after=(), redeliver=False, fresh_session_reason=None):
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('Timeout must be positive and finite')
    if role == 'builder' and not unit:
        raise ValueError('Builder requires --unit: the stable Plan module ID, shared by split tasks and retries')
    if task_id in after:
        raise ValueError('Task cannot depend on itself')
    if redeliver and (role != 'builder' or retry or after):
        raise ValueError('Redelivery requires Builder and its original dependencies; do not combine with --retry/--after')
    if fresh_session_reason is not None and (not redeliver or not fresh_session_reason.strip()):
        raise ValueError('Fresh session requires redelivery and a concrete recovery reason')
    if unit:
        with task_lock(unit_dir(run, unit)):
            remaining, idle = remaining_budget(run, unit, redeliver)
            return execute_attempt(run, task_id, role, brief, retry, min(timeout, remaining), extra, unit, idle, after,
                                   redeliver, fresh_session_reason)
    return execute_attempt(run, task_id, role, brief, retry, timeout, extra, after=after)


def execute_attempt(run, task_id, role, brief, retry=False, timeout=3600, extra=None, unit=None, idle=None, after=(), redeliver=False, fresh_session_reason=None):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', task_id):
        raise ValueError('task-id must be a safe single path segment')
    state = read(run / 'state.json')
    if role == 'planner':
        brief += destination_instructions('after-plan', state, {})
    directory = run / 'tasks' / task_id
    with task_lock(directory):
        previous = sorted(directory.glob('attempt-*/execution.json'))
        if previous and read(previous[-1]).get('unit') != unit:
            raise ValueError('A task cannot change its budget unit')
        if previous and not (retry or redeliver):
            raise ValueError('Task already attempted; inspect status and use --retry only after reconciliation')
        session = None
        dependencies = dependency_receipts(run, after)
        before = snapshot(state['repo'])
        prior_hashes = {}
        if redeliver:
            if not previous:
                raise ValueError('Redelivery requires an existing task')
            prior = read(previous[-1])
            receipt_outcome = (prior['status'] == 'completed' or prior.get('failure_kind') == 'delivery'
                               or (prior.get('mode') == 'delivery' and prior['status'] == 'blocked'))
            if not receipt_outcome or prior.get('failure_kind') in ('workspace_changed', 'delivery_evidence_changed') or not prior.get('after_snapshot'):
                raise ValueError('Reconcile implementation and workspace before redelivery')
            if prior.get('role') != role or prior['after_snapshot']['fingerprint'] != before['fingerprint']:
                raise ValueError('Workspace changed since delivery; review affected implementation evidence first')
            after = [receipt['task_id'] for receipt in prior.get('dependencies', [])]
            check_dependencies(run, prior)
            dependencies = dependency_receipts(run, after)
            session = None if fresh_session_reason else prior.get('session_id')
            if not session and not fresh_session_reason:
                raise ValueError('No captured session ID; provide --fresh-session-reason and a compact handoff')
            extra = {**(extra or {}), 'mode': 'delivery', 'resumed_from': str(previous[-1].parent),
                     'fresh_session_reason': fresh_session_reason}
            prior_files = [previous[-1], previous[-1].with_name('task.md')]
            if previous[-1].with_name('result.json').exists():
                prior_files.append(previous[-1].with_name('result.json'))
            prior_hashes = prior.get('evidence_hashes', {})
            if evidence_hashes(prior_hashes) != prior_hashes:
                raise ValueError('Prior evidence changed; review it before receipt repair')
            prior_hashes = {**prior_hashes, **evidence_hashes(map(str, prior_files))}
            brief += (f'\nReceipt repair only. Prior attempt: {previous[-1].parent}\n'
                      'Reuse completed work and existing test evidence. Do not edit product code, commit, or rerun tests. '
                      'Read only the prior receipt/checkpoint and current corrections needed for this repair. '
                      'Write a new receipt to THIS attempt; never overwrite prior task/result/evidence files.\n')
        attempt = directory / f'attempt-{len(previous) + 1:04d}'
        attempt.mkdir()
        result = attempt / 'result.json'
        prompt = attempt / 'task.md'
        reference = 'builder-task.md' if role == 'builder' else 'protocol.md'
        protocol = Path(__file__).resolve().parent.parent / 'references' / reference
        prompt.write_text(brief + '\n\n' + ('Protocol reference (only if needed): ' if redeliver else 'Read protocol: ') + str(protocol) + '\n'
            + 'Result file (write JSON yourself): ' + str(result) + '\n'
            + 'Required task_id: ' + task_id + '\n'
            + 'Run state: ' + str(run / 'state.json') + '\n'
            + 'Resolve skill paths from run state. Inherit the task scope and existing permissions. '
            + 'Do not bypass approvals. Return blocked if permissions or required capabilities are unavailable.\n')
        if unit:
            with prompt.open('a') as handle:
                handle.write(f'Helper script: {Path(__file__).resolve()}\nBudget unit: {unit}\nCorrections: {unit_dir(run, unit) / "corrections.json"}\n'
                    f'Attempt: {attempt}\nCheckpoint with pipeline.py after substantive progress and before context reset. '
                    f'Checkpoint inspection threshold: {idle} seconds (alerts Leader; does not terminate); attempt time limit: {timeout} seconds. '
                    'Read/ack current corrections before edits, tests, commit and final result. '
                    'Return correction revisions and evidence in result.corrections.\n')
        record = {'task_id': task_id, 'role': role, 'status': 'running', 'snapshot': before,
                  'unit': unit, 'started_at': time.time(), 'timeout_seconds': timeout, 'idle_seconds': idle,
                  'task_hash': hashlib.sha256(prompt.read_bytes()).hexdigest(), 'dependencies': dependencies,
                  'parent_attempt': os.environ.get('PRODUCE_PIPELINE_PARENT_ATTEMPT'),
                  'session_id': session, **(extra or {})}
        write(attempt / 'execution.json', record)
        events = {}
        emit_changes(run, events, task_id)
        child = None
        nested = os.environ.get('PRODUCE_PIPELINE_RUN') == str(run)
        try:
            with (attempt / 'run.log').open('w') as log, (attempt / 'run.log').open() as event_log:
                child = subprocess.Popen(command(role, state['repo'], prompt, result, session), cwd=state['repo'],
                    stdin=subprocess.PIPE if role in ('planner', 'e2e-tester') else subprocess.DEVNULL,
                    stdout=log, stderr=subprocess.STDOUT, start_new_session=not nested,
                    env={**os.environ, 'PRODUCE_PIPELINE_PARENT_ATTEMPT': str(attempt),
                         'PRODUCE_PIPELINE_RUN': str(run)})
                record['pid'] = child.pid
                record['process_identity'] = process_identity(child.pid)
                write(attempt / 'execution.json', record)
                input_data = prompt.read_text().encode() if role in ('planner', 'e2e-tester') else None
                deadline = time.monotonic() + timeout
                while True:
                    if role in ('builder', 'ultraviewer'):
                        old_session = record.get('session_id')
                        capture_session(event_log, record)
                        if record.get('session_id') != old_session:
                            write(attempt / 'execution.json', record)
                    emit_changes(run, events, task_id)
                    if child.poll() is not None:
                        child.communicate()
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        record['failure_kind'] = 'timeout'
                        raise TimeoutError('Attempt or cumulative unit time budget exhausted')
                    wait = min(5, remaining)
                    if idle is not None:
                        checkpoint_file = attempt / 'checkpoint.json'
                        last = read(checkpoint_file)['last_progress_at'] if checkpoint_file.exists() else record['started_at']
                        idle_left = idle - (time.time() - last)
                        if idle_left > 0:
                            wait = min(wait, idle_left)
                    try:
                        child.communicate(input_data, timeout=wait)
                        break
                    except subprocess.TimeoutExpired:
                        input_data = None
                if role in ('builder', 'ultraviewer'):
                    capture_session(event_log, record)
            record['exit_code'] = child.returncode
            if child.returncode != 0:
                raise ValueError(f'Agent exit {child.returncode}; inspect {attempt / "run.log"}')
            try:
                output = read(result)
            except (OSError, ValueError) as error:
                raise DeliveryError(f'Missing or invalid result: {error}') from error
            if not isinstance(output, dict):
                raise DeliveryError('Result must be a JSON object')
            if output.get('task_id') != task_id or output.get('status') not in STATUSES:
                raise DeliveryError('Missing or invalid result task_id/status')
            if not isinstance(output.get('artifacts'), list) or not isinstance(output.get('summary'), str):
                raise DeliveryError('Result must include summary and artifacts array')
            for artifact in output['artifacts']:
                if not isinstance(artifact, str) or not Path(artifact).is_absolute() or not Path(artifact).is_file():
                    raise DeliveryError(f'Artifact missing or not absolute: {artifact}')
            record['status'] = output['status']
            record['after_snapshot'] = snapshot(state['repo'])
            delivery_files = [str(result), str(prompt), *output['artifacts']]
            for resolution in output.get('corrections', {}).values():
                delivery_files.extend(resolution.get('evidence', []))
            record['evidence_hashes'] = evidence_hashes(delivery_files)
            if output['status'] == 'completed':
                try:
                    check_task(attempt, record)
                    check_dependencies(run, record)
                    check_corrections(run, attempt, output)
                except ValueError as error:
                    record['status'] = 'needs_changes'
                    record['error'] = str(error)
                    if isinstance(error, DeliveryError):
                        record['failure_kind'] = 'delivery'
        except (Exception, KeyboardInterrupt) as error:
            record['status'] = 'blocked'
            record['error'] = str(error) or 'Interrupted'
            if isinstance(error, DeliveryError):
                record['failure_kind'] = 'delivery'
            record['finished_at'] = time.time()
            record['duration_seconds'] = record['finished_at'] - record['started_at']
            write(attempt / 'execution.json', record)
            if child and nested:
                # Fail the containing external stage too; its outer launcher records failure.
                stop_group(os.getpgrp())
        finally:
            if child and not nested:
                # Includes early agent exit and malformed output: no background child survives.
                stop_group(child.pid)
                child.wait()
            record['finished_at'] = time.time()
            record['duration_seconds'] = record['finished_at'] - record['started_at']
            if child:
                record['exit_code'] = child.returncode
            record['after_snapshot'] = snapshot(state['repo'])
            if redeliver and record['after_snapshot']['fingerprint'] != before['fingerprint']:
                record.update(status='needs_changes', failure_kind='workspace_changed',
                              error='Receipt repair changed the workspace; review implementation before acceptance')
            if prior_hashes:
                try:
                    if evidence_hashes(prior_hashes) != prior_hashes:
                        raise ValueError('Prior receipt or evidence was overwritten')
                except (ValueError, OSError) as error:
                    if record.get('failure_kind') != 'workspace_changed':
                        record.update(status='needs_changes', failure_kind='delivery_evidence_changed', error=str(error))
        write(attempt / 'execution.json', record)
        emit_changes(run, events, task_id)
        return 0 if record['status'] == 'completed' else 2


def destination_instructions(name, state, context):
    """Bring output-directory instructions into agents launched from the code repo."""
    folders = {'after-plan': 'cowork-plan', 'after-verify': 'cowork-report'}
    root = Path.home() / 'Desktop'
    if name in folders:
        root /= folders[name]
    selected = context.get('output_dir')
    if selected is not None and (not isinstance(selected, str) or not Path(selected).is_absolute()):
        raise ValueError('Hook output_dir must be an absolute directory path')
    target = Path(selected).resolve() if selected else root.resolve()
    instructions = []
    for ancestor in (*reversed(target.parents), target):
        path = ancestor / 'AGENTS.md'
        try:
            content = path.read_text()
        except FileNotFoundError:
            continue
        instructions.append({'path': str(path), 'content': content})
    try:
        branch = git(state['repo'], 'symbolic-ref', '--quiet', '--short', 'HEAD').decode().strip()
    except subprocess.CalledProcessError:
        branch = 'detached-' + git(state['repo'], 'rev-parse', '--short', 'HEAD').decode().strip()
    run_date = state['run_id'][:8]
    if not re.fullmatch(r'\d{8}', run_date):
        run_date = datetime.datetime.now().strftime('%Y%m%d')
    metadata = {'default_root': str(root.resolve()), 'output_dir': selected,
                'branch': branch, 'run_date': run_date, 'instructions': instructions}
    return ('\nOutput destination rules (read before selecting paths or writing):\n'
            + json.dumps(metadata, ensure_ascii=False, indent=2)
            + '\nApply these directory rules to the deliverables, including naming and language. '
              'Skill paths are defaults, not permission to override destination AGENTS.md. '
              'After selecting the final directory, read any deeper AGENTS.md on its ancestor chain before writing. '
              'Report the actual output paths and applicable instruction paths in the result.\n')


def hook(args):
    run = Path(args.run).resolve()
    state = read(run / 'state.json')
    context = read(args.context)
    required = ('stage', 'attempt', 'plan_version', 'git_range', 'outcome', 'evidence')
    if any(key not in context for key in required):
        raise ValueError('Hook context requires: ' + ', '.join(required))
    task_id = f'hook-{args.name}-{args.key}'
    if args.name not in DEFAULT_HOOKS and not args.prompt:
        directory = run / 'tasks' / task_id
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', task_id):
            raise ValueError('Invalid hook key')
        with task_lock(directory):
            write(directory / 'noop.json', {'hook': args.name, 'status': 'noop', 'context': context})
        print(json.dumps({'hook': args.name, 'status': 'noop'}))
        return 0
    brief = (Path(__file__).resolve().parent.parent / 'references/hooks.md').read_text()
    brief += '\nExecute only hook: ' + args.name + '\nContext:\n' + json.dumps(context, ensure_ascii=False)
    brief += destination_instructions(args.name, state, context)
    if args.prompt:
        brief += '\nAdditional hook instructions:\n' + Path(args.prompt).read_text()
    return execute(run, task_id, 'hook', brief, args.retry, args.timeout, {'hook': args.name, 'context': context})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for name in ('preflight', 'init'):
        p = sub.add_parser(name)
        p.add_argument('--repo', default='.')
        p.add_argument('--skill-root', action='append', default=[])
        if name == 'init':
            p.add_argument('--goal', required=True)
            p.add_argument('--leader', help='Optional main-agent label for diagnostics; does not select or restrict a model')
            p.add_argument('--dependencies-checked', action='store_true')
            p.add_argument('--state-root')
    for name in ('launch', 'hook', 'status', 'watch'):
        p = sub.add_parser(name)
        p.add_argument('--run', required=True)
        if name in ('launch', 'hook'):
            p.add_argument('--prompt', required=name == 'launch')
            p.add_argument('--retry', action='store_true')
            p.add_argument('--timeout', type=int, default=3600)
        if name == 'launch':
            p.add_argument('--task-id', required=True)
            p.add_argument('--role', choices=[r for r in ROLES if r != 'hook'], required=True)
            p.add_argument('--unit', help='Stable Plan module ID; mandatory for Builder, shared across splits/retries')
            p.add_argument('--after', action='append', default=[], help='Required accepted predecessor task; repeat for multiple dependencies')
            p.add_argument('--redeliver', action='store_true', help='Repair only the receipt, resuming this task\'s captured Builder session')
            p.add_argument('--fresh-session-reason', help='Explicit recovery reason when the prior session cannot be resumed')
        if name == 'status':
            p.add_argument('--verbose', action='store_true', help='Include full records and fingerprints for targeted diagnosis')
            p.add_argument('--task-id', help='Only inspect this task')
        if name == 'watch':
            p.add_argument('--timeout', type=float, default=3600)
        if name == 'hook':
            p.add_argument('--name', choices=HOOKS, required=True)
            p.add_argument('--key', required=True, help='Logical stage attempt or Plan version; reuse for retries')
            p.add_argument('--context', required=True)
    for name in ('budget', 'correct', 'retract', 'ack', 'checkpoint', 'gate', 'accept', 'reconcile'):
        p = sub.add_parser(name)
        p.add_argument('--run', required=True)
        if name in ('budget', 'correct', 'retract'):
            p.add_argument('--unit', required=True)
        if name in ('ack', 'checkpoint', 'gate'):
            p.add_argument('--attempt', required=True)
        if name in ('correct', 'retract', 'ack'):
            p.add_argument('--issue', required=True)
        if name == 'budget':
            p.add_argument('--seconds', type=float, help='Omitted fields retain existing values')
            p.add_argument('--idle-seconds', type=float)
            p.add_argument('--max-retries', type=int)
            p.add_argument('--reason', required=True)
            p.add_argument('--evidence', action='append', default=[])
        if name == 'correct':
            p.add_argument('--message', required=True)
            p.add_argument('--task-id', help='Only this task and its retries; omitted means the whole unit')
        if name == 'retract':
            p.add_argument('--reason', required=True)
        if name in ('ack', 'retract'):
            p.add_argument('--revision', required=True, type=int)
        if name == 'checkpoint':
            p.add_argument('--summary', required=True)
            p.add_argument('--next', required=True)
            p.add_argument('--evidence', action='append', default=[])
        if name in ('accept', 'reconcile'):
            p.add_argument('--task-id', required=True)
        if name == 'reconcile':
            p.add_argument('--reason', required=True)
            p.add_argument('--processes-checked', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'preflight':
            result = preflight(Path(args.repo).resolve(), args.skill_root)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result['ok'] else 2
        if args.action == 'init':
            return initialize(args)
        run = Path(args.run).resolve()
        pinned = read(run / 'state.json').get('helper')
        if args.action not in ('status', 'watch') and pinned and Path(pinned).resolve() != Path(__file__).resolve():
            raise ValueError(f'Use the pinned run helper: {pinned}')
        if args.action == 'hook':
            return hook(args)
        if args.action == 'budget':
            print(json.dumps(configure_budget(run, args.unit, args.seconds, args.max_retries, args.idle_seconds, args.reason, args.evidence), ensure_ascii=False))
            return 0
        if args.action == 'correct':
            print(json.dumps(correct(run, args.unit, args.issue, args.message, args.task_id), ensure_ascii=False))
            return 0
        if args.action == 'retract':
            print(json.dumps(retract(run, args.unit, args.issue, args.revision, args.reason), ensure_ascii=False))
            return 0
        if args.action == 'ack':
            acknowledge(run, args.attempt, args.issue, args.revision)
            return 0
        if args.action == 'checkpoint':
            checkpoint(run, args.attempt, args.summary, args.next, args.evidence)
            return 0
        if args.action == 'gate':
            attempt = attempt_path(run, args.attempt)
            record = read(attempt / 'execution.json')
            check_task(attempt, record)
            check_dependencies(run, record)
            check_corrections(run, attempt, read(attempt / 'result.json'))
            return 0
        if args.action == 'accept':
            accept(run, args.task_id)
            return 0
        if args.action == 'reconcile':
            reconcile(run, args.task_id, args.reason, args.processes_checked)
            return 0
        if args.action == 'launch':
            return execute(run, args.task_id, args.role, Path(args.prompt).read_text(), args.retry, args.timeout,
                           unit=args.unit, after=args.after, redeliver=args.redeliver, fresh_session_reason=args.fresh_session_reason)
        if args.action == 'watch':
            watch(run, args.timeout)
            return 0
        status = run_status(run)
        if args.task_id:
            status['tasks'] = [entry for entry in status['tasks'] if entry['task_id'] == args.task_id]
            status['attention'] = [task for task in status['attention'] if task == args.task_id]
        print(json.dumps(status if args.verbose else compact_status(status), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
