"""Desktop-free contracts for native-agent task, receipt and recovery files."""
import contextlib
import importlib.util
import io
import json
from argparse import Namespace
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/ultra-produce/scripts/pipeline.py'
spec = importlib.util.spec_from_file_location('pipeline', SCRIPT)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / 'directory-is-not-the-project-name'
        self.repo.mkdir()
        self.git('init', '-q', '-b', 'feature/a')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        (self.repo / 'tracked').write_text('base')
        p.write(self.repo / 'package.json', {'name': '@scope/project'})
        self.git('add', 'tracked', 'package.json')
        self.git('commit', '-qm', 'base')
        self.skills = self.root / 'skills'
        for name in p.REQUIRED:
            target = self.skills / name
            target.mkdir(parents=True)
            (target / 'SKILL.md').write_text(name)
        self.args = Namespace(repo=str(self.repo), skill_root=[str(self.skills)], goal='test',
                              leader=None, dependencies_checked=True, root=str(self.root / 'pipeline'),
                              project_name=None, project_file=None)
        with patch.object(Path, 'home', return_value=self.root), contextlib.redirect_stdout(io.StringIO()):
            p.initialize(self.args)
        self.run = next((self.root / 'pipeline/logs').iterdir())
        self.state = p.read(self.run / 'state.json')
        self.report = Path(self.state['reports'])

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.PIPE)

    def prepare(self, task_id='task-a', role='worker', **kwargs):
        unit = kwargs.pop('unit', 'module-a' if role == 'builder' else None)
        receipt = p.prepare(self.run, task_id, role, 'Implement the supplied contract', unit=unit, **kwargs)
        attempt = Path(receipt['attempt'])
        p.bind(self.run, attempt, f'agent-{task_id}-{attempt.name}')
        return attempt

    def artifact(self, attempt, name='evidence.md', text='verified behavior'):
        path = attempt / 'artifacts' / name
        path.write_text(text)
        return path

    def handoff(self, attempt, requests=(), references=()):
        handoff = attempt / 'handoff.md'
        handoff.write_text('Goal: preserve behavior. Decision: use the existing owner.\n'
                           'Rejected: duplicate state. Evidence: tracked baseline.\n'
                           'Completed: investigation. Pending: collect workers. Next: integrate evidence.\n')
        p.checkpoint(self.run, attempt, 'Contract identified', 'Integrate returned results', [],
                     handoff=handoff, requests=requests, references=references)
        return handoff

    def deliver(self, attempt, status='completed', artifacts=None, **extra):
        record = p.read(attempt / 'execution.json')
        if record['role'] in p.LEAD_ROLES and not (attempt / 'checkpoint.json').exists():
            self.handoff(attempt)
        p.write(attempt / 'result.json', {'task_id': record['task_id'], 'status': status,
                'summary': 'PRIVATE ANALYSIS ' * 1000,
                'artifacts': [str(path) for path in (artifacts if artifacts is not None else [self.artifact(attempt)])],
                **extra})
        return p.collect(self.run, attempt)

    def request(self, owner, task_id='challenge-a', role='challenger'):
        prompt = self.artifact(owner, task_id + '.md', 'Challenge the necessity, assumptions and smaller implementation.')
        manifest = owner / 'artifacts' / 'dispatch.json'
        p.write(manifest, {'tasks': [{'task_id': task_id, 'role': role, 'prompt_path': str(prompt), 'after': []}]})
        self.handoff(owner, requests=[manifest], references=[self.repo / 'tracked'])
        return manifest, prompt

    def test_project_metadata_branch_and_all_output_paths(self):
        self.assertEqual(self.state['project'], '@scope/project')
        self.assertEqual(self.state['branch'], 'feature/a')
        self.assertEqual(self.report.parent.name, 'feature%2Fa')
        self.assertEqual(self.report.parent.parent.name, '%40scope%2Fproject')
        self.assertEqual(self.run.parent.name, 'logs')
        self.assertTrue(Path(self.state['helper']).is_file())
        self.assertNotIn('Desktop', json.dumps(self.state))
        self.assertNotIn('directory-is-not', str(self.report))
        self.assertEqual(len(list(self.repo.iterdir())), 3)

    def test_project_names_from_other_manifests_and_explicit_subproject(self):
        (self.repo / 'package.json').unlink()
        for file, text, name in [
            ('pyproject.toml', '[project]\nname = "python-name"\n', 'python-name'),
            ('pyproject.toml', '[tool.poetry]\nname = "poetry-name"\n', 'poetry-name'),
            ('Cargo.toml', '[package]\nname = "rust-name"\n', 'rust-name'),
            ('go.mod', 'module example.com/project\n\ngo 1.25\n', 'example.com/project'),
        ]:
            with self.subTest(file=file, text=text):
                path = self.repo / file
                path.write_text(text)
                self.assertEqual(p.project_identity(self.repo)[0], name)
                path.unlink()
        sub = self.repo / 'packages/app/package.json'
        sub.parent.mkdir(parents=True)
        p.write(sub, {'name': 'sub-app'})
        self.assertEqual(p.project_identity(self.repo, project_file=sub)[0], 'sub-app')

    def test_missing_ambiguous_or_invalid_project_names_never_use_directory(self):
        p.write(self.repo / 'package.json', {})
        with self.assertRaisesRegex(ValueError, 'project-name'):
            p.project_identity(self.repo)
        self.assertEqual(p.project_identity(self.repo, 'explicit')[0], 'explicit')
        p.write(self.repo / 'package.json', {'name': 'one'})
        (self.repo / 'Cargo.toml').write_text('[package]\nname = "two"\n')
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            p.project_identity(self.repo)
        for bad in ['', '.', '..', '   ']:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                p.path_segment(bad)
        self.assertNotEqual(p.path_segment('a/b'), p.path_segment('a-b'))

    def test_detached_head_and_multiple_runs_keep_stable_paths(self):
        self.git('checkout', '--detach', '-q')
        with contextlib.redirect_stdout(io.StringIO()):
            p.initialize(self.args)
        runs = list(self.run.parent.iterdir())
        self.assertEqual(len(runs), 2)
        other = next(run for run in runs if run != self.run)
        self.assertTrue(p.read(other / 'state.json')['branch'].startswith('detached-'))
        self.assertEqual(p.read(self.run / 'state.json')['branch'], 'feature/a')

    def test_default_root_and_repository_root_override(self):
        self.args.root = None
        with patch.object(Path, 'home', return_value=self.root), contextlib.redirect_stdout(io.StringIO()):
            p.initialize(self.args)
        default = self.root / '.ya-skills/ultra-produce'
        self.assertEqual(len(list((default / 'logs').iterdir())), 1)
        self.assertTrue((default / 'reports/%40scope%2Fproject/feature%2Fa').is_dir())
        self.args.root = str(self.repo / 'internal-logs')
        with self.assertRaisesRegex(ValueError, 'outside'):
            p.initialize(self.args)
        self.assertFalse(Path(self.args.root).exists())

    def test_preflight_checks_skills_without_coding_agent_clis(self):
        with patch.object(Path, 'home', return_value=self.root), patch.object(p.shutil, 'which', side_effect=lambda n: '/tool/' + n if n in ('git', 'python3') else None):
            result = p.preflight(self.repo, [self.skills])
        self.assertTrue(result['ok'])
        self.assertNotIn('coldx', result['tools'])
        p.write(self.skills / 'grill-with-docs/skill.json', {'dependsOn': ['grilling']})
        (self.skills / 'ultra-cr/SKILL.md').unlink()
        with patch.object(Path, 'home', return_value=self.root):
            result = p.preflight(self.repo, [self.skills])
        self.assertEqual(set(result['missing_skills']), {'grilling', 'ultra-cr'})

    def test_init_checks_before_creating_any_output_and_preserves_baseline(self):
        before = set(self.run.parent.iterdir())
        self.args.dependencies_checked = False
        with self.assertRaises(ValueError):
            p.initialize(self.args)
        self.assertEqual(set(self.run.parent.iterdir()), before)
        (self.repo / 'tracked').write_text('user hunk')
        (self.repo / 'untracked').write_text('user file')
        self.args.dependencies_checked = True
        with contextlib.redirect_stdout(io.StringIO()):
            p.initialize(self.args)
        new = next(path for path in self.run.parent.iterdir() if path not in before)
        self.assertIn('user hunk', (new / 'baseline/worktree.patch').read_text())
        files = p.read(new / 'baseline/untracked.json')
        self.assertEqual((new / 'baseline' / files['untracked']['copy']).read_text(), 'user file')

    def test_prepare_bind_collect_accept_are_native_and_compact(self):
        before = p.snapshot(self.repo)
        attempt = self.prepare()
        real_popen = subprocess.Popen
        def git_only(argv, *args, **kwargs):
            self.assertEqual(argv[0], 'git')
            return real_popen(argv, *args, **kwargs)
        with patch.object(p.subprocess, 'Popen', side_effect=git_only):
            notification = self.deliver(attempt)
        self.assertEqual(notification['status'], 'completed')
        self.assertNotIn('PRIVATE ANALYSIS', json.dumps(notification))
        self.assertLess(len(json.dumps(notification)), 1800)
        self.assertNotIn('accepted_at', p.read(attempt / 'execution.json'))
        p.accept(self.run, 'task-a')
        self.assertIn('accepted_at', p.read(attempt / 'execution.json'))
        self.assertEqual(p.snapshot(self.repo), before)

    def test_phase_brief_and_question_routing_are_bounded_and_explicit(self):
        attempt = self.prepare(role='planner')
        questions = [{'id': f'question-{index}', 'audience': 'user', 'question': 'USER QUESTION ' * 1000}
                     for index in range(12)]
        self.deliver(attempt, 'needs_decision', questions=questions)
        value = p.brief(self.run, attempt)
        self.assertEqual(len(value['summary']), 600)
        self.assertTrue(value['summary_truncated'])
        self.assertNotIn('USER QUESTION', json.dumps(value))
        self.assertEqual(len(value['questions']), 10)
        self.assertEqual(len(p.brief(self.run, attempt, offset=10)['questions']), 2)
        detail = p.brief(self.run, attempt, question_id='question-11')['question']
        self.assertEqual(len(detail['question']), 600)
        self.assertTrue(detail['truncated'])

    def test_top_level_receipt_evidence_cannot_escape_the_run(self):
        attempt = self.prepare()
        outside = self.root / 'not-a-run-artifact'
        outside.write_text('outside')
        self.assertEqual(self.deliver(attempt, evidence=[str(outside)])['status'], 'blocked')

    def test_duplicate_attempt_binding_and_same_unit_builder_are_rejected(self):
        attempt = self.prepare(role='builder')
        with self.assertRaises(ValueError):
            self.prepare()
        with self.assertRaises(ValueError):
            p.bind(self.run, attempt, 'different-agent')
        with self.assertRaises(ValueError):
            self.prepare('other', 'builder')
        p.bind(self.run, attempt, p.read(attempt / 'execution.json')['agent_id'])
        p.reconcile(self.run, 'task-a', 'Host confirms cancelled; inspected side effects', True)
        self.prepare(role='builder', retry=True)

    def test_empty_or_wrong_owner_receipts_block_without_printing_payload(self):
        for index, payload in enumerate([None, [], {'task_id': 'wrong'}, {'task_id': 'x', 'status': 'completed', 'summary': '', 'artifacts': 'bad'}]):
            attempt = self.prepare(f'task-{index}')
            if payload is not None:
                p.write(attempt / 'result.json', payload)
            result = p.collect(self.run, attempt)
            self.assertEqual(result['status'], 'blocked')
            self.assertNotIn('error', result)
            with self.assertRaises(ValueError):
                p.accept(self.run, f'task-{index}')

    def test_outputs_must_be_in_this_runs_logs_or_reports(self):
        attempt = self.prepare()
        outside = self.root / 'outside.md'
        outside.write_text('outside')
        self.assertEqual(self.deliver(attempt, artifacts=[outside])['status'], 'blocked')
        attempt = self.prepare('symlink')
        link = attempt / 'artifacts/link.md'
        link.symlink_to(outside)
        self.assertEqual(self.deliver(attempt, artifacts=[link])['status'], 'blocked')

    def test_task_and_evidence_mutation_prevents_acceptance(self):
        attempt = self.prepare()
        self.deliver(attempt)
        (attempt / 'artifacts/evidence.md').write_text('changed evidence')
        with self.assertRaisesRegex(ValueError, 'evidence'):
            p.accept(self.run, 'task-a')
        attempt = self.prepare('mutated')
        (attempt / 'task.md').write_text('changed task')
        self.assertEqual(self.deliver(attempt)['status'], 'needs_changes')

    def test_parallel_changes_require_stage_owner_recheck_at_current_fingerprint(self):
        first = self.prepare('first')
        (self.repo / 'tracked').write_text('first worker implementation')
        self.deliver(first)
        second = self.prepare('second')
        (self.repo / 'second').write_text('second worker implementation')
        self.deliver(second)
        with self.assertRaises(ValueError):
            p.accept(self.run, 'first')
        review = self.artifact(second, 'recheck.json')
        evidence = self.artifact(second, 'integration.md', 'Both independent changes satisfy their original contracts.')
        p.write(review, {'attempt': str(first), 'fingerprint': 'stale', 'evidence': [str(evidence)]})
        with self.assertRaises(ValueError):
            p.accept(self.run, 'first', review)
        p.write(review, {'attempt': str(first), 'fingerprint': p.run_status(self.run)['fingerprint'],
                         'evidence': [str(evidence)]})
        p.accept(self.run, 'first', review)
        p.accept(self.run, 'second')
        self.prepare('integrate', after=['first', 'second'])

    def test_dependency_requires_actual_acceptance_and_remains_bound(self):
        owner = self.prepare('upstream')
        self.deliver(owner)
        with self.assertRaises(ValueError):
            self.prepare('downstream', after=['upstream'])
        p.accept(self.run, 'upstream')
        child = self.prepare('downstream', after=['upstream'])
        retry = self.prepare('upstream', retry=True)
        self.deliver(retry)
        p.accept(self.run, 'upstream')
        self.assertEqual(self.deliver(child)['status'], 'needs_changes')

    def test_corrections_require_latest_ack_and_resolution_and_keep_scopes(self):
        attempt = self.prepare(role='builder')
        p.correct(self.run, 'module-a', 'issue-a', 'Keep the behavior')
        p.acknowledge(self.run, attempt, 'issue-a', 1)
        p.correct(self.run, 'module-a', 'issue-a', 'Keep empty inputs too')
        evidence = self.artifact(attempt)
        self.handoff(attempt)
        p.write(attempt / 'result.json', {'task_id': 'task-a', 'status': 'completed', 'summary': 'done',
            'artifacts': [str(evidence)], 'corrections': {'issue-a': {'revision': 1, 'evidence': [str(evidence)]}}})
        with self.assertRaises(ValueError):
            p.gate(self.run, attempt)
        p.acknowledge(self.run, attempt, 'issue-a', 2)
        output = p.read(attempt / 'result.json')
        output['corrections']['issue-a']['revision'] = 2
        p.write(attempt / 'result.json', output)
        p.gate(self.run, attempt)
        self.assertEqual(p.collect(self.run, attempt)['status'], 'completed')
        p.accept(self.run, 'task-a')
        self.assertTrue(p.corrections(self.run, 'module-a')['issue-a']['accepted_at'])
        p.correct(self.run, 'module-a', 'downstream-only', 'New scoped correction', 'later')
        self.prepare('dependent', after=['task-a'])
        p.retract(self.run, 'module-a', 'downstream-only', 1, 'Mistaken target')
        p.correct(self.run, 'module-a', 'downstream-only', 'Corrected request', 'later')
        self.assertEqual(p.corrections(self.run, 'module-a')['downstream-only']['revision'], 2)

    def test_leader_must_publish_handoff_before_releasing_turn(self):
        attempt = self.prepare(role='planner')
        p.write(attempt / 'result.json', {'task_id': 'task-a', 'status': 'needs_decision',
                'summary': 'dispatch requested', 'artifacts': []})
        self.assertEqual(p.collect(self.run, attempt)['status'], 'blocked')
        self.assertIn('handoff', p.read(attempt / 'execution.json')['error'])

    def test_fresh_planner_recovers_from_files_and_reads_children_without_main_payload(self):
        owner = self.prepare('plan', 'planner')
        manifest, prompt = self.request(owner)
        (self.repo / 'tracked').write_text('changed by an authorized worker')
        self.deliver(owner, 'needs_decision', artifacts=[manifest, prompt])
        requests = p.dispatch_requests(self.run, owner)
        self.assertNotIn('Challenge the necessity', json.dumps(requests))
        child = Path(p.prepare(self.run, 'challenge-a', 'challenger', prompt.read_text(),
                             parent_attempt=owner, prompt_path=prompt)['attempt'])
        p.bind(self.run, child, 'native-challenger')
        with self.assertRaisesRegex(ValueError, 'pending'):
            p.prepare(self.run, 'plan', 'planner', 'Continue', continue_from=owner)
        self.deliver(child)
        # No resume support: a new instance only receives these file paths.
        fresh = Path(p.prepare(self.run, 'plan', 'planner', 'Continue from files', continue_from=owner)['attempt'])
        p.bind(self.run, fresh, 'entirely-new-planner')
        recovery = p.read(fresh / 'recovery.json')
        self.assertIn('Rejected: duplicate state', Path(recovery['handoff']).read_text())
        self.assertEqual(recovery['children'][0]['result'], str(child / 'result.json'))
        self.assertIn('PRIVATE ANALYSIS', p.read(recovery['children'][0]['result'])['summary'])
        self.assertNotIn('PRIVATE ANALYSIS', json.dumps(p.run_status(self.run)))
        self.assertEqual(p.read(child / 'execution.json')['parent_task_id'], 'plan')
        self.assertTrue(manifest.is_file())

    def test_unpublished_or_tampered_dispatch_cannot_start_child(self):
        owner = self.prepare('plan', 'planner')
        manifest, prompt = self.request(owner)
        with self.assertRaises(ValueError):
            p.prepare(self.run, 'challenge-a', 'challenger', prompt.read_text(), parent_attempt=owner, prompt_path=prompt)
        self.deliver(owner, 'needs_decision', artifacts=[manifest, prompt])
        prompt.write_text('mutated request')
        with self.assertRaises(ValueError):
            p.dispatch_requests(self.run, owner)

    def test_changed_recovery_sources_are_identified_not_silently_reused(self):
        owner = self.prepare('plan', 'planner')
        self.handoff(owner, references=[self.repo / 'tracked'])
        self.deliver(owner, 'needs_decision')
        (self.repo / 'tracked').write_text('changed after checkpoint')
        fresh = Path(p.prepare(self.run, 'plan', 'planner', 'Continue', continue_from=owner)['attempt'])
        self.assertIn(str(self.repo / 'tracked'), p.read(fresh / 'recovery.json')['changed_references'])

    def test_handoff_and_dispatch_are_frozen_after_publication(self):
        owner = self.prepare('plan', 'planner')
        self.handoff(owner)
        self.deliver(owner, 'needs_decision')
        (owner / 'handoff.md').write_text('overwritten')
        with self.assertRaises(ValueError):
            p.prepare(self.run, 'plan', 'planner', 'Continue', continue_from=owner)

    def test_child_evidence_is_checked_again_before_fresh_owner_recovery(self):
        owner = self.prepare('plan', 'planner')
        manifest, prompt = self.request(owner)
        self.deliver(owner, 'needs_decision', artifacts=[manifest, prompt])
        child = Path(p.prepare(self.run, 'challenge-a', 'challenger', prompt.read_text(),
                             parent_attempt=owner, prompt_path=prompt)['attempt'])
        p.bind(self.run, child, 'native-child')
        self.deliver(child)
        (child / 'artifacts/evidence.md').write_text('changed after collection')
        with self.assertRaisesRegex(ValueError, 'Child receipt'):
            p.prepare(self.run, 'plan', 'planner', 'Continue', continue_from=owner)

    def test_checkpoint_repetition_does_not_invent_progress(self):
        attempt = self.prepare()
        evidence = self.artifact(attempt)
        p.checkpoint(self.run, attempt, 'found a fact', 'implement', [str(evidence)])
        first = p.read(attempt / 'checkpoint.json')['last_progress_at']
        p.checkpoint(self.run, attempt, 'repeated observation', 'implement', [str(evidence)])
        self.assertEqual(p.read(attempt / 'checkpoint.json')['last_progress_at'], first)

    def test_redelivery_preserves_prior_receipt_and_rejects_workspace_changes(self):
        first = self.prepare(role='builder')
        self.deliver(first)
        original = (first / 'result.json').read_bytes()
        second = self.prepare(role='builder', redeliver=True)
        self.assertEqual(self.deliver(second)['status'], 'completed')
        self.assertEqual((first / 'result.json').read_bytes(), original)
        third = self.prepare(role='builder', redeliver=True)
        (self.repo / 'tracked').write_text('illegal receipt-only edit')
        self.assertEqual(self.deliver(third)['status'], 'needs_changes')
        with self.assertRaises(ValueError):
            self.prepare(role='builder', redeliver=True)

    def test_reconcile_needs_host_confirmation_and_retains_side_effects(self):
        attempt = self.prepare()
        (self.repo / 'tracked').write_text('partial implementation')
        with self.assertRaises(ValueError):
            p.reconcile(self.run, 'task-a', 'unknown status', False)
        p.reconcile(self.run, 'task-a', 'Host confirmed cancellation; checked Git', True)
        self.assertEqual(p.read(attempt / 'execution.json')['status'], 'blocked')
        self.assertEqual((self.repo / 'tracked').read_text(), 'partial implementation')

    def test_hook_paths_noop_context_and_destination_rules(self):
        context = {'stage': 'verify', 'attempt': 1, 'plan_version': 1,
                   'git_range': 'HEAD~1..HEAD', 'outcome': 'failed', 'evidence': []}
        p.write(self.root / 'AGENTS.md', {})
        rules = self.report.parent / 'AGENTS.md'
        rules.write_text('Write reports in Chinese.')
        for name in ('after-plan', 'after-verify', 'before-finish'):
            args = Namespace(run=str(self.run), context=str(self.run / 'context.json'), name=name,
                             key='r1', prompt=None, retry=False)
            p.write(Path(args.context), context)
            result = p.hook(args)
            task = Path(result['task']).read_text()
            self.assertIn(str(self.report), task)
            self.assertIn('Write reports in Chinese.', task)
            self.assertNotIn('Desktop', task)
        args.name = 'before-impl'
        self.assertEqual(p.hook(args)['status'], 'noop')
        context['output_dir'] = str(self.root / 'escape')
        p.write(Path(args.context), context)
        args.name = 'after-plan'
        with self.assertRaises(ValueError):
            p.hook(args)

    def test_hook_completed_receipt_requires_actual_deliverable(self):
        context = {'stage': 'plan', 'attempt': 1, 'plan_version': 1,
                   'git_range': 'HEAD..HEAD', 'outcome': 'passed', 'evidence': []}
        p.write(self.run / 'context.json', context)
        args = Namespace(run=str(self.run), context=str(self.run / 'context.json'), name='after-plan',
                         key='v1', prompt=None, retry=False)
        first = Path(p.hook(args)['attempt'])
        p.bind(self.run, first, 'hook-first')
        self.assertEqual(self.deliver(first)['status'], 'needs_changes')
        args.retry = True
        second = Path(p.hook(args)['attempt'])
        p.bind(self.run, second, 'hook-second')
        plan = self.report / 'plan.md'
        plan.write_text('Complete plan')
        (self.report / 'plan-v1.md').write_text('Complete plan')
        self.assertEqual(self.deliver(second, artifacts=[plan], instruction_paths=[], output_dir=str(self.report))['status'], 'completed')
        # The versioned Plan is part of delivery evidence even if only plan.md was listed.
        (self.report / 'plan-v1.md').write_text('changed version')
        with self.assertRaises(ValueError):
            p.accept(self.run, 'hook-after-plan-v1')

    def test_hook_same_version_cannot_silently_overwrite_existing_plan(self):
        context = {'stage': 'plan', 'attempt': 1, 'plan_version': 1,
                   'git_range': 'HEAD..HEAD', 'outcome': 'passed', 'evidence': []}
        p.write(self.run / 'context.json', context)
        versioned = self.report / 'plan-v1.md'
        versioned.write_text('original plan')
        args = Namespace(run=str(self.run), context=str(self.run / 'context.json'), name='after-plan',
                         key='v1', prompt=None, retry=False)
        attempt = Path(p.hook(args)['attempt'])
        p.bind(self.run, attempt, 'hook')
        versioned.write_text('different plan under the same version')
        latest = self.report / 'plan.md'
        latest.write_bytes(versioned.read_bytes())
        result = self.deliver(attempt, artifacts=[latest], instruction_paths=[], output_dir=str(self.report))
        self.assertEqual(result['status'], 'needs_changes')
        self.assertIn('immutable', p.read(attempt / 'execution.json')['error'])

    def test_invalid_hook_evidence_is_rejected_before_task_creation(self):
        context = {'stage': 'verify', 'attempt': 1, 'plan_version': 1,
                   'git_range': 'HEAD..HEAD', 'outcome': 'failed', 'evidence': 'not an array'}
        p.write(self.run / 'bad-context.json', context)
        args = Namespace(run=str(self.run), context=str(self.run / 'bad-context.json'), name='after-verify',
                         key='invalid', prompt=None, retry=False)
        with self.assertRaisesRegex(ValueError, 'array'):
            p.hook(args)
        self.assertFalse((self.run / 'tasks/hook-after-verify-invalid').exists())

    def test_cli_uses_pinned_snapshot_and_default_status_does_not_expose_reports(self):
        attempt = self.prepare()
        self.deliver(attempt)
        helper = self.state['helper']
        result = subprocess.run([sys.executable, helper, 'status', '--run', str(self.run)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('PRIVATE ANALYSIS', result.stdout)
        refused = subprocess.run([sys.executable, str(SCRIPT), 'accept', '--run', str(self.run), '--task-id', 'task-a'], capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('pinned', refused.stderr)
        accepted = subprocess.run([sys.executable, helper, 'accept', '--run', str(self.run), '--task-id', 'task-a'], capture_output=True, text=True)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)


if __name__ == '__main__':
    unittest.main()
