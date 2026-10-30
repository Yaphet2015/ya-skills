import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from workflow import TERMINAL_HOST_STATES, decision, digest, snapshot


def runtime_inputs(repo, argv, definition):
    tools = {}
    names = [argv[0]]
    if Path(argv[0]).name in ('pnpm', 'npm', 'npx', 'node'):
        names.append('node')
    for name in names:
        resolved = shutil.which(name)
        if not resolved:
            raise ValueError(f'Check executable is unavailable: {name}')
        path = Path(resolved).resolve()
        info = path.stat()
        tools[str(path)] = {'size': info.st_size, 'mtime_ns': info.st_mtime_ns}
    environment = {name: hashlib.sha256(os.environ.get(name, '').encode()).hexdigest()
                   for name in set(['NODE_ENV', 'CI', 'TZ', *definition.get('environment', [])])}
    files = {}
    for raw in [*definition.get('inputs', []), 'node_modules/.modules.yaml']:
        path = (Path(repo) / raw).resolve()
        if not path.is_relative_to(Path(repo).resolve()):
            raise ValueError('Declared validation inputs must stay within the task repository')
        files[str(path)] = digest(path) if path.is_file() else None
    return {'tools': tools, 'environment': environment, 'files': files, 'helper_python': sys.version}


def add_arguments(commands):
    check = commands.add_parser('check')
    check.add_argument('--id', required=True)
    check.add_argument('argv', nargs='...')
    begin = commands.add_parser('begin-action')
    begin.add_argument('--id', required=True)
    begin.add_argument('--kind', choices=('edit', 'commit', 'push', 'mr', 'dispatch'), required=True)
    begin.add_argument('--expected', required=True)
    done = commands.add_parser('reconcile-action')
    done.add_argument('--id', required=True)
    done.add_argument('--proof')
    checkpoint = commands.add_parser('checkpoint')
    checkpoint.add_argument('--step', required=True)
    checkpoint.add_argument('--summary', required=True)
    checkpoint.add_argument('--next', required=True)
    checkpoint.add_argument('--handoff', required=True)
    checkpoint.add_argument('--evidence', action='append', default=[])
    writer = commands.add_parser('writer')
    writer.add_argument('--id', required=True)
    writer.add_argument('--state', choices=('active', 'ended'), required=True)
    writer.add_argument('--observation')


def directory(profile, run):
    return run / 'actions' / profile.engine.safe_id(profile.args.id)


def create_intent(profile, run, value):
    target = directory(profile, run)
    if (target / 'intent.json').is_file():
        previous = profile.engine.read(target / 'intent.json')
        if any(previous.get(k) != v for k, v in value.items()):
            raise ValueError('Action ID already binds a different operation')
        return target, previous
    target.mkdir(parents=True, exist_ok=True)
    intent = {**value, 'id': profile.args.id, 'run': run.name, 'session': profile.args.session,
              'token': profile.args.token, 'before': snapshot(profile.engine, profile.repo), 'time': time.time()}
    profile.engine.write(target / 'intent.json', intent)
    return target, intent


def check(profile, run):
    argv = profile.args.argv
    if argv[:1] == ['--']:
        argv = argv[1:]
    if not argv:
        raise ValueError('Check requires an argv array, without a shell')
    declared = [x for step in profile.contract(run)['steps'] for x in step.get('checks', []) if x['id'] == profile.args.id]
    if declared and any(x['argv'] != argv for x in declared):
        raise ValueError('Command differs from its declared check')
    target = directory(profile, run)
    existed = (target / 'intent.json').is_file()
    runtime = runtime_inputs(profile.repo, argv, declared[0] if declared else {})
    target, intent = create_intent(profile, run, {'kind': 'check', 'argv': argv, 'runtime': runtime})
    if (target / 'result.json').is_file():
        result = profile.engine.read(target / 'result.json')
        if result['after']['content'] != snapshot(profile.engine, profile.repo)['content']:
            raise ValueError('Check inputs changed; use a new check action ID in a revised contract')
        return result
    if existed:
        raise ValueError('Check outcome unknown; reconcile its process before retrying with a new ID')
    output = target / 'output.log'
    with output.open('wb') as log:
        process = subprocess.Popen(argv, cwd=profile.repo, stdout=log, stderr=subprocess.STDOUT)
        try:
            observation = subprocess.run(['ps', '-o', 'lstart=', '-p', str(process.pid)], capture_output=True, text=True)
            started = observation.stdout.strip() or None
        except OSError:
            started = None
        profile.engine.write(target / 'process.json', {'pid': process.pid, 'start_identity': started})
        owner = profile.verify_owner(run)
        writer_id = f'process:{process.pid}'
        owner['writers'] = sorted(set(owner['writers'] + [writer_id]))
        owner.setdefault('processes', {})[writer_id] = {'pid': process.pid, 'start_identity': started}
        profile.engine.write(profile.owner_path(), owner)
        code = process.wait()
        owner['writers'].remove(writer_id)
        owner['processes'].pop(writer_id)
        profile.engine.write(profile.owner_path(), owner)
    after = snapshot(profile.engine, profile.repo)
    after_runtime = runtime_inputs(profile.repo, argv, declared[0] if declared else {})
    result = {'exit_code': code, 'valid': code == 0 and intent['before']['content'] == after['content'] and runtime == after_runtime,
              'before': intent['before'], 'after': after, 'output': str(output),
              'output_hash': digest(output), 'runtime': after_runtime, 'time': time.time()}
    profile.engine.write(target / 'result.json', result)
    return result


