from pathlib import Path
import hashlib,json
run=Path(__file__).parent
local=json.loads((run/'archive.json').read_text())
release=json.loads((run/'release-metadata.log').read_text())
archive=run/'download'/'ya-skills-v1.1.2-macos-arm64.tar.gz'
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
asset=next(a for a in release['assets'] if a['name']==archive.name)
assert asset['state']=='uploaded'
assert 'sha256:'+sha==asset['digest']
assert local['sha256']==sha
assert sha==Path(str(archive)+'.sha256').read_text().split()[0]
result={'localSha256':local['sha256'],'uploadedSha256':asset['digest'],'downloadedSha256':sha,'match':True}
(run/'download-check.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
