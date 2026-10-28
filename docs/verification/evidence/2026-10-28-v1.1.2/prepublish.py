import subprocess, json
from pathlib import Path
run=Path(__file__).parent
expected='d1c3c0bcc0977d58807349cc96446410147930ed'
def call(*args):
 p=subprocess.run(args,capture_output=True,text=True,check=True)
 return p.stdout.strip()
call('git','fetch','origin','main')
assert call('git','branch','--show-current')=='main'
assert call('git','rev-parse','HEAD')==expected
assert call('git','rev-parse','origin/main')==expected
assert call('git','status','--porcelain=v1')==''
assert call('git','ls-remote','--tags','origin','refs/tags/v1.1.2')==''
release=subprocess.run(['gh','release','view','v1.1.2','--json','tagName,assets'],capture_output=True,text=True)
assert release.returncode!=0 and 'release not found' in release.stderr,release.stdout+release.stderr
print('main clean; HEAD == origin/main == '+expected+'; tag and release absent')
