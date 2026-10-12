"""Desktop-free process and artifact contract tests for the installed helper."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/produce-pipeline/scripts/pipeline.py'
spec = importlib.util.spec_from_file_location('pipeline', SCRIPT)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        (self.repo / 'tracked').write_text('base')
        self.git('add', 'tracked')
        self.git('commit', '-qm', 'base')
        self.run = self.root / 'run'
        self.run.mkdir()
        p.write(self.run / 'state.json', {'repo': str(self.repo), 'run_id': 'test', 'project': 'repo'})
        self.fake = self.root / 'fake.py'
        self.fake.write_text('''import json, pathlib, re, sys
args = sys.argv[1:]
if '--file' in args:
    text = pathlib.Path(args[args.index('--file') + 1]).read_text()
elif any(a.startswith('@') for a in args):
    text = pathlib.Path(next(a[1:] for a in args if a.startswith('@'))).read_text()
else:
    text = sys.stdin.read()
result = pathlib.Path(re.search(r'Result file \\(write JSON yourself\\): (.+)', text).group(1))
task = re.search(r'Required task_id: (.+)', text).group(1)
artifact = result.with_name('evidence.txt')
artifact.write_text(json.dumps(args))
print(json.dumps({'type': 'step_start', 'sessionID': 'ses_pipeline_test'}), flush=True)
if 'CHANGE_CODE' in text:
    pathlib.Path('tracked').write_text('changed by delivery')
if 'TAMPER_PRIOR' in text:
    prior = pathlib.Path(re.search(r'Prior attempt: (.+)', text).group(1))
    (prior / 'evidence.txt').write_text('overwritten')
if 'EXIT_FAIL' in text: sys.exit(7)
if 'NO_RESULT' in text: sys.exit(0)
if 'SLOW_CHECK' in text:
    import time
    print('about to run typecheck', flush=True)
    time.sleep(0.35)
if 'WAIT_FOREVER' in text:
    import time
    time.sleep(30)
if 'WAIT_RELEASE' in text:
    import time
    deadline = time.monotonic() + 5
    while not result.with_name('release').exists():
        if time.monotonic() >= deadline: sys.exit(11)
        time.sleep(0.01)
status = 'needs_decision' if 'QUESTION' in text else 'completed'
if 'MUTATE_TASK' in text:
    result.with_name('task.md').write_text(text + '\\nChanged after startup')
output = {'task_id': task, 'status': status, 'summary': 'observed', 'artifacts': [str(artifact)]}
if 'HANDLE_CORRECTIONS' in text:
    import subprocess
    helper = re.search(r'Helper script: (.+)', text).group(1)
    run = pathlib.Path(re.search(r'Run state: (.+)', text).group(1)).parent
    unit = re.search(r'Budget unit: (.+)', text).group(1)
    entries = json.loads((run / 'units' / unit / 'corrections.json').read_text())
    output['corrections'] = {}
    for issue, entry in entries.items():
        if entry.get('retracted_at') or entry.get('accepted_at') or entry.get('task_id') not in (None, task): continue
        subprocess.run([sys.executable, helper, 'ack', '--run', str(run), '--attempt', str(result.parent),
                        '--issue', issue, '--revision', str(entry['revision'])], check=True)
        output['corrections'][issue] = {'revision': entry['revision'], 'evidence': [str(artifact)]}
result.write_text(json.dumps(output))
''')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.PIPE)

    def launch(self, brief='Implement task', role='builder', retry=False, timeout=10):
        with patch.dict(p.ROLES, {role: [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
            return p.execute(self.run, 'task-a', role, brief, retry, timeout, unit='module-a' if role == 'builder' else None)

    def latest(self):
        return p.read(sorted((self.run / 'tasks/task-a').glob('attempt-*/execution.json'))[-1])

    def test_preflight_reports_missing_exact_names_without_writes(self):
        home = self.root / 'empty-home'
        home.mkdir()
        with patch.object(Path, 'home', return_value=home), patch.dict('os.environ', {'CODEX_HOME': str(home)}), patch.object(p.shutil, 'which', return_value='/fake/tool'):
            result = p.preflight(self.repo)
        self.assertFalse(result['ok'])
        self.assertIn('ultra-cr', result['missing_skills'])
        self.assertEqual(list(home.iterdir()), [])

    def test_dependency_recursion_and_no_alias(self):
        home = self.root / 'home'
        home.mkdir()
        root = self.repo / '.agents/skills'
        for name in (*p.REQUIRED, 'ultrareview'):
            target = root / name
            target.mkdir(parents=True)
            (target / 'SKILL.md').write_text(name)
        p.write(root / 'grill-with-docs/skill.json', {'dependsOn': ['grilling']})
        (root / 'ultra-cr/SKILL.md').unlink()
        with patch.object(Path, 'home', return_value=home), patch.dict('os.environ', {'CODEX_HOME': str(home)}), patch.object(p.shutil, 'which', return_value='/fake/tool'):
            result = p.preflight(self.repo)
        self.assertEqual(set(result['missing_skills']), {'grilling', 'ultra-cr'})

    def test_preflight_finds_brainstorming_and_symlinked_skill(self):
        home = self.root / 'home'
        home.mkdir()
        root = self.repo / '.codex/skills'
        root.mkdir(parents=True)
        installed = self.root / 'shared-skills'
        for name in p.REQUIRED:
            target = installed / name
            target.mkdir(parents=True)
            (target / 'SKILL.md').write_text(name)
            (root / name).symlink_to(target, target_is_directory=True)
        with patch.object(Path, 'home', return_value=home), patch.dict('os.environ', {'CODEX_HOME': str(home)}), patch.object(p.shutil, 'which', return_value='/fake/tool'):
            result = p.preflight(self.repo)
        self.assertTrue(result['ok'])
        self.assertIn('brainstorming', result['skills'])
        self.assertNotIn('brainstorm', result['skills'])
        self.assertEqual(result['skills']['ultra-cr'], str((installed / 'ultra-cr/SKILL.md').resolve()))

    def test_model_mapping_preserves_logos_defaults(self):
        prompt, result = self.root / 'prompt', self.root / 'result'
        logos = p.command('builder', str(self.repo), prompt, result)
        self.assertNotIn('-m', logos)
        self.assertNotIn('--variant', logos)
        self.assertEqual(logos[logos.index('--file') + 1:], [str(prompt)])
        glm = p.command('verifier', str(self.repo), prompt, result)
        self.assertEqual(glm[glm.index('--model') + 1], 'zai-coding-cn/glm-5.3')
        self.assertEqual(glm[glm.index('--thinking') + 1], 'max')
        planner = p.command('planner', str(self.repo), prompt, result)
        self.assertEqual(planner[planner.index('-m') + 1], 'gpt-6-astra')
        self.assertIn('model_reasoning_effort="medium"', planner)
        self.assertEqual(planner[planner.index('--enable') + 1], 'multi_agent')
        luna = p.command('e2e-tester', str(self.repo), prompt, result)
        self.assertEqual(luna[luna.index('-m') + 1], 'gpt-6-luna')
        self.assertIn('model_reasoning_effort="max"', luna)
        self.assertFalse(any('bypass' in item or 'skip-permissions' in item for item in logos + glm + luna))

    def test_all_transports_and_artifacts(self):
        for role in ('builder', 'verifier', 'e2e-tester', 'planner'):
            with self.subTest(role=role), patch.dict(p.ROLES, {role: [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(p.execute(self.run, role, role, 'Implement', unit='module-a' if role == 'builder' else None), 0)
                self.assertEqual(p.read(self.run / f'tasks/{role}/attempt-0001/execution.json')['status'], 'completed')

    def test_delivery_resumes_exact_session_and_preserves_prior_receipt(self):
        self.assertEqual(self.launch('NO_RESULT'), 2)
        first = self.run / 'tasks/task-a/attempt-0001/execution.json'
        original = first.read_bytes()
        self.assertEqual(self.latest()['session_id'], 'ses_pipeline_test')
        self.assertEqual(self.latest()['failure_kind'], 'delivery')
        with patch.dict(p.ROLES, {'builder': [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.execute(self.run, 'task-a', 'builder', 'Repair receipt only',
                unit='module-a', redeliver=True), 0)
        self.assertEqual(first.read_bytes(), original)
        record = self.latest()
        self.assertEqual(record['mode'], 'delivery')
        args = p.read(self.run / 'tasks/task-a/attempt-0002/evidence.txt')
        self.assertEqual(args[args.index('--session') + 1], 'ses_pipeline_test')
        self.assertNotIn('--continue', args)
        self.assertEqual(record['snapshot'], record['after_snapshot'])
        p.accept(self.run, 'task-a')

    def test_delivery_is_bounded_and_separate_from_implementation_retries(self):
        p.configure_budget(self.run, 'module-a', 30, 0, 10, 'No implementation retries')
        self.assertEqual(self.launch('NO_RESULT'), 2)
        with patch.dict(p.ROLES, {'builder': [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
            for _ in range(2):
                self.assertEqual(p.execute(self.run, 'task-a', 'builder', 'NO_RESULT',
                    unit='module-a', redeliver=True), 2)
            with self.assertRaisesRegex(ValueError, 'Delivery retry limit'):
                p.execute(self.run, 'task-a', 'builder', 'Repair receipt', unit='module-a', redeliver=True)

    def test_delivery_rejects_changed_workspace_and_cannot_hide_code_edits(self):
        self.launch()
        (self.repo / 'tracked').write_text('external change')
        with self.assertRaisesRegex(ValueError, 'Workspace changed'):
            p.execute(self.run, 'task-a', 'builder', 'Receipt', unit='module-a', redeliver=True)
        (self.repo / 'tracked').write_text('base')
        with patch.dict(p.ROLES, {'builder': [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.execute(self.run, 'task-a', 'builder', 'CHANGE_CODE',
                unit='module-a', redeliver=True), 2)
        self.assertEqual(self.latest()['failure_kind'], 'workspace_changed')
        with self.assertRaises(ValueError):
            p.accept(self.run, 'task-a')

    def test_compact_status_and_events_do_not_repeat_elapsed_time_or_large_records(self):
        self.launch()
        record = self.latest()
        record['error'] = 'x' * 10000
        p.write(self.run / 'tasks/task-a/attempt-0001/execution.json', record)
        status = p.compact_status(p.run_status(self.run))
        self.assertLess(len(json.dumps(status)), 2500)
        self.assertNotIn('snapshot', status['tasks'][0])
        previous = {}
        first = p.status_changes(status, previous)
        self.assertEqual(len(first), 1)
        status['tasks'][0]['seconds_without_progress'] = 100
        self.assertEqual(p.status_changes(status, previous), [])
        status['tasks'][0]['status'] = 'interrupted'
        self.assertEqual(len(p.status_changes(status, previous)), 1)

    def test_watch_detects_dead_launcher_without_reading_logs(self):
        self.launch()
        path = self.run / 'tasks/task-a/attempt-0001/execution.json'
        record = p.read(path)
        record['status'] = 'running'
        p.write(path, record)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            p.watch(self.run, timeout=1)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[0]['status'], 'interrupted')
        self.assertLess(len(output.getvalue()), 2500)

    def test_missing_session_requires_explicit_fallback_and_delivery_preserves_old_evidence(self):
        self.launch()
        path = self.run / 'tasks/task-a/attempt-0001/execution.json'
        record = p.read(path)
        record.pop('session_id')
        p.write(path, record)
        with self.assertRaisesRegex(ValueError, 'No captured session ID'):
            p.execute(self.run, 'task-a', 'builder', 'Receipt', unit='module-a', redeliver=True)
        with patch.dict(p.ROLES, {'builder': [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.execute(self.run, 'task-a', 'builder', 'TAMPER_PRIOR', unit='module-a',
                redeliver=True, fresh_session_reason='Legacy CLI did not emit a session envelope'), 2)
        self.assertEqual(self.latest()['failure_kind'], 'delivery_evidence_changed')
        with self.assertRaises(ValueError):
            p.accept(self.run, 'task-a')

    def test_session_capture_handles_partial_json_and_ignores_prose(self):
        log = self.root / 'events.log'
        log.write_text('INFO sessionID=ses_wrong\n{"type":"step_start","sessionID":')
        record = {}
        with log.open() as stream:
            p.capture_session(stream, record)
            self.assertNotIn('session_id', record)
            with log.open('a') as writer:
                writer.write('"ses_actual"}\n')
            p.capture_session(stream, record)
        self.assertEqual(record['session_id'], 'ses_actual')

    def test_cli_compact_status_and_watch_finish_with_small_events(self):
        self.launch()
        command = [sys.executable, str(SCRIPT)]
        compact = json.loads(subprocess.check_output(command + ['status', '--run', str(self.run)]))
        full = json.loads(subprocess.check_output(command + ['status', '--run', str(self.run), '--verbose']))
        self.assertNotIn('snapshot', compact['tasks'][0])
        self.assertIn('snapshot', full['tasks'][0])
        events = subprocess.check_output(command + ['watch', '--run', str(self.run), '--timeout', '1'])
        self.assertEqual(len(events.splitlines()), 1)
        self.assertEqual(json.loads(events)['status'], 'completed')

    def test_zero_exit_without_result_is_blocked(self):
        self.assertEqual(self.launch('NO_RESULT'), 2)
        self.assertEqual(self.latest()['status'], 'blocked')

    def test_questions_return_control_and_retry_keeps_previous(self):
        self.assertEqual(self.launch('QUESTION'), 2)
        self.assertEqual(self.latest()['status'], 'needs_decision')
        with self.assertRaises(ValueError):
            self.launch()
        self.assertEqual(self.launch('Decision supplied', retry=True), 0)
        self.assertEqual(len(list((self.run / 'tasks/task-a').glob('attempt-*/result.json'))), 2)

    def test_failure_and_timeout_preserve_evidence(self):
        self.assertEqual(self.launch('EXIT_FAIL'), 2)
        self.assertEqual(self.latest()['exit_code'], 7)
        self.assertEqual(self.launch('WAIT_FOREVER', retry=True, timeout=0.1), 2)
        self.assertEqual(self.latest()['status'], 'blocked')
        self.assertTrue((self.run / 'tasks/task-a/attempt-0002/run.log').exists())

    def test_duplicate_lock_prevents_spawn(self):
        with p.task_lock(self.run / 'tasks/task-a'):
            with self.assertRaises(ValueError):
                self.launch()
        self.assertFalse(list((self.run / 'tasks/task-a').glob('attempt-*')))

    def test_git_unchanged_and_evidence_invalidated_by_dirty_content(self):
        (self.repo / 'tracked').write_text('user edit')
        (self.repo / 'untracked').write_text('user file')
        baseline = p.snapshot(self.repo)
        self.assertEqual(self.launch(), 0)
        self.assertEqual(p.snapshot(self.repo), baseline)
        (self.repo / 'untracked').write_text('changed file')
        self.assertNotEqual(p.snapshot(self.repo)['fingerprint'], self.latest()['after_snapshot']['fingerprint'])

    def test_staged_content_changes_invalidate_fingerprint(self):
        (self.repo / 'tracked').write_text('stage one')
        self.git('add', 'tracked')
        (self.repo / 'tracked').write_text('worktree')
        before = p.snapshot(self.repo)
        (self.repo / 'tracked').write_text('stage two')
        self.git('add', 'tracked')
        (self.repo / 'tracked').write_text('worktree')
        after = p.snapshot(self.repo)
        self.assertEqual(before['status'], after['status'])
        self.assertNotEqual(before['fingerprint'], after['fingerprint'])

    def test_baseline_retains_user_hunks_and_untracked_content(self):
        (self.repo / 'tracked').write_text('user staged')
        self.git('add', 'tracked')
        (self.repo / 'tracked').write_text('user unstaged')
        (self.repo / 'new').write_bytes(b'user untracked')
        p.save_baseline(self.repo, self.run)
        baseline = self.run / 'baseline'
        self.assertIn('user staged', (baseline / 'index.patch').read_text())
        self.assertIn('user unstaged', (baseline / 'worktree.patch').read_text())
        saved = p.read(baseline / 'untracked.json')['new']['copy']
        self.assertEqual((baseline / saved).read_bytes(), b'user untracked')

    def test_init_requires_dependency_checks_and_missing_dependencies_create_no_run(self):
        from argparse import Namespace
        args = Namespace(repo=str(self.repo), skill_root=[], goal='test', leader='wrong', dependencies_checked=False, state_root=str(self.root / 'states'))
        with patch.object(p, 'preflight', return_value={'ok': False}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.initialize(args), 2)
        self.assertFalse((self.root / 'states').exists())
        with patch.object(p, 'preflight', return_value={'ok': True}):
            with self.assertRaises(ValueError):
                p.initialize(args)

    def test_nested_agent_group_stops_on_parent_timeout(self):
        import time
        # A nested helper shares the Verifier process group.
        nested = self.root / 'nested.py'
        marker = self.root / 'escaped'
        sleeper = self.root / 'sleeper.py'
        sleeper.write_text('import time, pathlib; time.sleep(1); pathlib.Path(' + repr(str(marker)) + ').touch()')
        nested.write_text("import importlib.util, pathlib, sys\n"
            + "s=importlib.util.spec_from_file_location('p', " + repr(str(SCRIPT)) + "); p=importlib.util.module_from_spec(s); s.loader.exec_module(p)\n"
            + "p.ROLES['builder']=[sys.executable, " + repr(str(sleeper)) + "]\n"
            + "p.execute(pathlib.Path(" + repr(str(self.run)) + "), 'nested', 'builder', 'Wait', timeout=10, unit='nested')\n")
        parent = self.root / 'parent.py'
        parent.write_text('import subprocess, sys; subprocess.run([sys.executable, ' + repr(str(nested)) + '])')
        with patch.dict(p.ROLES, {'verifier': [sys.executable, str(parent)]}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.execute(self.run, 'parent', 'verifier', 'Spawn child', timeout=0.5), 2)
        self.assertTrue((self.run / 'tasks/nested/attempt-0001/execution.json').exists())
        time.sleep(1)
        self.assertFalse(marker.exists(), 'Nested agent escaped parent timeout')

    def test_parent_early_exit_cleans_background_child(self):
        import time
        marker = self.root / 'escaped-early'
        parent = self.root / 'early.py'
        parent.write_text('import subprocess, sys; subprocess.Popen([sys.executable, "-c", '
            + repr('import time, pathlib; time.sleep(0.4); pathlib.Path(' + repr(str(marker)) + ').touch()')
            + ']); sys.exit(7)')
        with patch.dict(p.ROLES, {'verifier': [sys.executable, str(parent)]}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.execute(self.run, 'early', 'verifier', 'Spawn then exit'), 2)
        time.sleep(0.6)
        self.assertFalse(marker.exists())

    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError):
            p.execute(self.run, '../escape', 'builder', 'no')
        self.assertFalse((self.root / 'escape').exists())

    def test_status_reports_exit_before_stale_logs_and_lost_launcher(self):
        self.launch('EXIT_FAIL')
        attempt = self.run / 'tasks/task-a/attempt-0001'
        (attempt / 'run.log').write_text('Still thinking...')
        status = p.run_status(self.run)
        self.assertEqual(status['tasks'][0]['status'], 'blocked')
        self.assertEqual(status['tasks'][0]['exit_code'], 7)
        record = p.read(attempt / 'execution.json')
        record['status'] = 'running'
        p.write(attempt / 'execution.json', record)
        self.assertEqual(p.run_status(self.run)['tasks'][0]['status'], 'interrupted')

    def test_split_task_ids_share_budget_and_exhaustion_prevents_spawn(self):
        p.configure_budget(self.run, 'module-a', 30, 1, 10, 'Small test module')
        with patch.dict(p.ROLES, {'builder': [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
            for task in ('first', 'split-second'):
                self.assertEqual(p.execute(self.run, task, 'builder', 'EXIT_FAIL', unit='module-a'), 2)
            with patch.object(p.subprocess, 'Popen', side_effect=AssertionError('Must not spawn')):
                with self.assertRaisesRegex(ValueError, 'retry budget'):
                    p.execute(self.run, 'renamed-third', 'builder', 'Implement', unit='module-a')

    def test_cumulative_elapsed_budget_survives_success_and_task_rename(self):
        self.launch()
        record_path = self.run / 'tasks/task-a/attempt-0001/execution.json'
        record = p.read(record_path)
        record['duration_seconds'] = 10
        p.write(record_path, record)
        p.configure_budget(self.run, 'module-a', 10, 3, 10, 'Fixed module budget')
        with patch.object(p.subprocess, 'Popen', side_effect=AssertionError('Must not spawn')):
            with self.assertRaisesRegex(ValueError, 'time budget'):
                p.execute(self.run, 'renamed', 'builder', 'Implement', unit='module-a')

    def test_budget_cli_omitted_values_preserve_policy_and_invalid_write_is_atomic(self):
        p.configure_budget(self.run, 'module-a', 8700, 6, 1200, 'Initial policy')
        output = io.StringIO()
        with patch.object(sys, 'argv', ['pipeline', 'budget', '--run', str(self.run),
                '--unit', 'module-a', '--max-retries', '7', '--reason', 'Adjust retries']), contextlib.redirect_stdout(output):
            self.assertEqual(p.main(), 0)
        delta = json.loads(output.getvalue())
        self.assertEqual(delta['after'], {'seconds': 8700, 'idle_seconds': 1200, 'max_retries': 7})
        self.assertEqual(list(delta['changed']), ['max_retries'])
        path = self.run / 'units/module-a/budget.json'
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            p.configure_budget(self.run, 'module-a', -1, None, None, 'Invalid')
        self.assertEqual(path.read_bytes(), before)
        self.launch()
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'evidence'):
            p.configure_budget(self.run, 'module-a', 9000, None, None, 'Increase without evidence')
        self.assertEqual(path.read_bytes(), before)
        delta = p.configure_budget(self.run, 'new', None, None, None, 'Initial defaults')
        self.assertEqual(delta['after'], p.DEFAULT_BUDGET)

    def test_scoped_correction_keeps_upstream_dependency_valid_and_closes_only_target(self):
        self.launch()
        p.accept(self.run, 'task-a')
        p.correct(self.run, 'module-a', 'downstream', 'Use accepted API', task_id='dependent')
        p.correct(self.run, 'module-a', 'later', 'Preserve contract', task_id='later')
        p.accept(self.run, 'task-a')
        self.assertNotIn('accepted_at', p.corrections(self.run, 'module-a')['downstream'])
        with patch.dict(p.ROLES, {'builder': [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.execute(self.run, 'dependent', 'builder', 'HANDLE_CORRECTIONS',
                unit='module-a', after=['task-a']), 0)
        p.accept(self.run, 'dependent')
        self.assertIn('accepted_at', p.corrections(self.run, 'module-a')['downstream'])
        self.assertNotIn('accepted_at', p.corrections(self.run, 'module-a')['later'])
        self.assertEqual(p.run_status(self.run)['tasks'][0]['pending_corrections'], {})
        p.correct(self.run, 'module-a', 'contract', 'Whole unit contract changed')
        with self.assertRaisesRegex(ValueError, 'correction'):
            p.dependency_receipts(self.run, ['task-a'])
        with self.assertRaisesRegex(ValueError, 'scope'):
            p.correct(self.run, 'module-a', 'contract', 'Retarget', task_id='dependent')

    def test_retraction_preserves_history_and_republish_requires_new_ack(self):
        p.correct(self.run, 'module-a', 'issue', 'Wrong instruction', task_id='task-a')
        with self.assertRaisesRegex(ValueError, 'revision'):
            p.retract(self.run, 'module-a', 'issue', 2, 'Wrong version')
        p.retract(self.run, 'module-a', 'issue', 1, 'Incorrect target instruction')
        self.assertEqual(self.launch(), 0)
        p.accept(self.run, 'task-a')
        p.correct(self.run, 'module-a', 'issue', 'Correct instruction', task_id='task-a')
        entry = p.corrections(self.run, 'module-a')['issue']
        self.assertEqual(entry['revision'], 2)
        self.assertEqual(entry['history'][0]['retraction_reason'], 'Incorrect target instruction')
        with self.assertRaisesRegex(ValueError, 'correction'):
            p.dependency_receipts(self.run, ['task-a'])
        self.assertEqual(self.launch('HANDLE_CORRECTIONS', retry=True), 0)
        p.accept(self.run, 'task-a')

    def test_orphan_observation_and_reconcile_with_real_owned_worker(self):
        self.launch()
        attempt = self.run / 'tasks/task-a/attempt-0001'
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        try:
            record = self.latest()
            record.update(status='running', pid=child.pid, process_identity=p.process_identity(child.pid))
            if record['process_identity'] is None:
                self.assertEqual(p.owned_process_state(self.run, attempt, record), 'unknown')
                self.skipTest('Host denies ps; unknown-state contract checked, real observation needs ps access')
            p.write(attempt / 'execution.json', record)
            state = p.compact_status(p.run_status(self.run))['tasks'][0]
            self.assertEqual((state['status'], state['launcher_state'], state['worker_state']),
                             ('interrupted', 'absent', 'alive'))
            with self.assertRaisesRegex(ValueError, 'still alive'):
                p.reconcile(self.run, 'task-a', 'Checked processes', True)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                p.watch(self.run, timeout=0.03)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([e['event'] for e in events], ['task_changed', 'watch_expired'])
            child.kill()
            child.wait()
            self.assertEqual(p.run_status(self.run)['tasks'][0]['worker_state'], 'exited')
            p.reconcile(self.run, 'task-a', 'Owned processes exited, inspected artifacts', True)
            self.assertEqual(self.latest()['status'], 'blocked')
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()

    def test_process_identity_unknown_and_recorded_nested_worker(self):
        attempt = self.run / 'tasks/outer/attempt-0001'
        identity = {'pid': 101, 'pgid': 101, 'started': 'original'}
        record = {'process_identity': identity}
        self.assertEqual(p.owned_process_state(self.run, attempt, record, None), 'unknown')
        self.assertEqual(p.owned_process_state(self.run, attempt, {}, {}), 'unknown')
        reused = {101: {**identity, 'started': 'reused', 'zombie': False}}
        self.assertEqual(p.owned_process_state(self.run, attempt, record, reused), 'unknown')
        nested = self.run / 'tasks/nested/attempt-0001'
        nested.mkdir(parents=True)
        nested_identity = {'pid': 102, 'pgid': 101, 'started': 'child'}
        p.write(nested / 'execution.json', {'parent_attempt': str(attempt), 'process_identity': nested_identity})
        self.assertEqual(p.owned_process_state(self.run, attempt, record,
            {102: {**nested_identity, 'zombie': False}}), 'alive')
        self.assertEqual(p.owned_process_state(self.run, attempt, record, {}), 'exited')

    def test_missing_checkpoint_alerts_but_does_not_kill_active_worker(self):
        p.configure_budget(self.run, 'module-a', 10, 3, 0.1, 'Short inspection threshold')
        output = io.StringIO()
        with patch.dict(p.ROLES, {'builder': [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(output):
            self.assertEqual(p.execute(self.run, 'task-a', 'builder', 'SLOW_CHECK',
                unit='module-a', timeout=3), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        alerts = [event for event in events if event['event'] == 'inspection_needed']
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]['status'], 'running')
        self.assertNotIn('failure_kind', self.latest())
        self.assertEqual(events[-1]['status'], 'completed')
        self.assertEqual(p.run_status(self.run)['units']['module-a']['unsuccessful_attempts'], 0)

    def test_checkpoint_alert_does_not_disable_actual_execution_timeout(self):
        p.configure_budget(self.run, 'module-a', 10, 3, 0.05, 'Short inspection threshold')
        self.assertEqual(self.launch('WAIT_FOREVER', timeout=0.25), 2)
        self.assertEqual(self.latest()['failure_kind'], 'timeout')
        self.assertLess(self.latest()['duration_seconds'], 3)

    def test_valid_checkpoint_clears_inspection_and_repeat_status_is_quiet(self):
        self.launch()
        attempt = self.run / 'tasks/task-a/attempt-0001'
        record = self.latest()
        record.update(status='running', started_at=time.time() - 10, idle_seconds=1)
        p.write(attempt / 'execution.json', record)
        with p.task_lock(attempt.parent):
            previous = {}
            status = p.compact_status(p.run_status(self.run))
            self.assertIn('task-a', status['attention'])
            self.assertEqual(p.status_changes(status, previous)[0]['event'], 'inspection_needed')
            self.assertEqual(p.status_changes(p.compact_status(p.run_status(self.run)), previous), [])
            p.correct(self.run, 'module-a', 'behavior', 'Preserve existing behavior')
            self.assertEqual(p.status_changes(p.compact_status(p.run_status(self.run)), previous)[0]['event'], 'task_changed')
            evidence = self.root / 'diagnosis.txt'
            evidence.write_text('Typecheck started; fresh process evidence recorded')
            p.checkpoint(self.run, str(attempt), 'Typecheck active', 'Wait for result', [str(evidence)])
            status = p.compact_status(p.run_status(self.run))
            self.assertFalse(status['tasks'][0]['checkpoint_overdue'])

    def test_correction_requires_current_ack_and_evidence_before_acceptance(self):
        p.correct(self.run, 'module-a', 'quick-occupancy', 'Retain draft-reference occupancy')
        self.assertEqual(self.launch(), 2)
        self.assertEqual(self.latest()['status'], 'needs_changes')
        with self.assertRaises(ValueError):
            p.accept(self.run, 'task-a')
        self.assertEqual(self.launch('HANDLE_CORRECTIONS', retry=True), 0)
        attempt = self.run / 'tasks/task-a/attempt-0002'
        p.accept(self.run, 'task-a')
        self.assertTrue(p.read(attempt / 'execution.json')['accepted_at'])
        p.correct(self.run, 'module-a', 'quick-occupancy', 'Also protect a dangling draft reference')
        with self.assertRaisesRegex(ValueError, 'correction'):
            p.accept(self.run, 'task-a')

    def test_checkpoint_cannot_turn_repeated_text_into_progress(self):
        self.launch()
        attempt = self.run / 'tasks/task-a/attempt-0001'
        record = p.read(attempt / 'execution.json')
        record['status'] = 'running'
        p.write(attempt / 'execution.json', record)
        with p.task_lock(attempt.parent):
            p.checkpoint(self.run, attempt, 'Reading', 'Inspect the caller', [])
            first = p.read(attempt / 'checkpoint.json')
            p.checkpoint(self.run, attempt, 'Still reading', 'Inspect again', [])
            self.assertEqual(p.read(attempt / 'checkpoint.json')['last_progress_at'], first['last_progress_at'])
            evidence = self.root / 'contract.md'
            evidence.write_text('Caller X retains a draft reference even when files are empty.')
            p.checkpoint(self.run, attempt, 'Contract established', 'Add regression', [str(evidence)])
            second = p.read(attempt / 'checkpoint.json')
            self.assertGreater(second['last_progress_at'], first['last_progress_at'])
            p.checkpoint(self.run, attempt, 'Reworded summary', 'Add regression', [str(evidence)])
            self.assertEqual(p.read(attempt / 'checkpoint.json')['last_progress_at'], second['last_progress_at'])

    def test_reconcile_requires_ownership_check_and_cannot_touch_a_live_attempt(self):
        self.launch()
        path = self.run / 'tasks/task-a/attempt-0001/execution.json'
        record = p.read(path)
        record['status'] = 'running'
        p.write(path, record)
        with self.assertRaises(ValueError):
            p.reconcile(self.run, 'task-a', 'Inspected artifacts', False)
        with p.task_lock(path.parent.parent):
            with self.assertRaises(ValueError):
                p.reconcile(self.run, 'task-a', 'Inspected processes', True)
        p.reconcile(self.run, 'task-a', 'Owned process group ended; Git and artifacts inspected', True)
        self.assertEqual(p.run_status(self.run)['tasks'][0]['status'], 'blocked')
        self.assertGreater(p.read(path)['duration_seconds'], 0)

    def test_real_cli_delivers_mid_run_correction_and_accepts_verified_result(self):
        shim = self.root / 'logoscode'
        shim.write_text('#!' + sys.executable + '\n' + self.fake.read_text())
        shim.chmod(0o755)
        brief = self.root / 'brief.md'
        brief.write_text('WAIT_RELEASE HANDLE_CORRECTIONS')
        env = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ.get('PATH', '')}
        command = [sys.executable, str(SCRIPT)]
        process = subprocess.Popen(command + ['launch', '--run', str(self.run), '--task-id', 'live',
            '--role', 'builder', '--unit', 'module-a', '--prompt', str(brief), '--timeout', '8'],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.communicate(timeout=10))
        attempt = self.run / 'tasks/live/attempt-0001'
        deadline = time.monotonic() + 4
        while not (attempt / 'evidence.txt').exists():
            if time.monotonic() >= deadline:
                self.fail('Fake Builder did not start')
            time.sleep(0.01)
        subprocess.run(command + ['correct', '--run', str(self.run), '--unit', 'module-a',
            '--issue', 'occupancy', '--message', 'Preserve empty draft occupancy'], check=True, stdout=subprocess.DEVNULL)
        status = json.loads(subprocess.check_output(command + ['status', '--run', str(self.run)]))
        self.assertEqual(status['tasks'][0]['status'], 'running')
        self.assertFalse(status['tasks'][0]['pending_corrections']['occupancy']['acknowledged'])
        (attempt / 'release').touch()
        _, error = process.communicate(timeout=8)
        self.assertEqual(process.returncode, 0, error.decode())
        subprocess.run(command + ['accept', '--run', str(self.run), '--task-id', 'live'], check=True)
        self.assertTrue(p.read(attempt / 'execution.json')['accepted_at'])
        # A changed report cannot silently reuse the old delivery's acceptance.
        (attempt / 'evidence.txt').write_text('Different evidence')
        with self.assertRaisesRegex(ValueError, 'evidence changed'):
            p.accept(self.run, 'live')

    def test_init_pins_runnable_skill_snapshot_outside_repository(self):
        from argparse import Namespace
        args = Namespace(repo=str(self.repo), skill_root=[], goal='Small regression',
            leader='another-host/another-model', dependencies_checked=True, state_root=str(self.root / 'states'))
        output = io.StringIO()
        with patch.object(p, 'preflight', return_value={'ok': True}), contextlib.redirect_stdout(output):
            self.assertEqual(p.initialize(args), 0)
        run = Path(output.getvalue().strip())
        helper = Path(p.read(run / 'state.json')['helper'])
        self.assertEqual(p.read(run / 'state.json')['leader'], 'another-host/another-model')
        self.assertNotEqual(helper, SCRIPT)
        self.assertEqual(helper.read_bytes(), SCRIPT.read_bytes())
        status = json.loads(subprocess.check_output([sys.executable, str(helper), 'status', '--run', str(run)]))
        self.assertEqual(status['tasks'], [])
        self.assertTrue((run / 'skill/references/execution.md').is_file())
        self.assertFalse(list((run / 'skill').rglob('*.pyc')))
        wrong_helper = subprocess.run([sys.executable, str(SCRIPT), 'budget', '--run', str(run),
            '--unit', 'new', '--reason', 'Set initial budget'], capture_output=True, text=True)
        self.assertEqual(wrong_helper.returncode, 2)
        self.assertIn('pinned run helper', wrong_helper.stderr)

    def test_init_cli_does_not_require_main_agent_identity(self):
        output = io.StringIO()
        argv = ['pipeline.py', 'init', '--repo', str(self.repo), '--goal', 'Orchestrate',
                '--dependencies-checked', '--state-root', str(self.root / 'states')]
        with patch.object(sys, 'argv', argv), patch.object(p, 'preflight', return_value={'ok': True}), contextlib.redirect_stdout(output):
            self.assertEqual(p.main(), 0)
        run = Path(output.getvalue().strip())
        self.assertIsNone(p.read(run / 'state.json')['leader'])
        planner = p.command('planner', str(self.repo), self.root / 'prompt', self.root / 'result')
        self.assertEqual(planner[planner.index('-m') + 1], 'gpt-6-astra')
        self.assertIn('model_reasoning_effort="medium"', planner)

    def test_mutated_startup_task_cannot_pass_completion_or_acceptance(self):
        self.assertEqual(self.launch('MUTATE_TASK'), 2)
        self.assertEqual(self.latest()['status'], 'needs_changes')
        self.assertEqual(self.launch('Unchanged task', retry=True), 0)
        task = self.run / 'tasks/task-a/attempt-0002/task.md'
        task.write_text(task.read_text() + '\nA new requirement')
        with self.assertRaisesRegex(ValueError, 'task changed'):
            p.accept(self.run, 'task-a')

    def test_dependency_requires_acceptance_and_stays_bound_to_that_attempt(self):
        self.launch()
        with patch.dict(p.ROLES, {'builder': [sys.executable, str(self.fake)]}), contextlib.redirect_stdout(io.StringIO()):
            with patch.object(p.subprocess, 'Popen', side_effect=AssertionError('Must not spawn')):
                with self.assertRaisesRegex(ValueError, 'not accepted'):
                    p.execute(self.run, 'dependent', 'builder', 'Implement', unit='module-a', after=['task-a'])
            p.accept(self.run, 'task-a')
            self.assertEqual(p.execute(self.run, 'dependent', 'builder', 'Implement', unit='module-a', after=['task-a']), 0)
            # Reconfirming the same accepted predecessor does not invalidate its dependents.
            p.accept(self.run, 'task-a')
            p.accept(self.run, 'dependent')
        self.launch('EXIT_FAIL', retry=True)
        with self.assertRaisesRegex(ValueError, 'not accepted'):
            p.accept(self.run, 'dependent')

    def test_verification_stages_reuse_results_and_reject_changed_dependency(self):
        with patch.dict(p.ROLES, {role: [sys.executable, str(self.fake)]
                for role in ('verifier', 'ultraviewer', 'e2e-tester')}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(p.execute(self.run, 'verify-plan-r1', 'verifier', 'Coverage and task cards'), 0)
            p.accept(self.run, 'verify-plan-r1')
            for task, role in [('verify-review-r1', 'ultraviewer'), ('verify-tests-r1', 'e2e-tester')]:
                self.assertEqual(p.execute(self.run, task, role, 'Verify', after=['verify-plan-r1']), 0)
                p.accept(self.run, task)
            dependencies = ['verify-plan-r1', 'verify-review-r1', 'verify-tests-r1']
            evidence = self.run / 'tasks/verify-review-r1/attempt-0001/evidence.txt'
            saved = evidence.read_bytes()
            self.assertEqual(p.execute(self.run, 'verify-final-r1', 'verifier', 'EXIT_FAIL', after=dependencies), 2)
            self.assertEqual(p.execute(self.run, 'verify-final-r1', 'verifier', 'Summarize existing evidence',
                retry=True, after=dependencies), 0)
            p.accept(self.run, 'verify-final-r1')
            self.assertEqual(evidence.read_bytes(), saved)
            self.assertEqual(len(list((self.run / 'tasks/verify-review-r1').glob('attempt-*'))), 1)
            evidence.write_text('Changed report')
            with self.assertRaisesRegex(ValueError, 'evidence changed'):
                p.accept(self.run, 'verify-final-r1')

    def test_hook_dispatch_includes_destination_rules_outside_repo(self):
        from argparse import Namespace
        home = (self.root / 'home').resolve()
        home.mkdir()
        (home / 'AGENTS.md').write_text('所有交付先写结论。')
        context_path = self.root / 'context.json'
        for hook_name, folder in [('after-plan', 'cowork-plan'), ('after-verify', 'cowork-report')]:
            root = home / 'Desktop' / folder
            root.mkdir(parents=True)
            (root / 'AGENTS.md').write_text('所有报告必须使用中文。每个分支使用日期前缀的独立子目录。')
            selected = root / '20261010-feature' / 'run-one'
            selected.parent.mkdir()
            (selected.parent / 'AGENTS.md').write_text('本分支的文档使用短句。')
            sibling = root / 'unrelated'
            sibling.mkdir()
            (sibling / 'AGENTS.md').write_text('不属于本次输出的规则')
            p.write(context_path, {'stage': 'plan', 'attempt': 1, 'plan_version': 1,
                'git_range': 'base..head', 'outcome': 'pending', 'evidence': [],
                'output_dir': str(selected)})
            args = Namespace(run=str(self.run), context=str(context_path), name=hook_name,
                             key='v1', prompt=None, retry=False, timeout=10)
            with patch.object(Path, 'home', return_value=home), patch.object(p, 'execute', return_value=0) as dispatch:
                self.assertEqual(p.hook(args), 0)
            prompt = dispatch.call_args.args[3]
            for rule in [home / 'AGENTS.md', root / 'AGENTS.md', selected.parent / 'AGENTS.md']:
                self.assertIn(str(rule), prompt)
                self.assertIn(rule.read_text(), prompt)
            self.assertNotIn('不属于本次输出的规则', prompt)
            self.assertLess(prompt.index('所有交付先写结论。'), prompt.index('本分支的文档使用短句。'))
            self.assertFalse(selected.exists())

    def test_planner_gets_default_plan_rules_before_creating_final_plan(self):
        home = (self.root / 'home').resolve()
        root = home / 'Desktop/cowork-plan'
        root.mkdir(parents=True)
        rule = root / 'AGENTS.md'
        rule.write_text('最终方案必须中文，按分支组织目录。')
        with patch.object(Path, 'home', return_value=home):
            self.assertEqual(self.launch(role='planner'), 0)
        task = (self.run / 'tasks/task-a/attempt-0001/task.md').read_text()
        self.assertIn(str(rule), task)
        self.assertIn(rule.read_text(), task)
        # A failed instruction read must not dispatch or leave an unusable attempt.
        original_read = Path.read_text
        def guarded_read(path, *args, **kwargs):
            if path == rule:
                raise PermissionError('Instruction file is unreadable')
            return original_read(path, *args, **kwargs)
        with patch.object(Path, 'home', return_value=home), patch.object(Path, 'read_text', guarded_read):
            with patch.object(p.subprocess, 'Popen', side_effect=AssertionError('Must not launch')):
                with self.assertRaises(PermissionError):
                    p.execute(self.run, 'another-planner', 'planner', 'Plan')
        self.assertFalse((self.run / 'tasks/another-planner').exists())

    def test_unconfigured_hook_no_agent_and_custom_hook_transport(self):
        from argparse import Namespace
        context = self.root / 'context.json'
        p.write(context, {'stage': 'plan', 'attempt': 1, 'plan_version': 1, 'git_range': 'base..head', 'outcome': 'pending', 'evidence': []})
        args = Namespace(run=str(self.run), context=str(context), name='before-plan', key='v1', prompt=None, retry=False, timeout=10)
        with contextlib.redirect_stdout(io.StringIO()), patch.object(p.subprocess, 'Popen', side_effect=AssertionError('Unexpected model call')):
            self.assertEqual(p.hook(args), 0)
        self.assertEqual(p.read(self.run / 'tasks/hook-before-plan-v1/noop.json')['status'], 'noop')
        prompt = self.root / 'custom.md'
        prompt.write_text('Custom hook')
        args.prompt = str(prompt)
        with contextlib.redirect_stdout(io.StringIO()), patch.dict(p.ROLES, {'hook': [sys.executable, str(self.fake)]}):
            self.assertEqual(p.hook(args), 0)


if __name__ == '__main__':
    unittest.main()
