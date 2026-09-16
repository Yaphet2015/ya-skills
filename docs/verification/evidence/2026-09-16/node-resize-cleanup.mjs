import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const originalSpawn = cp.spawn;
let child;
let closed = false;
let childClosed;
cp.spawn = (command, args, options) => {
  if (command !== '/usr/bin/sips') return originalSpawn(command, args, options);
  child = originalSpawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);"], options);
  childClosed = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  return child;
};
try {
  const { resizeScreenshot } = await import(pathToFileURL(process.argv[2]).href);
  const result = await resizeScreenshot('/tmp/no-image.png', 64, undefined, undefined, Date.now() + 250).then(() => 'success', e => e.message);
  let alive = false;
  if (child) { try { process.kill(child.pid, 0); alive = true; } catch {} }
  console.log(JSON.stringify({ result, spawned: !!child, closedBeforeReturn: closed, childAliveAfterResult: alive }));
  assert.ok(child, 'the production Node runner must spawn a child');
  assert.equal(closed, true, 'resize must wait for the child close event');
  assert.equal(alive, false, 'child must be gone when resize returns');
} finally {
  cp.spawn = originalSpawn;
  if (child && !closed) { child.kill('SIGKILL'); await childClosed; }
}
