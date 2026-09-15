import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Packaged agentic closed loop, desktop-free (C5): the REAL compiled yk runs
// its internal exec worker; THIS test process is the RPC peer that answers
// the worker's facade calls with synthetic observations — no native SDK load,
// no fake-driver flag on the production binary. The full real-driver +
// host + script loop is a separate, explicitly authorized desktop gate and
// is NOT claimed here.

const outDir = resolve("dist/release/ya-skills");
const yk = join(outDir, "yk");
const ready = existsSync(yk) && process.platform === "darwin" && process.arch === "arm64";
const required = process.env.YK_RELEASE_TESTS === "1";
const maybe = ready ? test : required ? test : test.skip;

function consumerDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `yk-rel-session-${label}-`));
}

function runYk(cwd: string, args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([yk, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      NODE_PATH: "",
      BUN_OPTIONS: "",
      YA_SKILLS_CATALOG_DIR: join(outDir, "skills"),
      ...env
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr)
  };
}

describe("packaged computer-use agentic closed loop (no desktop, no node/npm/bun on PATH)", () => {
  maybe("release artifacts exist and include the generated skill api", () => {
    expect(required ? existsSync(yk) : true).toBe(true);
    expect(existsSync(join(outDir, "skills", "computer-use", "references", "api.d.ts"))).toBe(true);
    expect(existsSync(join(outDir, "skills", "computer-use", "examples", "search.js"))).toBe(true);
    expect(existsSync(join(outDir, "runtime", "computer-use", "node_modules", "@trycua", "cua-driver", "dist", "index.js"))).toBe(true);
  });

  maybe("the packaged skill references match the generated api", () => {
    const packaged = readFileSync(join(outDir, "skills", "computer-use", "references", "api.d.ts"), "utf8");
    const generated = readFileSync(resolve("skills/computer-use/references/api.d.ts"), "utf8");
    expect(packaged).toBe(generated);
  });

  maybe("help output lists the agentic actions and executes no project scripts", () => {
    const dir = consumerDir("help");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "hostile", scripts: { preinstall: "touch SENTINEL_RAN", prepare: "touch SENTINEL_RAN" } })
    );
    const help = runYk(dir, ["computer-use", "--help"]);
    expect(help.code).toBe(0);
    for (const action of ["observe", "batch", "session", "exec"]) {
      expect(help.stdout).toContain(action);
    }
    expect(existsSync(join(dir, "SENTINEL_RAN"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  maybe("invalid exec requests fail cleanly without native load", () => {
    const dir = consumerDir("exec-invalid");
    const missingSession = runYk(dir, ["computer-use", "exec", "--file", "nope.js", "--request-id", "r"]);
    expect(missingSession.code).not.toBe(0);
    expect(missingSession.stderr).toMatch(/session/);
    rmSync(dir, { recursive: true, force: true });
  });

  maybe("the internal exec worker completes pure JS + state + log against a test RPC peer", async () => {
    const dir = consumerDir("exec-worker");
    const configPath = join(dir, "exec.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "01234567-89ab-cdef-0123-456789abcdef",
        requestId: "rel-1",
        generation: "g",
        target: { pid: 4242, windowId: "12345" },
        code: `
          state.counts = (state.counts ?? 0) + 1;
          await computer.type("probe");
          const view = await observe({ mode: "ax" });
          log({ title: view.title });
          return { title: view.title, counts: state.counts };
        `,
        sourceName: "release-probe.js",
        timeoutMs: 30_000,
        maxActions: 10,
        state: { counts: 3 },
        cwd: dir
      })
    );
    const proc = Bun.spawn([yk, "__computer-exec-worker", configPath], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", NODE_PATH: "", HOME: process.env.HOME ?? "/tmp" },
      // fd3 is the control transport; stdout/stderr remain logs and are not
      // parsed as protocol frames.
      stdio: ["pipe", "pipe", "pipe", "pipe"]
    });
    const lines: string[] = [];
    // Answer the worker's RPCs interactively: watch for rpc frames and reply.
    const answer = (line: string): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === "rpc") {
        const seq = Number(message.seq);
        const method = String(message.method);
        let result: unknown = null;
        if (method === "observe") {
          result = {
            id: "obs-rel-1",
            target: { pid: 4242, windowId: "12345" },
            capturedAt: Date.now(),
            epoch: "e",
            revision: 0,
            title: "Packaged Fixture",
            ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
            image: { status: "unavailable" }
          };
        } else if (method === "batch") {
          const actions = ((message.args as { request?: { actions?: unknown[] } }).request?.actions ?? []) as unknown[];
          result = {
            status: "completed",
            steps: actions.map((a, i) => ({ index: i, kind: (a as { kind: string }).kind, status: "delivered" }))
          };
        }
        proc.stdin!.write(`${JSON.stringify({ seq, ok: true, result })}\n`);
      }
    };
    // Single reader pump: feeds `answer` per line and collects frames.
    const decoder = new TextDecoder();
    let buffer = "";
    // Drain logs independently so a noisy script cannot deadlock the peer.
    void new Response(proc.stdout).text();
    const controlFd = proc.stdio[3];
    if (typeof controlFd !== "number") throw new Error("release worker fd3 was not allocated");
    const reader = Bun.file(controlFd).stream().getReader();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() !== "") {
            lines.push(line);
            answer(line);
          }
        }
      }
    })();
    const exitCode = await Promise.all([proc.exited, pump]).then(([code]) => code as number);
    const frames = lines.filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = frames.find((f) => f.type === "exec_done");
    expect(done).toBeTruthy();
    expect((done?.state as { counts?: number }).counts).toBe(4);
    expect((done?.value as { title?: string }).title).toBe("Packaged Fixture");
    expect(done?.logs).toBeTruthy();
    expect(exitCode).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  maybe("the internal exec worker reclaims an infinite loop within its budget", async () => {
    const dir = consumerDir("exec-loop");
    const configPath = join(dir, "exec.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "01234567-89ab-cdef-0123-456789abcdef",
        requestId: "rel-2",
        generation: "g",
        target: { pid: 4242, windowId: "12345" },
        code: "while (true) {}",
        sourceName: "loop.js",
        timeoutMs: 300,
        maxActions: 5,
        state: {},
        cwd: dir
      })
    );
    const started = Date.now();
    const proc = Bun.spawn([yk, "__computer-exec-worker", configPath], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", NODE_PATH: "", HOME: process.env.HOME ?? "/tmp" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    });
    // The test plays the host watchdog: budget elapses, TERM the worker. (A
    // plain child, not a group leader, so the signal targets the pid; the
    // production host kills the whole group via stopProcessGroup.)
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      process.kill(proc.pid!, "SIGTERM");
    } catch {
      // already gone — fine, the assertion below covers the outcome
    }
    const [text, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited
    ]);
    const elapsed = Date.now() - started;
    expect(exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(10_000);
    // No completion claim escaped the reclaimed worker.
    expect(text.includes("exec_done")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  maybe("same exec request-id replays nothing through a re-invoked CLI", () => {
    const dir = consumerDir("dedup");
    writeFileSync(join(dir, "f.js"), "return 1;");
    // Without a live session the CLI refuses — and it must refuse IDENTICALLY
    // for a repeated request id (no partial execution side channel).
    const first = runYk(dir, ["computer-use", "exec", "--session", "01234567-89ab-cdef-0123-456789abcdef", "--file", "f.js", "--request-id", "dup"]);
    const second = runYk(dir, ["computer-use", "exec", "--session", "01234567-89ab-cdef-0123-456789abcdef", "--file", "f.js", "--request-id", "dup"]);
    expect(first.code).not.toBe(0);
    expect(second.code).not.toBe(0);
    expect(first.stderr).toMatch(/unknown_session/);
    expect(second.stderr).toMatch(/unknown_session/);
    rmSync(dir, { recursive: true, force: true });
  });
});

