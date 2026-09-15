import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseRequest } from "../packages/functions-computer-use/src/args.js";
import { execCommand } from "../packages/functions-computer-use/src/exec-command.js";

describe("parseRequest exec (C4)", () => {
  test("the plan's reference failures", () => {
    expect(() => parseRequest("exec", ["--file", "flow.js", "--request-id", "r"])).toThrow(/session/);
    expect(() =>
      parseRequest("exec", ["--session", "s", "--file", "flow.js", "--request-id", "r", "--timeout-ms", "Infinity"])
    ).toThrow(/finite|timeout/);
  });

  test("exec requires session + file + request-id together", () => {
    expect(() => parseRequest("exec", ["--session", "s", "--request-id", "r"])).toThrow(/--file/);
    expect(() => parseRequest("exec", ["--session", "s", "--file", "f.js"])).toThrow(/request-id/);
    expect(
      parseRequest("exec", ["--session", "s", "--file", "f.js", "--request-id", "r", "--timeout-ms", "90000", "--max-actions", "200"])
    ).toMatchObject({ kind: "exec", sessionId: "s", file: "f.js", requestId: "r", timeoutMs: 90_000, maxActions: 200 });
    expect(() => parseRequest("exec", ["--session", "s", "--file", "f.js", "--request-id", "r", "--max-actions", "900"])).toThrow(
      /max-actions/
    );
  });

  test("exec never takes --pid (sessions own the target)", () => {
    expect(() => parseRequest("exec", ["--pid", "1", "--file", "f.js", "--request-id", "r"])).toThrow(
      /not valid for this action|unknown flag/
    );
  });
});

describe("execCommand (C4)", () => {
  test("a missing script file fails before any session work", async () => {
    const run = execCommand();
    const error = await run({ sessionId: randomUUID(), file: "/definitely/not/here.js", requestId: "r" }).then(
      () => null,
      (e: unknown) => e
    );
    expect((error as Error).message).toMatch(/script_unreadable/);
  });

  test("an unknown session fails with unknown_session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-exec-cli-"));
    const file = join(dir, "flow.js");
    await writeFile(file, "return 1;");
    try {
      const run = execCommand();
      // Point the session root at an empty dir: findSession finds nothing.
      const error = await run({ sessionId: randomUUID(), file, requestId: "r" }).then(() => null, (e: unknown) => e);
      expect((error as Error).message).toMatch(/unknown_session/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
