import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid


START = '<!-- bankai-workflow:start -->'
END = '<!-- bankai-workflow:end -->'
EXCLUDE_START = '# bankai-local-skills:start'
EXCLUDE_END = '# bankai-local-skills:end'
EXCLUDES = '\n'.join((EXCLUDE_START, '/.agents/skills/bankai', '/.agents/skills/stage',
                      '/.logoscode/skills/bankai', '/.logoscode/skills/stage', EXCLUDE_END))
ENTRY = f'''{START}
## Cowork workflow skills

When `../.fleet/workspaces.json` explicitly registers this canonical repository root, the installed `bankai` and `stage` skills apply. Only an explicit `/bankai` invocation starts or resumes its workflow. `/stage current` queries this clone; `/stage all` and `/stage` query all registered clones. Stage is read-only. Project entry enables discovery and registration checks only; ordinary requests and new sessions must never initialize, take over, or resume Bankai. Follow the installed skills for the execution and recovery contracts.
{END}'''


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=True, indent=2) + '\n')
    temporary.replace(path)


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE).decode().strip()


def exclude_path(repo):
    path = Path(git(repo, 'rev-parse', '--git-path', 'info/exclude'))
    return path if path.is_absolute() else repo / path


def remove_legacy_entry(rules):
    text = rules.read_text() if rules.is_file() else ''
    if (START in text or END in text) and ENTRY not in text:
        raise ValueError(f'Managed legacy entry changed; preserve and reconcile it: {rules}')
    return text.replace('\n\n' + ENTRY + '\n', '\n').replace(ENTRY, '')


def install(bundle, skills, root, repos, apply=False):
    if not skills.is_relative_to(root) or skills == root:
        raise ValueError('Skill packages must stay in the private centralized root, outside user-level discovery')
    packages = ['bankai'] + (['stage'] if (bundle / 'stage/SKILL.md').is_file() else [])
    previous = read(root / 'workspaces.json') if (root / 'workspaces.json').is_file() else {'version': 1, 'workspaces': []}
    by_path = {x['path']: x for x in previous['workspaces']}
    identities = []
    for raw in repos:
        repo = Path(raw).resolve()
        if Path(git(repo, 'rev-parse', '--show-toplevel')).resolve() != repo:
            raise ValueError('Only canonical Git roots may be registered')
        project = read(repo / 'package.json')['name']
        current = {'path': str(repo), 'project': project,
                   'origin': git(repo, 'remote', 'get-url', 'origin').removesuffix('.git').rstrip('/')}
        old = by_path.get(str(repo))
        if old and any(old[k] != current[k] for k in current):
            raise ValueError('Existing registered identity differs; reconcile before installation')
        current = {**(old or {}), **current}
        current['id'] = old['id'] if old else uuid.uuid4().hex
        identities.append(current)
        if root.is_relative_to(repo):
            raise ValueError('Keep private workflow packages and state outside tracked repositories')
        remove_legacy_entry(repo / 'AGENTS.md')
        old_installation = read(root / 'installation.json') if (root / 'installation.json').is_file() else {}
        previous_skills = Path(old_installation.get('skills', str(skills)))
        for folder in ('.agents/skills', '.logoscode/skills'):
            for name in packages:
                target = repo / folder / name
                allowed = {(skills / name).resolve(), (previous_skills / name).resolve()}
                if target.exists() or target.is_symlink():
                    if not target.is_symlink() or target.resolve() not in allowed:
                        raise ValueError(f'Discovery path belongs to another installation: {target}')
    if len({x['origin'] for x in identities}) != 1 or len({x['project'] for x in identities}) != 1:
        raise ValueError('Registration requires clones of the same project and origin')
    if any(path not in {x['path'] for x in identities} for path in by_path):
        raise ValueError('Manifest contains additional workspaces; preserve it and reconcile explicitly')
    changes = []
    for name in packages:
        for path in (bundle / name).rglob('*'):
            if not path.is_file() or '__pycache__' in path.parts:
                continue
            target = skills / name / path.relative_to(bundle / name)
            if not target.is_file() or path.read_bytes() != target.read_bytes():
                changes.append((path, target))
    summary = {'workspaces': identities, 'files': [str(t) for _, t in changes],
               'entry_files': [], 'local_exclude_files': [str(exclude_path(Path(x['path']))) for x in identities],
               'skills': str(skills), 'root': str(root), 'applied': apply}
    if not apply:
        return summary
    installation = root / 'installation.json'
    old_installation = read(installation) if installation.is_file() else {}
    backup = root / 'install-backups' / str(time.time_ns())
    audit = {'files': [], 'entries': [], 'links': [], 'time': time.time()}
    for source, target in changes:
        if target.is_file():
            saved = backup / target.relative_to(skills)
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
            audit['files'].append({'target': str(target), 'backup': str(saved)})
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.bankai.tmp')
        shutil.copy2(source, temporary)
        temporary.replace(target)
    for item in identities:
        repo = Path(item['path'])
        rules = repo / 'AGENTS.md'
        text = rules.read_text() if rules.is_file() else ''
        cleaned = remove_legacy_entry(rules)
        if cleaned != text:
            audit['entries'].append({'path': str(rules), 'action': 'removed-legacy-entry'})
            rules.write_text(cleaned)
        local_exclude = exclude_path(repo)
        exclusions = local_exclude.read_text() if local_exclude.is_file() else ''
        if EXCLUDES not in exclusions:
            local_exclude.parent.mkdir(parents=True, exist_ok=True)
            local_exclude.write_text(exclusions + ('\n' if exclusions and not exclusions.endswith('\n') else '') + EXCLUDES + '\n')
        for folder in ('.agents/skills', '.logoscode/skills'):
            for name in packages:
                target = repo / folder / name
                if target.is_symlink() and target.resolve() == (skills / name).resolve():
                    continue
                if target.is_symlink():
                    target.unlink()
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(skills / name, target_is_directory=True)
                audit['links'].append(str(target))
    write(root / 'workspaces.json', {'version': 1, 'workspaces': identities})
    if changes or audit['entries'] or audit['links'] or not old_installation:
        history = old_installation.get('history', []) + [audit]
        write(installation, {'scope': 'registered-clones-only', 'skills': str(skills), 'history': history})
    return summary


