import subprocess, hashlib, json, tarfile
from pathlib import Path
run=Path(__file__).parent
archive=Path('ya-skills-v1.1.2-macos-arm64.tar.gz').resolve()
root=run/'extract'
root.mkdir()
subprocess.run(['tar','-xzf',str(archive),'-C',str(root)],check=True)
for path in ['yk','skills','runtime','skills/repro/SKILL.md','skills/repro/scripts/repro-scan.mjs']:
 assert (root/path).exists(),path
subprocess.run(['codesign','--verify','--strict',str(root/'yk')],check=True)
help=subprocess.run([str(root/'yk'),'-h'],capture_output=True,text=True,check=True)
assert help.stdout.strip() and 'Usage' in help.stdout
version=subprocess.run([str(root/'yk'),'--version'],capture_output=True,text=True,check=True)
assert version.stdout.strip()=='1.1.2',version.stdout
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
assert sha==Path(str(archive)+'.sha256').read_text().split()[0]
result={'archive':str(archive),'extraction':str(root),'sha256':sha,'size':archive.stat().st_size,'version':version.stdout.strip(),'signature':'pass','help':'pass','layout':'pass'}
(run/'archive.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
