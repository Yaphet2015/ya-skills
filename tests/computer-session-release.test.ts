import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopProcessGroup } from "../packages/computer-session/src/process.js";
import {
  isRunnableProcess,
  parseExecBodyReadyFrame,
  readProcessGroupId
} from "./helpers/integration-release-process.js";

// Packaged agentic closed loop, desktop-free (C5): the REAL compiled yk runs
// its internal exec worker; THIS test process is the RPC peer that answers
// the worker's facade calls with synthetic observations — no native SDK load,
// no fake-driver flag on the production binary. The full real-driver +
// host + script loop is a separate, explicitly authorized desktop gate and
// is NOT claimed here.

const outDir = resolve("dist/release/ya-skills");
const yk = join(outDir, "yk");
// Release tests are never an implicit artifact probe. The release workflow
// opts in explicitly after package:release; when enabled, missing artifacts
// fail loudly instead of becoming a false pass.
const required = process.env.YK_RELEASE_TESTS === "1";
const maybe = required ? test : test.skip;

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

  maybe("the compiled exec loop proves body readiness before TERM/KILL cleanup", async () => {
    const dir = consumerDir("exec-loop");
    const configPath = join(dir, "exec.json");
    const readyPath = join(dir, "descendant.ready");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "01234567-89ab-cdef-0123-456789abcdef",
        requestId: "rel-2",
        generation: "g",
        target: { pid: 4242, windowId: "12345" },
        // The body installs its own TERM handler, starts an owned child whose
        // shell installs `trap '' TERM`, waits for that child to report
        // readiness, and only then emits the body-level fd3 acknowledgement.
        // This is deliberately an exact child of the compiled worker, not a
        // process found by a global-name sweep.
        code: `
          process.on("SIGTERM", () => {});
          const { readFileSync, writeSync } = await import("node:fs");
          const child = Bun.spawn(["/bin/sh", "-c", ${JSON.stringify(`trap '' TERM; printf '%s\\n' "$$" > ${JSON.stringify(readyPath)}; while :; do sleep 1; done`)}], {
            stdin: "ignore", stdout: "ignore", stderr: "ignore"
          });
          let reportedPid = "";
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              reportedPid = readFileSync(${JSON.stringify(readyPath)}, "utf8").trim();
            } catch {}
            if (reportedPid !== "") break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (reportedPid !== String(child.pid)) throw new Error("descendant did not report its own pid");
          writeSync(3, JSON.stringify({ type: "exec_body_ready", childPid: child.pid, reportedPid: Number(reportedPid), ready: true }) + "\\n");
          while (true) {}
        `,
        sourceName: "loop.js",
        timeoutMs: 30_000,
        maxActions: 5,
        state: {},
        cwd: dir
      })
    );
    const proc = spawn(yk, ["__computer-exec-worker", configPath], {
      cwd: dir,
      env: { ...process.env, PATH: "/usr/bin:/bin", NODE_PATH: "", BUN_OPTIONS: "", HOME: process.env.HOME ?? "/tmp" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"]
    });
    proc.stdout?.resume();
    proc.stderr?.resume();
    const workerPid = proc.pid;
    if (workerPid === undefined) {
      proc.kill();
      throw new Error("compiled loop worker did not expose a pid");
    }
    const control = proc.stdio[3];
    if (control === null) throw new Error("compiled loop worker did not allocate fd3");
    const lines: string[] = [];
    const reader = createInterface({ input: control as import("node:stream").Readable });
    let sawStarted = false;
    let bodyReadyResolve!: (frame: NonNullable<ReturnType<typeof parseExecBodyReadyFrame>>) => void;
    let bodyReadyReject!: (error: Error) => void;
    const bodyReady = new Promise<NonNullable<ReturnType<typeof parseExecBodyReadyFrame>>>((resolveReady, rejectReady) => {
      bodyReadyResolve = resolveReady;
      bodyReadyReject = rejectReady;
    });
    reader.on("line", (line) => {
      lines.push(line);
      if (line.includes('"type":"exec_started"')) sawStarted = true;
      const frame = parseExecBodyReadyFrame(line);
      if (frame !== null) bodyReadyResolve(frame);
    });
    proc.once("exit", (code, signal) => {
      if (!sawStarted) bodyReadyReject(new Error(`compiled loop exited before exec_started (code=${code}, signal=${signal})`));
      else bodyReadyReject(new Error(`compiled loop exited before body readiness (code=${code}, signal=${signal})`));
    });
    const bootTimer = setTimeout(() => bodyReadyReject(new Error("compiled loop did not acknowledge body readiness on fd3")), 10_000);
    let stop: Awaited<ReturnType<typeof stopProcessGroup>> | null = null;
    try {
      // `exec_started` is emitted before the body and is not sufficient. The
      // proof waits for the body to report the descendant PID after readiness.
      const ready = await bodyReady;
      expect(sawStarted).toBe(true);
      expect(ready.childPid).toBe(ready.reportedPid);
      expect(readProcessGroupId(workerPid)).toBe(workerPid);
      expect(readProcessGroupId(ready.childPid)).toBe(workerPid);
      expect(isRunnableProcess(ready.childPid)).toBe(true);

      // Signal only this owned worker group. Both the worker body and its
      // descendant ignore TERM, so survival here proves KILL escalation is
      // required rather than accepting leader exit as complete cleanup.
      process.kill(-workerPid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(isRunnableProcess(ready.childPid)).toBe(true);

      stop = await stopProcessGroup(proc, 2_000);
    } finally {
      clearTimeout(bootTimer);
      // Startup failures must not strand a detached worker or its descendants.
      if (stop === null) stop = await stopProcessGroup(proc, 2_000).catch(() => null);
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
    if (stop === null) throw new Error("compiled loop cleanup did not produce a stop result");
    expect(stop.exited).toBe(true);
    expect(stop.signal).toBe("SIGKILL");
    expect(stop.groupSurvivors).toBeNull();
    // The exact reported descendant is gone after production TERM→KILL group
    // cleanup; no terminal success frame can escape the reclaimed worker.
    const bodyFrame = lines.map(parseExecBodyReadyFrame).find((frame) => frame !== null);
    if (bodyFrame === undefined) throw new Error("body readiness frame was lost from the control stream");
    expect(isRunnableProcess(bodyFrame.childPid)).toBe(false);
    expect(lines.some((line) => {
      try {
        return (JSON.parse(line) as { type?: string }).type === "exec_done";
      } catch {
        return false;
      }
    })).toBe(false);
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

