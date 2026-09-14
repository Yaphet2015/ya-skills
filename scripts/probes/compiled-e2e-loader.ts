// One-shot compiled-loader probe (foundation plan Task A1). NOT product code.
//
// Modes:
//   compiled-e2e-loader parent <external-file> [killAfterMs]
//   compiled-e2e-loader worker <external-file>
//
// parent: spawns ITSELF (realpath'd executable, detached, own process group)
// as worker to import an external .ts/.mjs file with NO node_modules and a
// restricted PATH; relays worker stdout/stderr; optional killAfterMs proves
// hard interruption of a hung worker (SIGTERM then SIGKILL on the group).
// worker: dynamic-imports the external file, awaits default(), and writes one
// NDJSON control event on fd3 (the channel the real e2e worker will use).
import { spawn } from 'node:child_process';
import { realpathSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [mode, file] = process.argv.slice(2);

if (mode === 'worker') {
  const module = (await import(pathToFileURL(file!).href)) as { default: () => Promise<void> | void };
  await module.default();
  writeSync(3, JSON.stringify({ type: 'finished' }) + '\n');
} else if (mode === 'parent') {
  console.log(`probe bun ${Bun.version} exec ${realpathSync(process.execPath)}`);
  const killAfterMs = process.argv[4] ? Number(process.argv[4]) : undefined;
  const child = spawn(realpathSync(process.execPath), ['worker', file!], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let hardKilled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killGroup = (sig: 'SIGTERM' | 'SIGKILL') => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  if (killAfterMs !== undefined && Number.isFinite(killAfterMs)) {
    timer = setTimeout(() => {
      hardKilled = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 50);
    }, killAfterMs);
  }
  child.stdout!.pipe(process.stdout);
  child.stderr!.pipe(process.stderr);
  child.stdio[3]!.on('data', (chunk: Buffer) => process.stdout.write(`fd3: ${chunk}`));
  child.on('exit', (code, signal) => {
    if (timer) clearTimeout(timer);
    console.log(`worker exit code=${code} signal=${signal} hardKilled=${hardKilled}`);
    process.exitCode = hardKilled ? 137 : (code ?? 1);
  });
} else {
  throw new Error('expected parent|worker and external file');
}
