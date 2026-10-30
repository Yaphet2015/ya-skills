import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


BUILD = Path(__file__).resolve().parents[1] / 'skills'
ENGINE = BUILD / 'bankai/scripts/pipeline.py'


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bankai-test-')
        self.base = Path(self.temp.name).resolve()
        self.repo = self.base / 'repo-one'
        self.other = self.base / 'repo-two'
        self.root = self.base / 'state'
        for repo in (self.repo, self.other):
            repo.mkdir()
            self.git(repo, 'init', '-q')
            self.git(repo, 'config', 'user.email', 'test@example.invalid')
            self.git(repo, 'config', 'user.name', 'Workflow Test')
            self.git(repo, 'config', 'core.hooksPath', '/dev/null')
            self.git(repo, 'remote', 'add', 'origin', 'https://example.invalid/workflow.git')
            (repo / 'package.json').write_text('{"name":"RepositoryFixture"}\n')
            (repo / 'source.txt').write_text('original\n')
            self.git(repo, 'add', '.')
            self.git(repo, 'commit', '-qm', 'Initial fixture')
        self.root.mkdir()
        self.write(self.root / 'workspaces.json', {'version': 1, 'workspaces': [
            {'id': str(i), 'path': str(repo), 'git_dir': str((repo / '.git').resolve()), 'project': repo.name}
            for i, repo in enumerate((self.repo, self.other))]})
        self.helper = ENGINE
        self.run_id = self.token = None
        self.session = 'session-a'
        self.contract = {'goal': 'Preserve recoverable work', 'source': 'Explicit fixture request',
                         'acceptance': ['Verified behavior'], 'delivery': {'commit': True, 'source': 'Explicit test request'},
                         'steps': [
                             {'id': 'build', 'phase': 'implement', 'role': 'builder', 'unit': 'fixture',
                              'criteria': ['Implementation evidence']},
                             {'id': 'verify', 'phase': 'verify', 'role': 'verifier', 'after': ['build'],
                              'criteria': ['Verified behavior'],
                              'checks': [{'id': 'behavior-check', 'argv': [sys.executable, '-c', 'print("verified")']}]}]}

    def tearDown(self):
        self.temp.cleanup()

    def git(self, repo, *args):
        return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE).decode().strip()

    def write(self, path, value):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        return str(path)

    def call(self, *args, expected=0, session=None, repo=None):
        command = [sys.executable, '-B', str(self.helper), '--repo', str(repo or self.repo),
                   '--root', str(self.root), '--session', session or self.session]
        if self.run_id:
            command += ['--run', self.run_id]
        if self.token:
            command += ['--token', self.token]
        output = subprocess.run([*command, *args], capture_output=True, text=True)
        self.assertEqual(output.returncode, expected, output.stdout + output.stderr)
        return json.loads(output.stdout)

    def start(self):
        path = self.write(self.base / 'contract.json', self.contract)
        result = self.call('start', '--invocation', 'bankai', '--contract', path)
        self.run_id, self.token = result['run_id'], result['token']
        self.helper = Path(result['helper'])
        self.run = Path(result['run'])
        return result

    def source_snapshot(self):
        return self.call('status', 'current')['current']['inputs']

    def deliver(self, step, findings=None):
        next_step = self.call('next')
        self.assertEqual(next_step['step']['id'], step)
        attempt = Path(next_step['attempt'])
        artifact = attempt / 'artifacts/evidence.txt'
        artifact.write_text('Observed the required behavior.\n')
        criteria = next_step['step']['criteria']
        result = {'status': 'completed', 'summary': 'Verified task behavior', 'inputs': self.source_snapshot(),
                  'coverage': {x: [str(artifact)] for x in criteria}, 'artifacts': [str(artifact)],
                  'findings': findings or []}
        handoff = attempt / 'handoff.md'
        handoff.write_text('Goal, decisions, source references, completed facts, user changes and next work.\n')
        draft = self.write(self.base / 'draft.json', result)
        return self.call('deliver', '--step', step, '--result', draft, '--handoff', str(handoff))

    def tree(self):
        return {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.root.rglob('*') if p.is_file()}

    def test_status_has_no_execution_side_effects_and_obeys_scope(self):
        before = self.tree()
        current = self.call('status', 'current')
        self.assertEqual(len(current['workspaces']), 1)
        self.assertEqual(len(self.call('status', 'all')['workspaces']), 2)
        self.assertEqual(self.tree(), before)
        self.assertFalse((self.root / 'logs').exists())

    def test_current_does_not_query_missing_other_repository(self):
        self.git(self.other, 'remote', 'remove', 'origin')
        import shutil
        shutil.rmtree(self.other / '.git')
        current = self.call('status', 'current')
        self.assertNotIn('unavailable', current['workspaces'][0])
        all_rows = self.call('status', 'all')['workspaces']
        self.assertIn('unavailable', all_rows[1])

    def test_unregistered_same_named_repo_does_not_create_runtime(self):
        path = self.base / 'unregistered/repo-one'
        path.mkdir(parents=True)
        before = self.tree()
        self.assertEqual(self.call('status', repo=path)['registration'], 'not registered')
        self.call('start', '--invocation', 'bankai', '--contract', self.write(self.base / 'c.json', self.contract), repo=path, expected=2)
        self.assertEqual(before, self.tree())

    def test_declared_skills_are_required_but_unrelated_skills_are_not(self):
        self.contract['steps'][0]['skills'] = ['a-skill-that-is-not-installed']
        self.call('start', '--invocation', 'bankai', '--contract', self.write(self.base / 'c.json', self.contract), expected=2)
        self.assertFalse((self.root / 'logs').exists())

    def test_one_writer_and_generation_fences_old_owner(self):
        self.start()
        self.call('continue', '--invocation', 'bankai', session='session-b', expected=2)
        old = self.token
        self.call('release')
        result = self.call('continue', '--invocation', 'bankai', session='session-b')
        self.assertNotEqual(old, result['token'])
        self.call('next', expected=2)

    def test_idle_or_unknown_worker_never_allows_takeover(self):
        self.start()
        self.call('writer', '--id', 'child-a', '--state', 'active')
        observation = self.write(self.base / 'observation.json', {'source': 'test adapter', 'observed_at': time.time(),
                                  'evidence': ['fixture'], 'writers': {'session-a': 'ended', 'child-a': 'idle'}})
        self.call('continue', '--invocation', 'bankai', '--observation', observation, session='session-b', expected=2)
        self.call('release', expected=2)

    def test_resume_in_fresh_session_restores_handoff_without_repeating_work(self):
        self.start()
        prepared = self.call('next')
        artifact = Path(prepared['attempt']) / 'artifacts/partial.txt'
        artifact.write_text('Partial result that must survive recovery')
        handoff = Path(prepared['attempt']) / 'handoff.md'
        handoff.write_text('Completed partial work. Continue from partial.txt; do not reset source.\n')
        self.call('checkpoint', '--step', 'build', '--summary', 'Partial work saved', '--next', 'Finish verification',
                  '--handoff', str(handoff), '--evidence', str(artifact))
        self.call('release')
        resumed = self.call('continue', '--invocation', 'bankai', session='session-b')
        self.token, self.session = resumed['token'], 'session-b'
        next_step = self.call('next')
        recovery = json.loads((Path(next_step['attempt']) / 'recovery.json').read_text())
        self.assertEqual(recovery['handoff'], str(handoff))
        self.assertTrue(artifact.is_file())
        self.assertNotEqual(next_step['attempt'], prepared['attempt'])

    def test_source_changes_make_current_verification_stale(self):
        self.start()
        self.deliver('build')
        self.call('next')
        self.call('check', '--id', 'behavior-check', '--', sys.executable, '-c', 'print("verified")')
        self.deliver('verify')
        for name, data, staged in [('source.txt', b'changed\n', True), ('new.bin', b'\x00\xffnew', False)]:
            with self.subTest(name=name):
                (self.repo / name).write_bytes(data)
                if staged:
                    self.git(self.repo, 'add', name)
                current = self.call('status', 'current')['current']
                self.assertEqual(current['status'], 'blocked')
                self.assertTrue(any('inputs changed' in x for x in current['blockers']))

    def test_check_that_mutates_source_cannot_produce_a_green_receipt(self):
        command = [sys.executable, '-c', 'from pathlib import Path; Path("source.txt").write_text("mutated")']
        self.contract['steps'][1]['checks'][0]['argv'] = command
        self.start()
        self.deliver('build')
        self.call('next')
        result = self.call('check', '--id', 'behavior-check', '--', *command, expected=2)
        self.assertEqual(result['exit_code'], 0)
        self.assertFalse(result['valid'])

    def test_commit_completed_before_receipt_is_reconciled_once(self):
        self.start()
        parent = self.git(self.repo, 'rev-parse', 'HEAD')
        (self.repo / 'source.txt').write_text('new implementation\n')
        self.git(self.repo, 'add', 'source.txt')
        tree = self.git(self.repo, 'write-tree')
        path = self.write(self.base / 'expected.json', {'parent': parent, 'tree': tree})
        self.call('begin-action', '--id', 'commit-a', '--kind', 'commit', '--expected', path)
        self.git(self.repo, 'commit', '-qm', 'Implement fixture behavior')
        committed = self.git(self.repo, 'rev-parse', 'HEAD')
        self.call('release')
        result = self.call('continue', '--invocation', 'bankai', session='session-b')
        self.token, self.session = result['token'], 'session-b'
        receipt = self.call('reconcile-action', '--id', 'commit-a')
        self.assertEqual(receipt['commit'], committed)
        self.assertEqual(self.call('reconcile-action', '--id', 'commit-a'), receipt)
        self.assertEqual(self.git(self.repo, 'rev-list', '--count', 'HEAD'), '2')

    def test_finish_requires_current_coverage_and_releases_owner(self):
        self.start()
        self.deliver('build')
        self.call('next')
        self.call('check', '--id', 'behavior-check', '--', sys.executable, '-c', 'print("verified")')
        receipt = self.deliver('verify')
        evidence = Path(receipt['attempt']) / 'artifacts/evidence.txt'
        proof = self.write(self.base / 'final.json', {'coverage': {'Verified behavior': [str(evidence)]}})
        self.assertEqual(self.call('finish', '--result', proof)['status'], 'completed')
        view = self.call('status', 'current')
        self.assertEqual(view['current']['status'], 'completed')
        self.assertEqual(view['current']['phase'], 'completed')
        self.assertIsNone(view['current']['next'])
        self.assertIsNone(view['workspaces'][0]['owner'])

    def test_old_mr_or_completed_run_does_not_finish_a_new_task(self):
        self.start()
        first = self.run_id
        self.call('release')
        self.helper, self.run_id, self.token = ENGINE, None, None
        self.contract['goal'] = 'Separate follow-up with old MR still present'
        self.start()
        self.assertNotEqual(first, self.run_id)
        current = self.call('status', 'current')['current']
        self.assertEqual(current['completed'], [])
        self.assertEqual(current['next']['id'], 'build')

    def test_missing_accepted_artifact_cannot_be_reused(self):
        self.start()
        accepted = self.deliver('build')
        (Path(accepted['attempt']) / 'artifacts/evidence.txt').unlink()
        self.assertEqual(self.call('status', 'current')['current']['status'], 'blocked')
        self.call('next', expected=2)

    def test_existing_user_changes_are_backed_up_without_being_overwritten(self):
        (self.repo / 'source.txt').write_text('Existing user work\n')
        (self.repo / 'user.bin').write_bytes(b'\x00\x01user')
        self.start()
        self.assertIn('Existing user work', (self.run / 'baseline/worktree.patch').read_text())
        self.assertEqual((self.repo / 'source.txt').read_text(), 'Existing user work\n')
        self.assertEqual((self.repo / 'user.bin').read_bytes(), b'\x00\x01user')

    def test_concurrent_starts_admit_only_one_writer(self):
        (self.root / 'workspaces.json').unlink()
        path = self.write(self.base / 'contract.json', self.contract)
        processes = [subprocess.Popen([sys.executable, '-B', str(ENGINE), '--repo', str(self.repo),
                                       '--root', str(self.root), '--session', session, 'start',
                                       '--invocation', 'bankai', '--contract', path],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for session in ('writer-a', 'writer-b')]
        for process in processes:
            process.communicate(timeout=20)
        self.assertEqual(sorted(p.returncode for p in processes), [0, 2])
        self.assertEqual(len(list((self.root / 'logs').glob('*/state.json'))), 1)

    def test_staging_only_preserves_materialized_inputs(self):
        self.start()
        (self.repo / 'source.txt').write_text('same materialized contents\n')
        before = self.source_snapshot()
        self.git(self.repo, 'add', 'source.txt')
        after = self.source_snapshot()
        self.assertEqual(before['content'], after['content'])
        self.assertNotEqual(before['fingerprint'], after['fingerprint'])

    def test_required_finding_must_be_closed_before_finish(self):
        self.start()
        self.deliver('build', findings=[{'id': 'F1', 'required': True, 'status': 'open'}])
        self.call('next')
        self.call('check', '--id', 'behavior-check', '--', sys.executable, '-c', 'print("verified")')
        receipt = self.deliver('verify')
        evidence = Path(receipt['attempt']) / 'artifacts/evidence.txt'
        proof = self.write(self.base / 'final.json', {'coverage': {'Verified behavior': [str(evidence)]}})
        self.call('finish', '--result', proof, expected=2)

    def test_delivery_without_task_authorization_is_refused(self):
        self.contract['delivery'] = {'commit': False, 'push': False, 'mr': False}
        self.start()
        expected = self.write(self.base / 'expected.json', {'parent': 'anything', 'tree': 'anything'})
        self.call('begin-action', '--id', 'unauthorized', '--kind', 'commit', '--expected', expected, expected=2)

    def test_registration_is_idempotent_and_preserves_unrelated_repositories(self):
        for repo in (self.repo, self.other):
            (repo / 'AGENTS.md').write_text('Existing instructions.\n')
        before = self.tree()
        self.call('register')
        self.assertEqual(self.tree(), before)
        self.call('register', '--apply')
        applied = self.tree()
        self.call('register', '--apply')
        self.assertEqual(self.tree(), applied)
        self.assertEqual(len(json.loads((self.root / 'workspaces.json').read_text())['workspaces']), 2)
        self.assertEqual((self.repo / 'AGENTS.md').read_text(), 'Existing instructions.\n')
        self.assertFalse((self.repo / '.agents').exists())


    def test_bankai_rejects_the_deprecated_default_workflow(self):
        result = subprocess.run([sys.executable, '-B', str(ENGINE), 'init', '--repo', str(self.repo)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('invalid choice', result.stderr)
        self.assertEqual(self.tree().keys(), {'workspaces.json'})

    def test_standalone_bankai_installs_and_freezes_every_runtime_dependency(self):
        import shutil
        bundle = self.base / 'standalone'
        shutil.copytree(BUILD / 'bankai', bundle / 'bankai')
        self.helper = bundle / 'bankai/scripts/pipeline.py'
        self.start()
        frozen = self.helper.parent.parent
        self.assertEqual(frozen.name, 'skill')
        self.assertTrue((frozen / 'references/execution.md').is_file())
        shutil.rmtree(bundle)
        self.deliver('build')
        self.assertEqual(self.call('next')['step']['id'], 'verify')


    def test_current_never_reads_other_repositorys_runtime_records(self):
        self.start()
        command = [sys.executable, '-B', str(ENGINE), '--repo', str(self.other),
                   '--root', str(self.root), '--session', 'other-owner', 'start', '--invocation', 'bankai',
                   '--contract', self.write(self.base / 'other-contract.json', self.contract)]
        created = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(created.returncode, 0, created.stderr + created.stdout)
        other_run = Path(json.loads(created.stdout)['run'])
        (other_run / 'state.json').write_text('intentionally corrupt other-repository state')
        self.assertEqual(self.call('status', 'current')['current']['run_id'], self.run_id)
        all_rows = self.call('status', 'all')['workspaces']
        self.assertIn('unavailable', all_rows[1])

    def test_delegated_step_records_actual_executor_and_prevents_early_release(self):
        self.start()
        prepared = self.call('next', '--defer-bind')
        self.assertEqual(prepared['status'], 'prepared')
        self.call('bind-step', '--step', 'build', '--agent', 'actual-worker')
        record = json.loads((Path(prepared['attempt']) / 'execution.json').read_text())
        self.assertEqual(record['agent_id'], 'actual-worker')
        self.call('release', expected=2)

    def test_failed_check_exits_nonzero(self):
        command = [sys.executable, '-c', 'raise SystemExit(7)']
        self.contract['steps'][1]['checks'][0]['argv'] = command
        self.start()
        receipt = self.call('check', '--id', 'behavior-check', '--', *command, expected=2)
        self.assertEqual(receipt['exit_code'], 7)
        self.assertFalse(receipt['valid'])

    def test_repair_revalidates_changed_source_and_preserves_prior_receipts(self):
        self.start()
        self.deliver('build', findings=[{'id': 'F1', 'required': True, 'status': 'open'}])
        self.call('next')
        self.call('check', '--id', 'behavior-check', '--', sys.executable, '-c', 'print("verified")')
        original = self.deliver('verify')
        self.contract['steps'].extend([
            {'id': 'fix-r1', 'phase': 'implement', 'role': 'builder', 'unit': 'fixture', 'after': ['verify'],
             'criteria': ['Fixed F1']},
            {'id': 'verify-r1', 'phase': 'verify', 'role': 'verifier', 'after': ['fix-r1'], 'supersedes': ['verify'],
             'criteria': ['Verified behavior'],
             'checks': [{'id': 'behavior-check-r1', 'argv': [sys.executable, '-c', 'print("verified")']}]}])
        revision = self.write(self.base / 'revised.json', self.contract)
        self.call('revise', '--contract', revision, '--reason', 'Fix the required review finding')
        (self.repo / 'source.txt').write_text('Fixed implementation\n')
        self.deliver('fix-r1')
        self.call('next')
        self.call('check', '--id', 'behavior-check-r1', '--', sys.executable, '-c', 'print("verified")')
        latest = self.deliver('verify-r1', findings=[{'id': 'F1', 'required': True, 'status': 'closed'}])
        evidence = str(Path(latest['attempt']) / 'artifacts/evidence.txt')
        final = self.write(self.base / 'final.json', {'coverage': {'Verified behavior': [evidence]}})
        self.assertEqual(self.call('finish', '--result', final)['status'], 'completed')
        self.assertTrue((Path(original['attempt']) / 'result.json').is_file())
        self.assertEqual(len(list((self.run / 'contracts').glob('v*.json'))), 2)

    def test_ignored_validation_input_changes_invalidate_existing_checks(self):
        (self.repo / '.gitignore').write_text('settings.local\n')
        (self.repo / 'settings.local').write_text('first configuration\n')
        self.contract['steps'][1]['checks'][0]['inputs'] = ['settings.local']
        self.start()
        self.deliver('build')
        self.call('next')
        self.call('check', '--id', 'behavior-check', '--', sys.executable, '-c', 'print("verified")')
        self.deliver('verify')
        original = self.source_snapshot()['content']
        (self.repo / 'settings.local').write_text('changed configuration\n')
        current = self.call('status', 'current')['current']
        self.assertEqual(current['inputs']['content'], original)
        self.assertEqual(current['status'], 'blocked')

    def test_published_contract_cannot_be_silently_edited(self):
        self.start()
        path = self.run / 'contracts/v0001.json'
        changed = json.loads(path.read_text())
        changed['goal'] = 'An unrecorded replacement goal'
        path.write_text(json.dumps(changed))
        self.call('next', expected=2)

    def test_user_pause_stays_paused_until_explicit_continuation(self):
        self.start()
        self.call('release', '--reason', 'paused')
        self.assertEqual(self.call('status', 'current')['current']['status'], 'paused')
        self.call('next', expected=2)
        resumed = self.call('continue', '--invocation', 'bankai')
        self.assertNotEqual(self.token, resumed['token'])
        self.token = resumed['token']
        self.assertEqual(self.call('next')['step']['id'], 'build')

    def test_state_inside_repository_is_rejected(self):
        result = subprocess.run([sys.executable, '-B', str(ENGINE), '--root', str(self.repo / 'state'),
                                 '--repo', str(self.repo), 'register', '--apply'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.repo / 'state').exists())


    def test_first_start_registers_plain_repository_without_remote_or_manifest(self):
        self.git(self.repo, 'remote', 'remove', 'origin')
        (self.repo / 'package.json').unlink()
        (self.root / 'workspaces.json').unlink()
        before = self.tree()
        self.call('status')
        self.call('register')
        self.assertEqual(self.tree(), before)
        self.start()
        self.assertEqual(len(self.call('status')['workspaces']), 1)
        self.deliver('build')
        self.assertEqual(self.call('next')['step']['id'], 'verify')



    def test_unrelated_repositories_and_worktrees_have_independent_owners(self):
        self.start()
        self.call('register', '--apply', repo=self.other)
        contract = self.write(self.base / 'second-contract.json', self.contract)
        command = [sys.executable, '-B', str(ENGINE), '--root', str(self.root), '--repo', str(self.other),
                   '--session', 'second-session', 'start', '--invocation', 'bankai', '--contract', contract]
        other = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(other.returncode, 0, other.stdout + other.stderr)
        self.assertNotEqual(json.loads(other.stdout)['run_id'], self.run_id)
        worktree = self.base / 'worktree'
        self.git(self.repo, 'worktree', 'add', '-qb', 'test-worktree', str(worktree))
        self.call('register', '--apply', repo=worktree)
        rows = self.call('status', 'all')['workspaces']
        self.assertEqual(len(rows), 3)
        manifest = json.loads((self.root / 'workspaces.json').read_text())['workspaces']
        self.assertEqual(len({w['git_dir'] for w in manifest}), 3)

    def test_monorepo_manifest_names_and_remote_changes_do_not_change_identity(self):
        (self.repo / 'Cargo.toml').write_text('[package]\nname = "different-name"\n')
        (self.repo / 'pyproject.toml').write_text('[project]\nname = "another-name"\n')
        self.git(self.repo, 'remote', 'set-url', 'origin', 'https://example.invalid/another.git')
        self.start()
        self.assertEqual(self.call('status')['current']['run_id'], self.run_id)

    def test_new_repository_can_start_before_first_commit(self):
        path = self.base / 'empty'
        path.mkdir()
        self.git(path, 'init', '-q')
        contract = self.write(self.base / 'empty-contract.json', self.contract)
        result = subprocess.run([sys.executable, '-B', str(ENGINE), '--repo', str(path), '--root', str(self.root),
                                 '--session', 'empty-session', 'start', '--invocation', 'bankai', '--contract', contract],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


    def test_nested_directory_resolves_to_the_registered_repository(self):
        nested = self.repo / 'src/deep'
        nested.mkdir(parents=True)
        before = self.tree()
        rows = self.call('status', repo=nested)['workspaces']
        self.assertEqual(rows[0]['path'], str(self.repo))
        self.assertEqual(self.tree(), before)

    def test_submodule_content_changes_invalidate_snapshots_even_when_already_dirty(self):
        self.git(self.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', str(self.other), 'module')
        self.git(self.repo, 'commit', '-qam', 'Add submodule fixture')
        self.start()
        source = self.repo / 'module/source.txt'
        source.write_text('first modification\n')
        first = self.source_snapshot()['content']
        source.write_text('second modification\n')
        self.assertNotEqual(self.source_snapshot()['content'], first)


    def test_default_state_is_external_and_queries_do_not_create_it(self):
        home = self.base / 'home'
        home.mkdir()
        argv = [str(ENGINE), '--repo', str(self.repo), 'status']
        script = ('import pathlib,runpy,sys; from unittest.mock import patch; '
                  + 'sys.path.insert(0,' + repr(str(ENGINE.parent)) + '); sys.argv=' + repr(argv) + '; '
                  + 'context=patch.object(pathlib.Path,"home",return_value=pathlib.Path(' + repr(str(home)) + ')); '
                  + 'context.start(); runpy.run_path(' + repr(str(ENGINE)) + ',run_name="__main__")')
        result = subprocess.run([sys.executable, '-B', '-c', script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['registration'], 'not registered')
        self.assertEqual(list(home.iterdir()), [])
        argv = [str(ENGINE), '--repo', str(self.repo), 'register', '--apply']
        script = script.replace(repr([str(ENGINE), '--repo', str(self.repo), 'status']), repr(argv))
        registered = subprocess.run([sys.executable, '-B', '-c', script], capture_output=True, text=True)
        self.assertEqual(registered.returncode, 0, registered.stdout + registered.stderr)
        self.assertTrue((home / '.ya-skills/bankai/workspaces.json').is_file())
        self.assertFalse((self.repo / '.bankai').exists())


    def test_default_query_reports_matching_siblings_without_registering_them(self):
        self.git(self.repo, 'remote', 'set-url', 'origin', 'git@example.invalid:team/project.git')
        self.git(self.other, 'remote', 'set-url', 'origin', 'https://example.invalid/team/project')
        registry = json.loads((self.root / 'workspaces.json').read_text())
        registry['workspaces'] = registry['workspaces'][:1]
        self.write(self.root / 'workspaces.json', registry)
        (self.other / 'source.txt').write_text('pending work\n')
        before = self.tree()
        result = self.call('status')
        self.assertEqual([w['path'] for w in result['workspaces']], [str(self.repo), str(self.other)])
        other = result['workspaces'][1]
        self.assertFalse(other['registered'])
        self.assertEqual(other['match'], 'same-origin')
        self.assertEqual(other['dirty_files'], 1)
        self.assertEqual(other['tasks'], [])
        self.assertEqual(self.tree(), before)
        current = self.call('status', 'current')
        self.assertEqual(len(current['workspaces']), 1)
        self.assertNotIn('discovery', current)

    def test_default_query_excludes_different_projects_nested_repos_and_links(self):
        import shutil
        self.git(self.other, 'remote', 'set-url', 'origin', 'https://example.invalid/different.git')
        nested = self.base / 'container/nested'
        nested.parent.mkdir()
        self.git(self.base, 'clone', '-q', str(self.repo), str(nested))
        linked = self.base / 'linked'
        linked.symlink_to(self.other, target_is_directory=True)
        self.assertEqual(len(self.call('status')['workspaces']), 1)
        self.assertEqual(len(self.call('status', 'all')['workspaces']), 2)
        # Equal folder labels and source files never override different origins.
        self.assertEqual((self.other / 'source.txt').read_bytes(), (self.repo / 'source.txt').read_bytes())
        self.assertEqual(self.call('status')['workspaces'][0]['path'], str(self.repo))

    def test_default_query_discovers_worktrees_without_remote_or_registration(self):
        self.git(self.repo, 'remote', 'remove', 'origin')
        worktree = self.base / 'independent-label'
        self.git(self.repo, 'worktree', 'add', '-qb', 'peer-branch', str(worktree))
        (self.root / 'workspaces.json').unlink()
        before = self.tree()
        result = self.call('status')
        self.assertEqual(len(result['workspaces']), 2)
        self.assertTrue(result['workspaces'][0]['current'])
        self.assertFalse(result['workspaces'][1]['current'])
        self.assertEqual(result['workspaces'][1]['match'], 'shared-git-directory')
        self.assertEqual(result['workspaces'][1]['branch'], 'peer-branch')
        self.assertEqual(self.tree(), before)

    def test_default_query_recognizes_local_clone_and_handles_broken_neighbors(self):
        clone = self.base / 'arbitrary-label'
        self.git(self.base, 'clone', '-q', str(self.repo), str(clone))
        broken = self.base / 'broken'
        broken.mkdir()
        (broken / '.git').write_text('gitdir: missing\n')
        result = self.call('status')
        row = next(w for w in result['workspaces'] if w['path'] == str(clone))
        self.assertEqual(row['match'], 'local-clone-origin')
        self.assertTrue(result['discovery']['unavailable'])
        self.git(clone, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid:443/team/project.git')
        self.git(self.repo, 'remote', 'set-url', 'origin', 'https://example.invalid/team/project.git')
        self.assertNotIn(str(clone), [w['path'] for w in self.call('status')['workspaces']])


if __name__ == '__main__':
    unittest.main()