def begin(profile, run):
    expected = profile.engine.read(profile.args.expected)
    kind = profile.args.kind
    if kind in ('commit', 'push', 'mr') and not profile.contract(run).get('delivery', {}).get(kind):
        raise ValueError(f'Current task does not authorize {kind}')
    if kind == 'commit' and not all(expected.get(k) for k in ('parent', 'tree')):
        raise ValueError('Commit intent requires the expected parent and tree')
    if kind == 'push' and not all(expected.get(k) for k in ('remote', 'ref', 'commit')):
        raise ValueError('Push intent requires remote, ref and expected commit')
    target, intent = create_intent(profile, run, {'kind': kind, 'expected': expected})
    result_path = target / 'result.json'
    return {'intent': intent, 'path': str(target),
            'result': profile.engine.read(result_path) if result_path.is_file() else None}


def reconcile(profile, run):
    target = directory(profile, run)
    intent = profile.engine.read(target / 'intent.json')
    result_path = target / 'result.json'
    if result_path.is_file():
        return profile.engine.read(result_path)
    expected = intent.get('expected', {})
    kind = intent['kind']
    if kind == 'commit':
        lines = profile.engine.git(profile.repo, 'log', '--format=%H %P %T', f'{expected["parent"]}..HEAD').decode().splitlines()
        matches = [line.split()[0] for line in lines if line.split()[1:] == [expected['parent'], expected['tree']]]
        if len(matches) != 1:
            raise ValueError('Commit outcome unknown; expected parent/tree not uniquely found')
        result = {'outcome': 'completed', 'commit': matches[0]}
    elif kind == 'push':
        if not expected['ref'].startswith('refs/heads/'):
            raise ValueError('Push reconciliation requires a full branch ref')
        lines = profile.engine.git(profile.repo, 'ls-remote', '--refs', expected['remote'], expected['ref']).decode().splitlines()
        if not any(line.split() == [expected['commit'], expected['ref']] for line in lines):
            raise ValueError('Remote result is unknown or differs; do not replay the push blindly')
        result = {'outcome': 'completed', 'remote': expected}
    elif kind == 'check':
        process = profile.engine.read(target / 'process.json') if (target / 'process.json').is_file() else None
        if process:
            current = subprocess.run(['ps', '-o', 'lstart=', '-p', str(process['pid'])], capture_output=True, text=True)
            if current.stderr.strip() or not process['start_identity']:
                raise ValueError('Process identity cannot be verified; obtain a terminal host observation')
            if current.stdout.strip() == process['start_identity']:
                raise ValueError('Check process is still active')
        result = {'outcome': 'interrupted', 'valid': False, 'exit_code': None,
                  'after': snapshot(profile.engine, profile.repo), 'output': str(target / 'output.log')}
    else:
        if not profile.args.proof:
            raise ValueError('External outcome requires an observed proof; no action was repeated')
        proof = profile.engine.read(profile.args.proof)
        if not proof.get('source') or not proof.get('evidence') or proof.get('expected') != expected:
            raise ValueError('Proof must identify the actual result and match the intended operation')
        evidence = [str(profile.engine.output_path(run, p)) for p in proof['evidence']]
        result = {'outcome': 'completed', 'proof': proof, 'evidence_hashes': profile.engine.evidence_hashes(evidence)}
    result.update(time=time.time(), reconciled_by=profile.args.session)
    profile.engine.write(result_path, result)
    return result


def checkpoint(profile, run):
    attempt = profile.engine.latest_attempt(run, profile.args.step)
    if not attempt:
        raise ValueError('Unknown active step')
    record = profile.engine.read(attempt / 'execution.json')
    if record.get('agent_id') != profile.args.session:
        raise ValueError('Only the actual step writer can publish its checkpoint')
    handoff = Path(profile.args.handoff).resolve()
    target = attempt / 'handoff.md'
    if handoff != target:
        target.write_bytes(handoff.read_bytes())
    return profile.engine.checkpoint(run, attempt, profile.args.summary, profile.args.next,
                                     profile.args.evidence, handoff=str(target))


def writer(profile, run):
    owner = profile.verify_owner(run)
    name = profile.args.id
    if name == owner['session']:
        raise ValueError('The owner session cannot be registered as its own delegated writer')
    writers = set(owner['writers'])
    if profile.args.state == 'active':
        writers.add(name)
    else:
        if not profile.args.observation:
            raise ValueError('Removing a writer requires a terminal host observation')
        proof = profile.engine.read(profile.args.observation)
        if (not proof.get('source') or not proof.get('evidence') or
                not 0 <= time.time() - proof.get('observed_at', 0) <= 120 or
                proof.get('writers', {}).get(name) not in TERMINAL_HOST_STATES):
            raise ValueError('Delegated writer is still active or its outcome is unknown')
        writers.discard(name)
    owner['writers'] = sorted(writers)
    profile.engine.write(profile.owner_path(), owner)
    decision(profile.engine, run, 'writers', {'owner': owner})
    return owner


def execute(profile, run):
    return {'check': check, 'begin-action': begin, 'reconcile-action': reconcile,
            'checkpoint': checkpoint, 'writer': writer}[profile.args.command](profile, run)
