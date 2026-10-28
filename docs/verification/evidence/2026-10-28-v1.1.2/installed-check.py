import subprocess,json,re
from pathlib import Path
run=Path(__file__).parent
prefix=Path(subprocess.check_output(['brew','--prefix','ya-skills'],text=True).strip())
subprocess.run(['codesign','--verify','--strict',str(prefix/'libexec/yk')],check=True)
help=subprocess.run([str(prefix/'bin/yk'),'-h'],capture_output=True,text=True,check=True)
assert help.stdout.strip() and 'Usage' in help.stdout
version=subprocess.check_output([str(prefix/'bin/yk'),'--version'],text=True).strip()
assert version=='1.1.2',version
catalog=subprocess.check_output([str(prefix/'bin/yk'),'list'],text=True)
assert re.search(r'^repro\s',catalog,re.M)
formula=Path('/opt/homebrew/Library/Taps/yaphet2015/homebrew-tap/Formula/ya-skills.rb').read_text()
assert not re.search(r'^\s*version\s',formula,re.M)
assert 'v1.1.2/ya-skills-v1.1.2-macos-arm64.tar.gz' in formula
assert json.loads((run/'archive.json').read_text())['sha256'] in formula
assert 'assert_match "1.1.2"' in formula
result={'prefix':str(prefix),'signature':'pass','help':'pass','version':version,'reproInCatalog':True,'formula':'pass'}
(run/'installed.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
