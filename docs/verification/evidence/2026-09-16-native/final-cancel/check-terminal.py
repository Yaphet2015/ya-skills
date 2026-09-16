import json, subprocess, time, sys
from pathlib import Path
root=Path('/tmp/ya-native-final-unlocked')
cli='/Users/phaethon/workspace/personal/ya-skills/dist/release/ya-skills/yk'
session=sys.argv[1]
def run(*args):
 p=subprocess.run([cli,'computer-use',*args],capture_output=True,text=True,timeout=20)
 raw=p.stdout or p.stderr
 try: response=json.loads(raw)
 except ValueError: response=raw
 return {'exitCode':p.returncode,'response':response}
before=json.loads((root/'state.json').read_text())
status=run('session','status','--session',session)
lease=Path.home()/f'Library/Caches/ya-skills/computer-use/sessions/leases/app-{before["pid"]}.lease'
replay=run('batch','--session',session,'--file',str(root/'batch.json'),'--request-id','native-cancel-ax-1','--timeout-ms','30000')
new=run('batch','--session',session,'--file',str(root/'batch.json'),'--request-id','after-native-unknown','--timeout-ms','30000')
time.sleep(.1)
after=json.loads((root/'state.json').read_text())
record={'status':status,'leaseRetained':lease.exists(),'sameRequest':replay,'newRequest':new,'before':before,'after':after}
(root/'terminal-checks.json').write_text(json.dumps(record,indent=2))
print(json.dumps(record))
assert status['response']['session']['state']=='unusable',status
assert lease.exists(),'unknown must retain lease'
assert replay['response']['error']['reply']['status']=='unknown',replay
assert new['response']['error']['code']=='session_closed',new
assert before['clicks']==after['clicks']==1,(before,after)
assert not after['isKeyWindow'] and not after['isMainWindow']
