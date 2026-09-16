import json, subprocess, time, sys
from pathlib import Path
root=Path('/tmp/ya-native-unlocked-cancel')
cli='/Users/phaethon/workspace/personal/ya-skills/dist/release/ya-skills/yk'
session=sys.argv[1]
request='native-cancel-ax-1'
args=['batch','--session',session,'--file',str(root/'batch.json'),'--request-id',request,'--timeout-ms','30000']
(root/'batch.json').write_text(json.dumps({'actions':[{'kind':'click','selector':{'text':'Block Increment','match':'exact','role':'AXButton'}},{'kind':'click','selector':{'text':'Block Increment','match':'exact','role':'AXButton'}}]}))
before=json.loads((root/'state.json').read_text())
started=time.time()
p=subprocess.Popen([cli,'computer-use',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
record={'command':args,'before':before,'started':started}
try:
 deadline=time.monotonic()+8
 while time.monotonic()<deadline and not (root/'entered.json').exists() and p.poll() is None: time.sleep(.01)
 if not (root/'entered.json').exists():
  raise RuntimeError('native AXPress handshake was not reached')
 record['entered']=json.loads((root/'entered.json').read_text())
 cstart=time.time()
 c=subprocess.run([cli,'computer-use','session','cancel','--session',session,'--request-id',request],capture_output=True,text=True,timeout=10)
 record['cancel']={'started':cstart,'ended':time.time(),'exitCode':c.returncode,'stdout':c.stdout,'stderr':c.stderr}
 out,err=p.communicate(timeout=20)
 record['terminal']={'ended':time.time(),'exitCode':p.returncode,'stdout':out,'stderr':err}
finally:
 (root/'release').write_text('release')
 if p.poll() is None:
  try: out,err=p.communicate(timeout=20); record['terminal']={'exitCode':p.returncode,'stdout':out,'stderr':err}
  except subprocess.TimeoutExpired: p.kill(); p.wait()
 time.sleep(.3)
 record['after']=json.loads((root/'state.json').read_text())
 (root/'cancel-run.json').write_text(json.dumps(record,indent=2))
 print(json.dumps(record))
