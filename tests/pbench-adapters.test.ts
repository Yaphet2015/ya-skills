import { expect, test } from "bun:test";
import { createCodexSessionSource } from "../packages/functions-pbench/src/adapters/codex.js";
import { createClaudeSessionSource } from "../packages/functions-pbench/src/adapters/claude.js";

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
