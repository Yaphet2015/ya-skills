// One-shot compiled-execution probe (agentic desktop plan Task A1, exec
// prerequisites). NOT product code.
//
// Proves, with NO desktop access, that a compiled Bun executable can:
//   1. execute a captured JavaScript string via the AsyncFunction
//      constructor with await and shared state,
//   2. round-trip JSON over a private same-user Unix socket with a subprocess
//      spawned from the SAME executable (the future script-worker IPC shape),
//   3. reclaim an infinite-loop subprocess with SIGTERM, and a
//      SIGTERM-ignoring subprocess with the SIGKILL fallback — process group
//      reaped, no orphans.
//
// All subprocesses run with cwd inside a private 0700 temp directory, never
// the source checkout, so no source-cwd bunfig preload can run in them.
//
// Modes:
//   computer-exec-compiled                  parent flow (this is the probe)
//   computer-exec-compiled worker <socket>  IPC worker child
//   computer-exec-compiled spin             infinite loop (TERM target)
//   computer-exec-compiled spin-ignore-term infinite loop, SIGTERM ignored
//                                            (KILL target)
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2];

if (mode === "spin") {
  for (;;) {}
} else if (mode === "spin-ignore-term") {
  process.on("SIGTERM", () => {
    /* deliberately swallowed to prove the SIGKILL fallback */
  });
  for (;;) {}
} else if (mode === "worker") {
  await worker(process.argv[3]!);
} else if (mode === undefined) {
  await parent();
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

// ---- worker: connect, ping with this process's pid, verify the echo -------

async function worker(socketPath: string): Promise<void> {
  const nonce = process.pid;
  const socket = connect(socketPath);
  let buffer = "";
  socket.on("connect", () => {
    socket.write(JSON.stringify({ type: "ping", nonce }) + "\n");
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n")[0]!;
      if (!line.endsWith("}")) return; // wait for the full line
      const message = JSON.parse(line) as { type?: string; nonce?: number };
      if (message.type === "pong" && message.nonce === nonce) {
        console.log(`WORKER_OK nonce=${message.nonce}`);
        socket.end();
        resolve();
      } else {
        reject(new Error(`worker got unexpected message: ${line}`));
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("worker socket timeout")), 10_000).unref();
  });
  process.exit(0);
}

// ---- parent --------------------------------------------------------------

interface SelfSpawn {
  exec: string;
  args: (extra: string[]) => string[];
  compiled: boolean;
}

function resolveSelf(): SelfSpawn {
  const exec = realpathSync(process.execPath);
  let compiled = false;
  try {
    compiled = realpathSync(Bun.main) === exec;
  } catch {
    compiled = true; // no script entrypoint resolvable: we are the compiled binary
  }
  // Compiled: the executable IS the entrypoint. Dev: entrypoint is a script
  // argument to the bun binary.
  return { exec, compiled, args: (extra) => (compiled ? extra : [Bun.main, ...extra]) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForExit(child: { on: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void }, timeoutMs: number): Promise<ExitInfo | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function killLoopChild(
  self: SelfSpawn,
  dir: string,
  spinArgs: string[],
  label: string
): Promise<ExitInfo & { groupReaped: boolean; neededKill: boolean }> {
  const child = spawn(self.exec, self.args(spinArgs), {
    detached: true, // own process group, like the future script worker
    stdio: "ignore",
    cwd: dir
  });
  const pid = child.pid!;
  await sleep(250); // let the spin loop start
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signalGroup("SIGTERM");
  let exit = await waitForExit(child, 2_000);
  let neededKill = false;
  if (exit === null) {
    neededKill = true;
    signalGroup("SIGKILL");
    exit = await waitForExit(child, 2_000);
  }
  if (exit === null) throw new Error(`${label}: child pid ${pid} survived SIGTERM and SIGKILL`);
  let groupReaped = false;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    groupReaped = (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  return { ...exit, groupReaped, neededKill };
}

async function parent(): Promise<void> {
  const self = resolveSelf();
  console.log(
    `probe bun ${Bun.version} exec ${self.exec} main ${Bun.main} compiled=${self.compiled}`
  );
  let failures = 0;
  const check = (ok: boolean, line: string) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
    if (!ok) failures++;
  };

  // 1. captured-JS execution with await and shared state --------------------
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const state = { count: 1 };
  await new AsyncFunction("state", "state.count += await Promise.resolve(2)")(state);
  check(state.count === 3, `compiled-js-execution state.count=${state.count}`);

  // private temp workspace; children never see the source checkout as cwd --
  const dir = mkdtempSync(join(tmpdir(), "yk-exec-probe-"));
  const dirMode = statSync(dir).mode & 0o777;
  const socketPath = join(dir, "ipc.sock");
  if (socketPath.length >= 100) {
    throw new Error(`socket path too long for a Unix socket: ${socketPath}`);
  }
  console.log(`probe private dir ${dir} mode=0o${dirMode.toString(8)} socketLen=${socketPath.length}`);

  try {
    // 2. same-executable socket IPC roundtrip -------------------------------
    const server = createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const line = buffer.split("\n")[0]!;
        if (!line.endsWith("}")) return;
        const message = JSON.parse(line) as { type?: string; nonce?: number };
        if (message.type === "ping" && typeof message.nonce === "number") {
          conn.write(JSON.stringify({ type: "pong", nonce: message.nonce }) + "\n");
          conn.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const workerChild = spawn(self.exec, self.args(["worker", socketPath]), {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
      cwd: dir
    });
    let workerStdout = "";
    workerChild.stdout!.on("data", (chunk: Buffer) => (workerStdout += chunk.toString("utf8")));
    const workerExit = await waitForExit(workerChild, 15_000);
    server.close();
    check(
      workerExit?.code === 0 && /WORKER_OK nonce=\d+/.test(workerStdout),
      `ipc-socket-roundtrip exec=${self.exec} workerExit=${workerExit?.code} out="${workerStdout.trim()}"`
    );

    // 3. infinite-loop reclamation: SIGTERM ---------------------------------
    const term = await killLoopChild(self, dir, ["spin"], "infinite-loop-term");
    check(
      term.signal === "SIGTERM" && term.groupReaped,
      `infinite-loop-term signal=${term.signal} groupReaped=${term.groupReaped}`
    );

    // 4. SIGTERM-ignoring loop: SIGKILL fallback ----------------------------
    const kill = await killLoopChild(self, dir, ["spin-ignore-term"], "infinite-loop-sigkill-fallback");
    check(
      kill.neededKill && kill.signal === "SIGKILL" && kill.groupReaped,
      `infinite-loop-sigkill-fallback termIgnoredSurvived=${kill.neededKill} signal=${kill.signal} groupReaped=${kill.groupReaped}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    console.log(`probe cleanup dirRemoved=${!existsSync(dir)}`);
  }

  process.exitCode = failures === 0 ? 0 : 1;
}
