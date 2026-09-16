import json, subprocess, time
from pathlib import Path
root=Path('/tmp/ya-native-unlocked-cancel')
cli='/Users/phaethon/workspace/personal/ya-skills/dist/release/ya-skills/yk'
session='c3d28a8b-6822-4ed3-a82b-0c7e8955c717'
def run(*args):
 p=subprocess.run([cli,'computer-use',*args],capture_output=True,text=True,timeout=20)
 raw=p.stdout or p.stderr
 
 try: response=json.loads(raw)
 except ValueError: response=raw
 return {'exitCode':p.returncode,'response':response}
before=json.loads((root/'state.json').read_text())
status=run('session','status','--session',session)
assert status['response']['session']['state']=='unusable',status
lease=Path.home()/'Library/Caches/ya-skills/computer-use/sessions/leases/app-53163.lease'
assert lease.exists(),'unknown must retain lease'
replay=run('batch','--session',session,'--file',str(root/'batch.json'),'--request-id','native-cancel-ax-1','--timeout-ms','30000')
new=run('batch','--session',session,'--file',str(root/'batch.json'),'--request-id','after-native-unknown','--timeout-ms','30000')
time.sleep(.1)
after=json.loads((root/'state.json').read_text())
assert before['clicks']==after['clicks']==1,(before,after)
assert replay['exitCode']!=0,replay
assert new['exitCode']!=0,new
record={'status':status,'leaseRetained':True,'sameRequest':replay,'newRequest':new,'before':before,'after':after}
(root/'terminal-checks.json').write_text(json.dumps(record,indent=2))
print(json.dumps({'state':'unusable','leaseRetained':True,'replay':replay['response'],'newRequest':new['response'],'clicks':after['clicks']}))
