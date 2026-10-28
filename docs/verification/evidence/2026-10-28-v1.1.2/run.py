import sys, subprocess, json, datetime
from pathlib import Path
root=Path(__file__).parent
name=sys.argv[1]
cmd=sys.argv[2:]
log=root/(name+'.log')
with log.open('w') as out:
 p=subprocess.run(cmd, stdout=out, stderr=subprocess.STDOUT, text=True)
with (root/'commands.jsonl').open('a') as f:
 f.write(json.dumps({'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'name':name,'cmd':cmd,'exit':p.returncode})+'\n')
print(log.read_text()[-7000:])
print('LOG:',log,'EXIT:',p.returncode)
sys.exit(p.returncode)
