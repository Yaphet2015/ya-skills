import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import time
from types import SimpleNamespace
import uuid


TERMINAL_HOST_STATES = {'ended', 'cancelled', 'completed', 'stopped'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def branch(engine, repo):
    result = subprocess.run(['git', '-C', str(repo), 'symbolic-ref', '--quiet', '--short', 'HEAD'],
                            capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else 'detached-' + engine.git(repo, 'rev-parse', '--short', 'HEAD').decode().strip()


def identity(engine, repo):
    root = Path(engine.git(repo, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    if root != Path(repo).resolve():
        raise ValueError('Registration must name the canonical repository root')
    origin = engine.git(repo, 'remote', 'get-url', 'origin').decode().strip().removesuffix('.git').rstrip('/')
    project, _ = engine.project_identity(root)
    return {'path': str(root), 'origin': origin, 'project': project}


def snapshot(engine, repo):
    before = engine.snapshot(repo)
    content = hashlib.sha256()
    paths = set(engine.git(repo, 'ls-files', '-c', '-o', '--exclude-standard', '-z').split(b'\0')) - {b''}
    for raw in sorted(paths):
        path = Path(repo) / os.fsdecode(raw)
        if path.is_symlink():
            payload = os.fsencode(os.readlink(path))
            kind = b'link'
        elif path.is_file():
            payload = path.read_bytes()
            kind = b'executable' if path.stat().st_mode & stat.S_IXUSR else b'file'
        elif path.exists():
            raise ValueError(f'Unsupported source entry: {path}')
        else:
            continue
        for item in (raw, kind, payload):
            content.update(len(item).to_bytes(8, 'big'))
            content.update(item)
    after = engine.snapshot(repo)
    if before != after:
        raise ValueError('Workspace changed while capturing inputs; retry after writers stop')
    return {**after, 'content': content.hexdigest()}


def decision(engine, run, kind, value):
    directory = run / 'decisions'
    directory.mkdir(exist_ok=True)
    path = directory / f'{time.time_ns()}-{uuid.uuid4().hex[:8]}.json'
    engine.write(path, {'kind': kind, 'time': time.time(), **value})
    return str(path)


def dependency_pins(skills):
    pins = {}
    excluded = {'__pycache__', '.git', 'node_modules', '.venv'}
    for entry in skills.values():
        root = Path(entry).parent
        for path in root.rglob('*'):
            if path.is_file() and not excluded.intersection(path.relative_to(root).parts):
                pins[str(path)] = digest(path)
    return pins


def validate_contract(contract):
    if not isinstance(contract.get('goal'), str) or not contract['goal'].strip():
        raise ValueError('Contract requires a concrete goal')
    if not contract.get('acceptance') or not all(isinstance(x, str) and x.strip() for x in contract['acceptance']):
        raise ValueError('Contract requires acceptance criteria')
    if not contract.get('source'):
        raise ValueError('Contract requires the source user request')
    steps = contract.get('steps', [])
    seen = set()
    definitions = {}
    for step in steps:
        name = step.get('id', '')
        if not name or name in seen or not all(x in seen for x in step.get('after', [])):
            raise ValueError('Steps require unique IDs and dependencies earlier in the graph')
        if step.get('phase') not in ('plan', 'implement', 'verify') or not step.get('criteria'):
            raise ValueError('Each step requires a phase and criteria')
        if step.get('role') not in ('planner', 'builder', 'verifier', 'ultraviewer', 'worker', 'challenger', 'e2e-tester'):
            raise ValueError('Step requires a supported engine role')
        if step.get('role') == 'builder' and not step.get('unit'):
            raise ValueError('Builder requires a stable unit')
        for previous in step.get('supersedes', []):
            old = definitions.get(previous)
            if (not old or step['phase'] != 'verify' or old['phase'] != 'verify'
                    or step['role'] != old['role'] or not set(old['criteria']) <= set(step['criteria'])):
                raise ValueError('Replacement verification must preserve the earlier role and criteria')
        for check in step.get('checks', []):
            if not check.get('id') or not check.get('argv') or not all(isinstance(x, str) for x in check['argv']):
                raise ValueError('Checks require an ID and an argv array')
        seen.add(name)
        definitions[name] = step
    if not steps or not any(x['phase'] == 'verify' for x in steps):
        raise ValueError('A run requires steps and final verification')
    delivery = contract.get('delivery', {})
    for kind in ('commit', 'push', 'mr'):
        if delivery.get(kind) and not delivery.get('source'):
            raise ValueError('Delivery authorization requires its source request')
    if delivery.get('push') and not delivery.get('commit'):
        raise ValueError('Push policy must explicitly state commit authorization')


class Profile:
    def __init__(self, engine, args):
        self.engine = engine
        self.args = args
        self.snapshots = {}
        self.repo = Path(args.repo).resolve()
        self.root = (Path(args.root).expanduser() if args.root else self.repo.parent / '.fleet').resolve()
        if self.root.is_relative_to(self.repo):
            raise ValueError('Keep centralized state outside the repository')
        path = self.root / 'workspaces.json'
        self.manifest = engine.read(path) if path.is_file() else {'version': 1, 'workspaces': []}
        self.workspace = next((w for w in self.manifest['workspaces'] if w['path'] == str(self.repo)), None)
        if self.workspace and identity(engine, self.repo) != {k: self.workspace[k] for k in ('path', 'origin', 'project')}:
            raise ValueError('Registered repository identity changed; reconcile registration')

    def require_workspace(self):
        if not self.workspace:
            raise ValueError('Repository is not explicitly registered; no workflow was started')

    def runs(self, workspace=None):
        workspace = workspace or self.workspace
        if not workspace:
            return []
        result = []
        for run_id in workspace.get('runs', []):
            self.engine.safe_id(run_id)
            path = self.root / 'ultra-produce/logs' / run_id / 'state.json'
            value = self.engine.read(path)
            if value.get('profile') != 'cowork' or value.get('workspace_id') != workspace['id']:
                raise ValueError('Registered run association differs from the actual workspace')
            result.append((path.parent, value))
        return result

    def select(self):
        self.require_workspace()
        runs = self.runs()
        if not runs:
            raise ValueError('No Bankai task is registered for this workspace')
        run_id = getattr(self.args, 'run', None)
        if run_id:
            self.engine.safe_id(run_id)
            candidates = [x for x in runs if x[1]['run_id'] == run_id]
        else:
            session = getattr(self.args, 'session', None)
            candidates = [x for x in runs if session and session in x[1].get('sessions', [])]
            owner = self.owner()
            bound = [x for x in candidates if owner and x[1]['run_id'] == owner['run_id'] and owner['session'] == session]
            if bound:
                candidates = bound
            if not candidates:
                current_branch = branch(self.engine, self.repo)
                candidates = [x for x in runs if x[1]['branch'] == current_branch and not self.completed(x[0])]
            if not candidates and len(runs) == 1:
                candidates = runs
        if len(candidates) != 1:
            raise ValueError('Specify a run ID; candidates: ' + json.dumps([
                {'run_id': s['run_id'], 'goal': s['goal']} for _, s in candidates or runs]))
        return candidates[0]

    def contract(self, run):
        pins = self.engine.read(run / 'state.json').get('contract_hashes', {})
        self.engine.check_evidence(pins, 'Recorded task contract changed')
        paths = sorted(Path(p) for p in pins)
        if not paths:
            raise ValueError('Run contract is missing')
        return self.engine.read(paths[-1])

    def owner_path(self):
        return self.root / 'owners' / self.workspace['id'] / 'owner.json'

    def owner(self):
        path = self.owner_path()
        return self.engine.read(path) if path.is_file() else None

    def pinned(self, state):
        if Path(state['helper']).resolve() != Path(self.engine.__file__).resolve():
            raise ValueError(f'Use the pinned helper: {state["helper"]} cowork')

    def verify_owner(self, run, token=None):
        state = self.engine.read(run / 'state.json')
        self.pinned(state)
        owner = self.owner()
        token = token or getattr(self.args, 'token', None)
        if not owner or owner.get('released') or owner['run_id'] != state['run_id'] or owner['session'] != self.args.session or owner['token'] != token:
            raise ValueError('Workspace claim is missing, released, or belongs to another writer')
        if branch(self.engine, self.repo) != state['branch']:
            raise ValueError('Branch changed; reconcile the run before writing')
        return owner

    @contextlib.contextmanager
    def mutate(self, run):
        with self.engine.task_lock(self.owner_path().parent):
            self.verify_owner(run)
            if self.pending_actions(run) and self.args.command not in ('reconcile-action', 'release', 'checkpoint', 'writer'):
                raise ValueError('Reconcile unfinished actions before further work')
            yield

    def completed(self, run):
        return bool(list((run / 'decisions').glob('*-complete.json')))

    def records(self, run):
        contract = self.contract(run)
        records = []
        for step in contract['steps']:
            attempt = self.engine.latest_attempt(run, step['id'])
            record = self.engine.read(attempt / 'execution.json') if attempt else {}
            accepted = bool(record.get('accepted_at'))
            error = None
            if accepted:
                try:
                    self.engine.check_task(attempt, record)
                    self.engine.check_evidence(record['evidence_hashes'], 'Accepted evidence changed')
                    self.engine.check_corrections(run, attempt, self.engine.read(attempt / 'result.json'))
                except (ValueError, OSError, KeyError) as failure:
                    accepted, error = False, str(failure)
            records.append({'step': step, 'attempt': str(attempt) if attempt else None,
                            'record': record, 'accepted': accepted, 'error': error})
        return records

    def next(self, run):
        records = self.records(run)
        accepted = {x['step']['id'] for x in records if x['accepted']}
        for item in records:
            if not item['accepted'] and all(x in accepted for x in item['step'].get('after', [])):
                return item
        return None

    def verification(self, records):
        superseded = {name for item in records if item['accepted'] for name in item['step'].get('supersedes', [])}
        return [item for item in records if item['accepted'] and item['step']['phase'] == 'verify'
                and item['step']['id'] not in superseded]

    def pending_actions(self, run):
        return [str(p.parent) for p in sorted((run / 'actions').glob('*/intent.json'))
                if not (p.parent / 'result.json').is_file()]

    def inspect_run(self, run, state):
        records = self.records(run)
        if state['repo'] not in self.snapshots:
            self.snapshots[state['repo']] = snapshot(self.engine, state['repo'])
        current = self.snapshots[state['repo']]
        following = self.next(run)
        stale = []
        for item in self.verification(records):
            receipt = self.engine.read(Path(item['attempt']) / 'result.json')
            if receipt.get('inputs', {}).get('content') != current['content']:
                stale.append(item['step']['id'])
            for check in item['step'].get('checks', []):
                import cowork_actions
                result = self.engine.read(run / 'actions' / check['id'] / 'result.json')
                if result.get('runtime') != cowork_actions.runtime_inputs(state['repo'], check['argv'], check):
                    stale.append(item['step']['id'])
        blockers = [x['error'] for x in records if x['error']]
        pending = self.pending_actions(run)
        if pending:
            blockers.append('Reconcile unfinished actions before execution')
        if stale:
            blockers.append('Verification inputs changed: ' + ', '.join(stale))
        completion_paths = sorted((run / 'decisions').glob('*-complete.json'))
        if completion_paths:
            try:
                completion = self.engine.read(completion_paths[-1])
                self.engine.check_evidence(completion['evidence_hashes'], 'Final acceptance evidence changed')
            except (ValueError, OSError, KeyError) as error:
                blockers.append(str(error))
        completed = [x['step']['id'] for x in records if x['accepted']]
        running = any(x['record'].get('status') in self.engine.ACTIVE for x in records)
        done = bool(completion_paths) and not following and not blockers
        phase = following['step']['phase'] if following else 'ready'
        execution_status = 'running' if running else 'ready'
        next_action = following['step'] if following else 'finish'
        if stale and not following:
            next_action = 'revalidate'
        if blockers:
            execution_status = 'blocked'
        owner_file = self.root / 'owners' / state['workspace_id'] / 'owner.json'
        owner = self.engine.read(owner_file) if owner_file.is_file() else None
        if owner and owner['run_id'] == state['run_id'] and owner.get('released') and not done and not blockers:
            execution_status = 'paused' if owner.get('release_reason') == 'paused' else 'awaiting-continuation'
        if done:
            phase, execution_status, next_action = 'completed', 'completed', None
        return {'run_id': state['run_id'], 'goal': state['goal'], 'branch': state['branch'],
                'phase': phase, 'status': execution_status,
                'completed': completed, 'blockers': blockers,
                'next': next_action,
                'pending_actions': pending, 'inputs': current,
                'links': {'plan': str(run / 'contracts'), 'checks': str(run / 'actions'),
                          'review': [x['attempt'] for x in records if x['step']['role'] == 'ultraviewer'],
                          'history': str(run)}, 'helper': state['helper']}


def status(profile):
    args = profile.args
    if args.scope not in ('current', 'all'):
        raise ValueError('Supported Stage scopes: current, all')
    result = {'scope': args.scope, 'observed_at': time.time(), 'current': None, 'workspaces': []}
    if not profile.workspace:
        return {**result, 'registration': 'not registered'}
    try:
        run, state = profile.select()
        result['current'] = profile.inspect_run(run, state)
    except ValueError as error:
        result['selection'] = str(error)
    workspaces = [profile.workspace] if args.scope == 'current' else profile.manifest['workspaces']
    for workspace in workspaces:
        row = {'workspace': workspace['id'], 'path': workspace['path'],
               'current': workspace['id'] == profile.workspace['id']}
        try:
            if identity(profile.engine, workspace['path']) != {k: workspace[k] for k in ('path', 'origin', 'project')}:
                raise ValueError('Registered identity changed')
            owner_path = profile.root / 'owners' / workspace['id'] / 'owner.json'
            owner = profile.engine.read(owner_path) if owner_path.is_file() else None
            row.update(branch=branch(profile.engine, workspace['path']),
                       owner=owner if owner and not owner.get('released') else None,
                       tasks=[profile.inspect_run(r, s) for r, s in profile.runs(workspace)])
        except (ValueError, OSError, subprocess.CalledProcessError) as error:
            row['unavailable'] = str(error)
        result['workspaces'].append(row)
    return result


def check_observation(profile, owner):
    if not profile.args.observation:
        raise ValueError('Previous writer outcome is unknown; supply a fresh host observation')
    observation = profile.engine.read(profile.args.observation)
    if not observation.get('source') or not observation.get('evidence') or not 0 <= time.time() - observation.get('observed_at', 0) <= 120:
        raise ValueError('Host observation requires a source, evidence and a recent timestamp')
    states = observation.get('writers', {})
    expected = {owner['session'], *owner.get('writers', [])}
    if any(states.get(item) not in TERMINAL_HOST_STATES for item in expected):
        raise ValueError('Previous owner or delegated writer is active or unknown')
    return observation


def claim(profile, run, state):
    old = profile.owner()
    observation = None
    if old and not old.get('released'):
        if old['session'] == profile.args.session and old['run_id'] == state['run_id']:
            return old
        observation = check_observation(profile, old)
    claim_value = {'run_id': state['run_id'], 'session': profile.args.session,
                   'token': uuid.uuid4().hex, 'generation': (old or {}).get('generation', 0) + 1,
                   'writers': [], 'released': False, 'time': time.time(),
                   'reconciled_writers': sorted(set(([old['session']] if old else []) + list((observation or {}).get('writers', {}))))}
    decision(profile.engine, run, 'claim', {'owner': claim_value, 'previous': old, 'observation': observation})
    profile.engine.write(profile.owner_path(), claim_value)
    state['sessions'] = sorted(set(state.get('sessions', []) + [profile.args.session]))
    profile.engine.write(run / 'state.json', state)
    return claim_value


def start(profile):
    profile.require_workspace()
    if profile.args.invocation != 'bankai':
        raise ValueError('Only an explicit Bankai invocation starts execution')
    contract = profile.engine.read(profile.args.contract)
    validate_contract(contract)
    required = sorted({name for step in contract['steps'] for name in step.get('skills', [])})
    check = profile.engine.preflight(profile.repo, profile.args.skill_root, required)
    if not check['ok']:
        raise ValueError('Required dependencies unavailable: ' + json.dumps(check))
    with profile.engine.task_lock(profile.owner_path().parent):
        old = profile.owner()
        if old and not old.get('released'):
            raise ValueError('Workspace already has a writer; explicitly continue or reconcile it')
        args = SimpleNamespace(repo=str(profile.repo), skill_root=profile.args.skill_root,
                               profile='cowork', require_skill=required, dependencies_checked=True,
                               project_name=None, project_file=None,
                               root=str(profile.root / 'ultra-produce'), leader=profile.args.session,
                               goal=contract['goal'])
        run = profile.engine.create_run(args)
        if not isinstance(run, Path):
            raise ValueError('Required dependencies are unavailable')
        state = profile.engine.read(run / 'state.json')
        state.update(workspace_id=profile.workspace['id'], sessions=[], invocation='bankai', cowork_profile_version=1)
        (run / 'contracts').mkdir()
        contract_path = run / 'contracts/v0001.json'
        profile.engine.write(contract_path, contract)
        state['contract_hashes'] = {str(contract_path): digest(contract_path)}
        pins = dependency_pins(state['preflight']['skills'])
        profile.engine.write(run / 'dependencies.json', pins)
        profile.engine.write(run / 'state.json', state)
        with profile.engine.task_lock(profile.root / 'registry'):
            manifest = profile.engine.read(profile.root / 'workspaces.json')
            workspace = next(x for x in manifest['workspaces'] if x['id'] == profile.workspace['id'])
            workspace['runs'] = workspace.get('runs', []) + [state['run_id']]
            profile.engine.write(profile.root / 'workspaces.json', manifest)
            profile.workspace.update(workspace)
        owner = claim(profile, run, state)
        return {'run_id': state['run_id'], 'run': str(run), 'token': owner['token'],
                'helper': state['helper'], 'next': profile.next(run)['step']}


def resume(profile):
    if profile.args.invocation != 'bankai':
        raise ValueError('Only explicit Bankai continuation resumes execution')
    run, state = profile.select()
    if Path(state['helper']).resolve() != Path(profile.engine.__file__).resolve():
        return {'status': 'use-pinned-helper', 'helper': state['helper'], 'run_id': state['run_id'],
                'next': 'Repeat explicit continuation with this frozen helper'}
    profile.pinned(state)
    if branch(profile.engine, profile.repo) != state['branch']:
        raise ValueError('Run branch differs from the current workspace')
    with profile.engine.task_lock(profile.owner_path().parent):
        owner = claim(profile, run, state)
        return {**profile.inspect_run(run, state), 'token': owner['token'], 'run': str(run)}


def dependency_check(profile, run):
    pins = profile.engine.read(run / 'dependencies.json')
    profile.engine.check_evidence(pins, 'Pinned skill changed; revise dependencies before using it')


def prepare_step(profile, run):
    dependency_check(profile, run)
    if profile.pending_actions(run):
        raise ValueError('Reconcile unfinished action intents before preparing more work')
    item = profile.next(run)
    if not item:
        return profile.inspect_run(run, profile.engine.read(run / 'state.json'))
    step = item['step']
    if item['error']:
        raise ValueError(item['error'])
    previous = item['record']
    prior = Path(item['attempt']) if item['attempt'] else None
    if previous.get('status') in profile.engine.ACTIVE:
        if previous.get('agent_id') != profile.args.session:
            if previous.get('agent_id') not in profile.owner().get('reconciled_writers', []):
                return {'status': 'waiting', 'step': step, **profile.engine.notification(prior)}
            profile.engine.reconcile(run, step['id'], 'Previous owner handed over or host confirmed termination', True)
        else:
            return {'step': step, **profile.engine.notification(prior)}
    brief = json.dumps({'goal': profile.contract(run)['goal'], 'step': step}, indent=2)
    can_restore = prior and (prior / 'checkpoint.json').is_file() and profile.engine.read(prior / 'checkpoint.json').get('handoff')
    if prior:
        brief += f'\nInspect prior attempt and actual workspace before more work: {prior}\n'
    notification = profile.engine.prepare(run, step['id'], step['role'], brief,
                                         retry=bool(previous) and not can_restore,
                                         continue_from=str(prior) if can_restore else None,
                                         unit=step.get('unit'), after=step.get('after', []))
    attempt = Path(notification['attempt'])
    if not profile.args.defer_bind:
        profile.engine.bind(run, attempt, profile.args.session)
    return {'step': step, **profile.engine.notification(attempt)}


def bind_step(profile, run):
    attempt = profile.engine.latest_attempt(run, profile.args.step)
    if not attempt:
        raise ValueError('Prepare the step before binding a delegated agent')
    result = profile.engine.bind(run, attempt, profile.args.agent)
    if profile.args.agent != profile.args.session:
        owner = profile.verify_owner(run)
        owner['writers'] = sorted(set(owner['writers'] + [profile.args.agent]))
        profile.engine.write(profile.owner_path(), owner)
    return result


def complete_step(profile, run):
    step = next((x for x in profile.contract(run)['steps'] if x['id'] == profile.args.step), None)
    if not step:
        raise ValueError('Unknown step')
    attempt = profile.engine.latest_attempt(run, step['id'])
    if not attempt:
        raise ValueError('Prepare the step before delivering it')
    record = profile.engine.read(attempt / 'execution.json')
    if record.get('accepted_at'):
        profile.engine.check_evidence(record['evidence_hashes'], 'Accepted evidence changed')
        return profile.engine.notification(attempt)
    result = profile.engine.read(profile.args.result)
    current = snapshot(profile.engine, profile.repo)
    if result.get('inputs') != current:
        raise ValueError('Receipt must bind the current exact input snapshot')
    if result.get('status') != 'completed':
        raise ValueError('Deliver successful evidence only; checkpoint unfinished work instead')
    coverage = result.get('coverage', {})
    for criterion in step['criteria']:
        evidence = coverage.get(criterion, [])
        if not evidence:
            raise ValueError(f'Acceptance evidence is missing: {criterion}')
        for raw in evidence:
            profile.engine.output_path(run, raw)
        profile.engine.evidence_hashes(evidence)
        result.setdefault('artifacts', []).extend(evidence)
    for check in step.get('checks', []):
        import cowork_actions
        action = run / 'actions' / profile.engine.safe_id(check['id'])
        receipt = profile.engine.read(action / 'result.json')
        intent = profile.engine.read(action / 'intent.json')
        if (receipt.get('exit_code') != 0 or not receipt.get('valid') or receipt['after']['content'] != current['content']
                or intent.get('argv') != check['argv'] or receipt.get('output_hash') != digest(receipt['output'])
                or receipt.get('runtime') != cowork_actions.runtime_inputs(profile.repo, check['argv'], check)):
            raise ValueError(f'Check is failed, stale, or not the required command: {check["id"]}')
        result.setdefault('artifacts', []).extend([str(action / 'intent.json'), str(action / 'result.json'), receipt['output']])
    if not result.get('artifacts'):
        raise ValueError('Delivery requires artifact files')
    result['task_id'] = step['id']
    profile.engine.write(attempt / 'result.json', result)
    handoff = Path(profile.args.handoff).resolve()
    if not handoff.read_text().strip():
        raise ValueError('A complete handoff is required')
    target = attempt / 'handoff.md'
    if handoff != target:
        target.write_bytes(handoff.read_bytes())
    profile.engine.checkpoint(run, attempt, result.get('summary', 'Step delivered'),
                              'Select the next task after acceptance', result['artifacts'], handoff=str(target))
    notification = profile.engine.collect(run, attempt)
    if notification['status'] != 'completed':
        raise ValueError(f'Delivery rejected: {notification}')
    profile.engine.accept(run, step['id'])
    return profile.engine.notification(attempt)


def revise(profile, run):
    old = profile.contract(run)
    new = profile.engine.read(profile.args.contract)
    validate_contract(new)
    old_steps = {x['step']['id']: x for x in profile.records(run)}
    new_steps = {x['id']: x for x in new['steps']}
    for name, item in old_steps.items():
        if item['record'] and new_steps.get(name) != item['step']:
            raise ValueError('Started steps are immutable; append a new step for changed work')
    if new.get('delivery', {}) != old.get('delivery', {}):
        raise ValueError('Delivery authorization changes need a new sourced task contract')
    revisions = sorted((run / 'contracts').glob('v*.json'))
    if len(revisions) >= 4:
        raise ValueError('Three repair revisions exhausted; diagnose remaining blockers')
    required = sorted({name for step in new['steps'] for name in step.get('skills', [])})
    check = profile.engine.preflight(profile.repo, profile.args.skill_root, required)
    if not check['ok']:
        raise ValueError('Required skills unavailable: ' + json.dumps(check))
    path = run / 'contracts' / f'v{len(revisions) + 1:04d}.json'
    old_pins = profile.engine.read(run / 'dependencies.json')
    new_pins = dependency_pins(check['skills'])
    decision(profile.engine, run, 'contract-revision', {'previous': old, 'next': new, 'previous_dependencies': old_pins,
                                                     'dependencies': new_pins, 'reason': profile.args.reason})
    profile.engine.write(path, new)
    state = profile.engine.read(run / 'state.json')
    state['contract_hashes'][str(path)] = digest(path)
    profile.engine.write(run / 'state.json', state)
    profile.engine.write(run / 'dependencies.json', new_pins)
    return {'contract': str(path)}


def finish(profile, run):
    if profile.verify_owner(run).get('writers'):
        raise ValueError('Registered writers must stop before completion')
    if profile.next(run) or profile.pending_actions(run):
        raise ValueError('Unaccepted tasks or unfinished actions remain')
    view = profile.inspect_run(run, profile.engine.read(run / 'state.json'))
    if view['blockers']:
        raise ValueError(json.dumps(view['blockers']))
    findings = {}
    for item in profile.records(run):
        receipt = profile.engine.read(Path(item['attempt']) / 'result.json')
        for finding in receipt.get('findings', []):
            if not finding.get('id'):
                raise ValueError('Review findings require stable IDs')
            findings[finding['id']] = finding
    if any(x.get('required') and x.get('status') != 'closed' for x in findings.values()):
        raise ValueError('Required review findings remain open; deliver a verified resolution')
    for item in profile.verification(profile.records(run)):
        receipt = profile.engine.read(Path(item['attempt']) / 'result.json')
        if receipt['inputs']['fingerprint'] != view['inputs']['fingerprint']:
            decision(profile.engine, run, 'evidence-rebind', {'step': item['step']['id'],
                    'previous_inputs': receipt['inputs'], 'current_inputs': view['inputs'],
                    'reason': 'Verified materialized source contents are unchanged'})
    proof = profile.engine.read(profile.args.result)
    if set(proof.get('coverage', {})) != set(profile.contract(run)['acceptance']):
        raise ValueError('Final coverage must address every run acceptance criterion')
    for paths in proof['coverage'].values():
        if not paths:
            raise ValueError('Final coverage cannot omit evidence')
        for raw in paths:
            profile.engine.output_path(run, raw)
        profile.engine.evidence_hashes(paths)
    path = run / 'decisions' / f'{time.time_ns()}-complete.json'
    evidence = [p for paths in proof['coverage'].values() for p in paths]
    profile.engine.write(path, {'coverage': proof['coverage'], 'evidence_hashes': profile.engine.evidence_hashes(evidence),
                                'inputs': view['inputs'], 'time': time.time()})
    release(profile, run)
    return {'status': 'completed', 'run': str(run)}


def release(profile, run):
    owner = profile.verify_owner(run)
    if owner.get('writers'):
        raise ValueError('Registered writers must stop before releasing ownership')
    owner['released'] = True
    owner['release_reason'] = getattr(profile.args, 'reason', 'handover')
    profile.engine.write(profile.owner_path(), owner)
    decision(profile.engine, run, 'release', {'owner': owner})
    return {'released': True}


def parser():
    root = argparse.ArgumentParser(description='Explicit Bankai execution and read-only Stage status')
    root.add_argument('--repo', default='.')
    root.add_argument('--root')
    root.add_argument('--session', default='')
    root.add_argument('--run')
    root.add_argument('--token')
    root.add_argument('--skill-root', action='append', default=[])
    commands = root.add_subparsers(dest='command', required=True)
    view = commands.add_parser('status')
    view.add_argument('scope', nargs='?', default='all', choices=('current', 'all'))
    begin = commands.add_parser('start')
    begin.add_argument('--invocation', choices=('bankai',), required=True)
    begin.add_argument('--contract', required=True)
    continuation = commands.add_parser('continue')
    continuation.add_argument('--invocation', choices=('bankai',), required=True)
    continuation.add_argument('--observation')
    following = commands.add_parser('next')
    following.add_argument('--defer-bind', action='store_true')
    binding = commands.add_parser('bind-step')
    binding.add_argument('--step', required=True)
    binding.add_argument('--agent', required=True)
    deliver = commands.add_parser('deliver')
    deliver.add_argument('--step', required=True)
    deliver.add_argument('--result', required=True)
    deliver.add_argument('--handoff', required=True)
    revision = commands.add_parser('revise')
    revision.add_argument('--contract', required=True)
    revision.add_argument('--reason', required=True)
    done = commands.add_parser('finish')
    done.add_argument('--result', required=True)
    releasing = commands.add_parser('release')
    releasing.add_argument('--reason', choices=('handover', 'paused'), default='handover')
    import cowork_actions
    cowork_actions.add_arguments(commands)
    return root


def main(arguments, engine):
    args = parser().parse_args(arguments)
    try:
        profile = Profile(engine, args)
        if args.command == 'status':
            result = status(profile)
        else:
            if not args.session.strip():
                raise ValueError('Execution requires the actual owning session ID')
            if args.command == 'start':
                result = start(profile)
            elif args.command == 'continue':
                result = resume(profile)
            else:
                run, _ = profile.select()
                with profile.mutate(run):
                    handlers = {'next': prepare_step, 'bind-step': bind_step, 'deliver': complete_step, 'revise': revise,
                                'finish': finish, 'release': release}
                    if args.command in handlers:
                        result = handlers[args.command](profile, run)
                    else:
                        import cowork_actions
                        result = cowork_actions.execute(profile, run)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        if args.command == 'check' and not result.get('valid'):
            return 2
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(json.dumps({'status': 'blocked', 'error': str(error)}, ensure_ascii=True))
        return 2