def uninstall(root):
    manifest = read(root / 'workspaces.json')
    installation = read(root / 'installation.json')
    for item in manifest['workspaces']:
        remove_legacy_entry(Path(item['path']) / 'AGENTS.md')
    for item in manifest['workspaces']:
        repo = Path(item['path'])
        rules = repo / 'AGENTS.md'
        text = rules.read_text() if rules.is_file() else ''
        cleaned = remove_legacy_entry(rules)
        if cleaned != text:
            rules.write_text(cleaned)
        for folder in ('.agents/skills', '.logoscode/skills'):
            for name in ('bankai', 'stage'):
                link = repo / folder / name
                if link.is_symlink() and link.resolve() == (Path(installation['skills']) / name).resolve():
                    link.unlink()
        local_exclude = exclude_path(repo)
        if local_exclude.is_file():
            text = local_exclude.read_text()
            local_exclude.write_text(text.replace(EXCLUDES + '\n', ''))
    return {'removed': 'local discovery links and owned local excludes', 'history_preserved': str(root)}


def main():
    parser = argparse.ArgumentParser(description='Install the verified Cowork workflow without launching tasks')
    parser.add_argument('--skills', type=Path)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--repo', type=Path, action='append', default=[])
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    try:
        if not args.repo and not args.uninstall:
            raise ValueError('Explicit repository roots are required')
        bundle = Path(__file__).resolve().parents[2]
        skills = args.skills.resolve() if args.skills else args.root.resolve() / 'skills'
        result = uninstall(args.root.resolve()) if args.uninstall else install(bundle, skills, args.root.resolve(), args.repo, args.apply)
        print(json.dumps(result, indent=2))
        return 0
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
