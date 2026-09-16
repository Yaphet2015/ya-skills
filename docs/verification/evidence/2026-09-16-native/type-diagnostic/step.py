import json, subprocess, sys, time
from pathlib import Path
root = Path('/tmp/ya-native-type-diagnostic')
name, *args = sys.argv[1:]
before = json.loads((root/'state.json').read_text())
assert before['isKeyWindow'] is False and before['isMainWindow'] is False
assert before['frontmostPid'] != before['pid']
cli = '/Users/phaethon/workspace/personal/ya-skills/dist/release/ya-skills/yk'
started = time.time()
p = subprocess.run([cli, 'computer-use', *args], capture_output=True, text=True, timeout=45)
time.sleep(.12)
after = json.loads((root/'state.json').read_text())
try: result = json.loads(p.stdout)
except: result = p.stdout
record = dict(command=args, started=started, ended=time.time(), exitCode=p.returncode, result=result, stderr=p.stderr, before=before, after=after)
(root/(name+'.json')).write_text(json.dumps(record, indent=2))
print(json.dumps({"name":name, "exitCode":p.returncode, "result": result if not isinstance(result, dict) or "observations" not in result.get("result", {}) else {"status": result["result"].get("status"), "actions":result["result"].get("actions"), "value":result["result"].get("value")}, "stderr":p.stderr, "before":{k:before[k] for k in ["clicks","canvasClicks","value","frontmostPid","isKeyWindow","keyEvents"]}, "after":{k:after[k] for k in ["clicks","canvasClicks","value","frontmostPid","isKeyWindow","keyEvents"]}}))
assert after['isKeyWindow'] is False and after['isMainWindow'] is False
assert after['keyEvents'] == before['keyEvents']
assert after['frontmostPid'] == before['frontmostPid'], 'frontmost changed during step'
