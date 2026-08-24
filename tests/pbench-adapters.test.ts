import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexAgentRunner, createCodexSessionSource } from "../packages/functions-pbench/src/adapters/codex.js";
import { createClaudeAgentRunner, createClaudeSessionSource } from "../packages/functions-pbench/src/adapters/claude.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `pbench-adapter-${prefix}-`));
  cleanup.push(path);
  return path;
}

test("Codex and Claude sources normalize agent-specific transcripts", () => {
  const codex = createCodexSessionSource().extract(
    [
      JSON.stringify({ type: "session_meta", cwd: "/repo", id: "codex-1", model: "gpt-test" }),
      JSON.stringify({ type: "message", role: "user", content: "Fix the task" }),
      JSON.stringify({
        type: "exec_command",
        arguments: { cmd: "bun test", workdir: "/repo" },
        exit_code: 1,
        stderr: "failed"
      })
    ].join("\n") + "\n"
  );
  expect(codex.meta).toMatchObject({ cwd: "/repo", id: "codex-1", model: "gpt-test" });
  expect(codex.userMessages).toEqual(["Fix the task"]);
  expect(codex.toolCalls[0]).toMatchObject({ exit_code: 1, stderr: "failed" });
  expect(codex.errorRecords).toHaveLength(1);

  const claude = createClaudeSessionSource().extract(
    [
      JSON.stringify({ type: "user", cwd: "/repo", sessionId: "claude-1", message: { content: "Fix login" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-test",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "bun test" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "exit code 1: failed" }] }
      })
    ].join("\n") + "\n"
  );
  expect(claude.meta).toMatchObject({ cwd: "/repo", id: "claude-1", model: "claude-test" });
  expect(claude.userMessages).toEqual(["Fix login"]);
  expect(claude.toolCalls[0]).toMatchObject({ command: "bun test", exit_code: 1 });
  expect(claude.errorRecords).toHaveLength(1);
});

test("Codex and Claude runners honor launch inputs and normalize summaries", async () => {
  const binDir = await temp("bin");
  const worktree = await temp("worktree");
  const executable = [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "import { basename, join } from 'node:path';",
    "const name = basename(process.argv[1]);",
    "if (process.argv.includes('--version')) { console.log(name + '-test 1.0.0'); process.exit(0); }",
    "let stdin = ''; process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { stdin += chunk; });",
    "process.stdin.on('end', () => {",
    "  writeFileSync(join(process.cwd(), name + '-probe.json'), JSON.stringify({ args: process.argv.slice(2), marker: process.env.ADAPTER_MARKER, stdin }));",
    "  if (name === 'codex') console.log(JSON.stringify({ content: 'codex done', usage: { input_tokens: 2, output_tokens: 1 } }));",
    "  else console.log(JSON.stringify({ type: 'result', result: 'claude done', usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0.01 }));",
    "});"
  ].join("\n") + "\n";
  for (const name of ["codex", "claude"]) {
    const path = join(binDir, name);
    await writeFile(path, executable);
    await chmod(path, 0o755);
  }
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, ADAPTER_MARKER: "present" };

  for (const runner of [createCodexAgentRunner(), createClaudeAgentRunner()]) {
    const result = runner.launch({ worktree, prompt: "solve now", env, timeoutMs: 5_000 });
    const probe = JSON.parse(await readFile(join(worktree, `${runner.id}-probe.json`), "utf8"));
    const summary = runner.parseSummary(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(probe.marker).toBe("present");
    expect(probe.stdin).toBe("solve now");
    expect(summary.lastMessage).toContain("done");
    expect(summary.tokenUsage).toBeTruthy();
    expect(runner.versionProbe(env)).toContain("test 1.0.0");
  }

  const codexProbe = JSON.parse(await readFile(join(worktree, "codex-probe.json"), "utf8"));
  expect(codexProbe.args).toContain("workspace-write");
  expect(createClaudeAgentRunner().parseSummary('{"type":"result","result":"ok","total_cost_usd":0.25}\n').cost).toBe(0.25);
});
