import { describe, expect, test } from "bun:test";
import { createComputerUseCommands, parseRequest } from "@ya-skills/functions-computer-use";

describe("command registration", () => {
  test("registers exactly the nine desktop operations", () => {
    expect(createComputerUseCommands().map((command) => `${command.domain} ${command.action}`)).toEqual([
      "computer-use doctor",
      "computer-use apps",
      "computer-use windows",
      "computer-use perceive",
      "computer-use observe",
      "computer-use session",
      "computer-use exec",
      "computer-use batch",
      "computer-use act"
    ]);
  });

  test("descriptions are single-line for help tables", () => {
    for (const command of createComputerUseCommands()) {
      expect(command.description).not.toMatch(/\n/);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });
});

const usage = "usage: yk computer-use <doctor|apps|windows|perceive|act>";

describe("parseRequest rejects before any driver exists", () => {
  test("missing pid", () => {
    expect(() => parseRequest("perceive", [])).toThrow(/--pid/);
  });

  test("unknown flag", () => {
    expect(() => parseRequest("perceive", ["--pid", "1", "--nonsense"])).toThrow(/unknown flag/i);
  });

  test("non-numeric pid", () => {
    expect(() => parseRequest("perceive", ["--pid", "abc"])).toThrow(/--pid/);
  });

  test("non-integer pid", () => {
    expect(() => parseRequest("perceive", ["--pid", "1.5"])).toThrow(/--pid/);
  });

  test("zero pid", () => {
    expect(() => parseRequest("perceive", ["--pid", "0"])).toThrow(/--pid/);
  });

  test("negative pid", () => {
    expect(() => parseRequest("perceive", ["--pid", "-1"])).toThrow(/--pid/);
  });

  test("pid beyond safe integer range", () => {
    expect(() => parseRequest("perceive", ["--pid", "9007199254740992"])).toThrow(/--pid/);
  });

  test("window id beyond safe integer range still parses as bigint", () => {
    const req = parseRequest("perceive", ["--pid", "1", "--window", "9007199254740993"]);
    expect(req.kind).toBe("perceive");
    expect((req as { windowId?: bigint }).windowId).toBe(9007199254740993n);
  });

  test("window id must be digits only", () => {
    expect(() => parseRequest("perceive", ["--pid", "1", "--window", "12x4"])).toThrow(/--window/);
  });

  test("perceive needs no action", () => {
    expect(parseRequest("perceive", ["--pid", "1"]).kind).toBe("perceive");
  });

  test("act without an action is rejected", () => {
    expect(() => parseRequest("act", ["--pid", "1"])).toThrow(/action/i);
  });

  test("act with two actions is rejected", () => {
    expect(() =>
      parseRequest("act", ["--pid", "1", "--type", "hi", "--key", "Return"])
    ).toThrow(/exactly one/i);
  });

  test("unknown action flag is rejected", () => {
    expect(() =>
      parseRequest("act", ["--pid", "1", "--spin", "up"])
    ).toThrow(/unknown flag/i);
  });

  test("scroll requires a known direction", () => {
    expect(() =>
      parseRequest("act", ["--pid", "1", "--scroll", "diagonal"])
    ).toThrow(/--scroll/);
    expect(parseRequest("act", ["--pid", "1", "--scroll", "up"]).kind).toBe("act");
  });

  test("scroll amount must be a positive integer", () => {
    expect(() =>
      parseRequest("act", ["--pid", "1", "--scroll", "up", "--amount", "0"])
    ).toThrow(/--amount/);
    expect(() =>
      parseRequest("act", ["--pid", "1", "--scroll", "up", "--amount", "-3"])
    ).toThrow(/--amount/);
    expect(() =>
      parseRequest("act", ["--pid", "1", "--scroll", "up", "--amount", "1.5"])
    ).toThrow(/--amount/);
  });

  test("scroll coordinates are finite numbers, negatives allowed", () => {
    const req = parseRequest("act", ["--pid", "1", "--scroll", "up", "--x", "-12", "--y", "40"]);
    const scroll = (req as { scroll: { x: number; y: number } }).scroll;
    expect(scroll.x).toBe(-12);
    expect(scroll.y).toBe(40);
    expect(() =>
      parseRequest("act", ["--pid", "1", "--scroll", "up", "--x", "NaN"])
    ).toThrow(/--x/);
  });

  test("click-text and click-contains are distinct predicates", () => {
    const exact = parseRequest("act", ["--pid", "1", "--click-text", "发送"]);
    const substring = parseRequest("act", ["--pid", "1", "--click-contains", "发"]);
    expect((exact as { click: { kind: string; text: string } }).click).toEqual({
      kind: "text",
      text: "发送"
    });
    expect((substring as { click: { kind: string; text: string } }).click).toEqual({
      kind: "contains",
      text: "发"
    });
  });

  test("click-contains with click-role is allowed", () => {
    const req = parseRequest("act", [
      "--pid", "1", "--click-contains", "OK", "--click-role", "AXButton"
    ]);
    expect((req as { click: { role?: string } }).click.role).toBe("AXButton");
  });

  test("click-role without click-text/contains is rejected", () => {
    expect(() => parseRequest("act", ["--pid", "1", "--click-role", "AXButton"])).toThrow(/action/i);
  });

  test("type with empty text is rejected", () => {
    expect(() => parseRequest("act", ["--pid", "1", "--type", ""])).toThrow(/--type/);
  });

  test("type text keeps spaces and newlines", () => {
    const req = parseRequest("act", ["--pid", "1", "--type", "hello world\nsecond line"]);
    expect((req as { type: string }).type).toBe("hello world\nsecond line");
  });

  test("type value that looks like a flag must use equals form", () => {
    const req = parseRequest("act", ["--pid", "1", "--type=--help"]);
    expect((req as { type: string }).type).toBe("--help");
  });

  test("type value must not swallow a subsequent flag", () => {
    expect(() => parseRequest("act", ["--pid", "1", "--type", "hi", "--name", "x"])).toThrow(
      /not valid for this action/i
    );
  });

  test("set-value requires a token and preserves an empty value", () => {
    const req = parseRequest("act", ["--pid", "1", "--set-value", "", "--element-token", "field-token"]);
    expect(req).toMatchObject({
      kind: "act",
      action: "set_value",
      elementToken: "field-token",
      value: ""
    });
    expect(() => parseRequest("act", ["--pid", "1", "--set-value", "Ada"])).toThrow(/element-token/);
    expect(() => parseRequest("act", ["--pid", "1", "--element-token", "field-token"])).toThrow(/set-value/);
    expect(() => parseRequest("act", ["--pid", "1", "--set-value", "Ada", "--element-token", "  "])).toThrow(/element-token/);
  });

  test("set-value cannot be combined with activation", () => {
    expect(() => parseRequest("act", ["--pid", "1", "--activate", "--set-value", "Ada", "--element-token", "field-token"]))
      .toThrow(/cannot be used with --set-value/);
  });

  test("key with empty text is rejected", () => {
    expect(() => parseRequest("act", ["--pid", "1", "--key", ""])).toThrow(/--key/);
  });

  test("key modifiers use the installed SDK vocabulary and reach the parsed request", () => {
    const req = parseRequest("act", [
      "--pid", "1", "--key", "I", "--modifiers", "cmd, option,control,fn"
    ]);
    expect(req).toMatchObject({
      kind: "act",
      action: "key",
      key: "I",
      modifiers: ["cmd", "option", "ctrl", "fn"]
    });
  });

  test("compound key strings are rejected with the supported syntax", () => {
    expect(() => parseRequest("act", ["--pid", "1", "--key", "Cmd+Alt+I"])).toThrow(
      /--key I --modifiers cmd,option|--modifiers/
    );
    expect(() => parseRequest("act", ["--pid", "1", "--key", "I", "--modifiers", "cmd,wat"])).toThrow(
      /supported|modifier|cmd/
    );
    expect(() => parseRequest("act", ["--pid", "1", "--type", "x", "--modifiers", "cmd"])).toThrow(
      /requires --key/
    );
  });

  test("Backspace remains accepted as the driver's backward-delete key", () => {
    expect(parseRequest("act", ["--pid", "1", "--key", "Backspace"])).toMatchObject({ key: "delete" });
  });

  test("act format defaults to legacy and accepts the observation envelope", () => {
    expect(parseRequest("act", ["--pid", "1", "--key", "Return"])).toMatchObject({ format: "legacy" });
    expect(parseRequest("act", ["--pid", "1", "--key", "Return", "--format", "observation"])).toMatchObject({
      format: "observation"
    });
    expect(() => parseRequest("act", ["--pid", "1", "--key", "Return", "--format", "compact"])).toThrow(
      /--format/
    );
  });

  test("boolean flags: shot and activate", () => {
    const req = parseRequest("perceive", ["--pid", "1", "--shot"]);
    expect((req as { shot: boolean }).shot).toBe(true);
    expect((req as { activate: boolean }).activate).toBe(false);
    const act = parseRequest("perceive", ["--pid", "1", "--shot", "--activate"]);
    expect((act as { activate: boolean }).activate).toBe(true);
  });

  test("audit foreground is a one-shot-only boolean control", () => {
    expect(parseRequest("perceive", ["--pid", "1"])).toMatchObject({ auditForeground: false });
    expect(parseRequest("perceive", ["--pid", "1", "--audit-foreground"])).toMatchObject({ auditForeground: true });
    expect(() => parseRequest("act", ["--session", "s", "--key", "Return", "--audit-foreground"])).toThrow(
      /one-shot|session|audit-foreground/
    );
    expect(() => parseRequest("act", ["--session", "s", "--key", "Return", "--activate"])).toThrow(
      /one-shot|session|activate/
    );
  });

  test("apps accepts only --name filter", () => {
    const req = parseRequest("apps", ["--name", "Safari"]);
    expect((req as { name?: string }).name).toBe("Safari");
    expect(() => parseRequest("apps", ["--pid", "1"])).toThrow(/unknown flag|--pid/i);
  });

  test("apps --name must be a non-empty value", () => {
    expect(() => parseRequest("apps", ["--name", ""])).toThrow(/--name/);
  });

  test("doctor and apps take no positional args", () => {
    expect(() => parseRequest("doctor", ["extra"])).toThrow(/takes no positional/i);
    expect(() => parseRequest("apps", ["extra"])).toThrow(/takes no positional/i);
  });

  test("unknown top-level action is rejected", () => {
    expect(() => parseRequest("reboot", [])).toThrow(new RegExp(usage.split(" ")[2]));
  });

  test("out-dir accepts a directory path", () => {
    const req = parseRequest("perceive", ["--pid", "1", "--out-dir", "/tmp/cu"]);
    expect((req as { outDir?: string }).outDir).toBe("/tmp/cu");
  });

  test("out-dir rejects an empty value", () => {
    expect(() => parseRequest("perceive", ["--pid", "1", "--out-dir", ""])).toThrow(/--out-dir/);
  });

  test("perceive without --window is unambiguous request for auto-select", () => {
    const req = parseRequest("perceive", ["--pid", "1"]);
    expect((req as { windowId?: bigint }).windowId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// command orchestration through an injected session (no SDK anywhere near)

import { ComputerError, type Computer, type ComputerSession } from "@ya-skills/computer-runtime";

function makeFakeComputer(overrides: Partial<Computer> = {}): Computer {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected computer call");
  };
  return {
    apps: unexpected,
    windows: unexpected,
    snapshot: unexpected,
    observe: unexpected,
    clickPoint: unexpected,
    batch: unexpected,
    click: unexpected,
    setValue: unexpected,
    type: unexpected,
    key: unexpected,
    scroll: unexpected,
    waitFor: unexpected,
    ...overrides
  };
}

function makeSession(computer: Computer): ComputerSession {
  return {
    computer,
    metadata: async () => ({ driverVersion: "0.27.0", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    close: async () => {}
  };
}

describe("command orchestration via injected session", () => {
  test("act delivered but post-observe failure reports actionDelivered and never re-types", async () => {
    const calls: string[] = [];
    const computer = makeFakeComputer({
      windows: async () => [{ pid: 1, windowId: 2n, title: "Fixture" }],
      type: async () => {
        calls.push("type");
      },
      snapshot: async () => {
        throw new Error("observation unavailable");
      }
    });
    const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
    const action = commands.find((c) => c.action === "act")!;
    const error = await Promise.resolve(action.run(["--pid", "1", "--type", "hello"])).then(
      () => null,
      (e: Error) => e
    );
    expect(JSON.parse(error!.message).error.actionDelivered).toBe(true);
    expect(JSON.parse(error!.message).error.code).toBe("post_action_observe_failed");
    expect(calls).toEqual(["type"]);
  });

  test("refused actions surface action_refused without retry", async () => {
    for (const [flag, method] of [
      [["--click-text", "Send"], "click"],
      [["--key", "Return"], "key"],
      [["--scroll", "down"], "scroll"]
    ] as const) {
      let attempts = 0;
      const computer = makeFakeComputer({
        windows: async () => [{ pid: 1, windowId: 2n, title: "F" }],
        [method]: async () => {
          attempts++;
          throw new ComputerError("action_refused", `${method} was refused: nope`, "not_delivered");
        }
      } as Partial<Computer>);
      const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
      const action = commands.find((c) => c.action === "act")!;
      const error = await Promise.resolve(action.run(["--pid", "1", ...flag])).then(
        () => null,
        (e: Error) => e
      );
      expect(JSON.parse(error!.message).error.code).toBe("action_refused");
      expect(JSON.parse(error!.message).error.actionOutcome).toBe("not_delivered");
      expect(JSON.parse(error!.message).error.nextStep).toMatch(/observe|correct|retry/i);
      expect(attempts).toBe(1);
    }
  });

  test("an act timeout maps to command_timeout with unknown outcome and a no-replay nextStep", async () => {
    let attempts = 0;
    const computer = makeFakeComputer({
      windows: async () => [{ pid: 1, windowId: 2n, title: "F" }],
      type: async () => {
        attempts++;
        throw new ComputerError("command_timeout", "type timed out after 30000ms", "unknown");
      }
    });
    const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
    const action = commands.find((c) => c.action === "act")!;
    const error = await Promise.resolve(action.run(["--pid", "1", "--type", "x"])).then(
      () => null,
      (e: Error) => e
    );
    const body = JSON.parse(error!.message).error;
    expect(body.code).toBe("command_timeout");
    expect(body.actionOutcome).toBe("unknown");
    expect(body.nextStep).toMatch(/do NOT repeat the act/);
    expect(attempts).toBe(1);
  });

  test("invalid input never creates a session", () => {
    let sessions = 0;
    const commands = createComputerUseCommands({
      createSession: () => {
        sessions++;
        return makeSession(makeFakeComputer());
      }
    });
    for (const bad of [["perceive"], ["act"], ["windows"], ["act", "--pid", "1", "--type", "a", "--key", "b"]]) {
      expect(() => commands.find((c) => c.action === (bad[0] as string))!.run(bad as string[])).toThrow();
    }
    expect(sessions).toBe(0);
  });

  test("doctor rejects unknown flags through the same strict parser", () => {
    const commands = createComputerUseCommands();
    expect(() => commands.find((c) => c.action === "doctor")!.run(["--verbose"])).toThrow(/unknown flag|not valid/i);
  });

  test("windows envelope keeps bigint-safe window ids", async () => {
    const computer = makeFakeComputer({
      windows: async () => [{ pid: 1, windowId: 9876543210987654321n, title: "Big" }]
    });
    const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
    const out = (await commands.find((c) => c.action === "windows")!.run(["--pid", "1"])) as string;
    expect(JSON.parse(out).windows[0].windowId).toBe("9876543210987654321");
  });

  test("perceive envelope carries pid, windowId, title, elements", async () => {
    const computer = makeFakeComputer({
      windows: async () => [{ pid: 7, windowId: 9n, title: "Doc" }],
      snapshot: async () => ({ elements: [{ role: "AXButton", label: "OK" }], title: "Doc" })
    });
    const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
    const out = (await commands.find((c) => c.action === "perceive")!.run(["--pid", "7"])) as string;
    const body = JSON.parse(out);
    expect(body.pid).toBe(7);
    expect(body.windowId).toBe("9");
    expect(body.title).toBe("Doc");
    expect(body.elements[0].label).toBe("OK");
  });

  test("act --set-value uses the AX-only Computer seam", async () => {
    const calls: Array<{ pid: number; windowId: bigint; token: string; value: string }> = [];
    const computer = makeFakeComputer({
      windows: async () => [{ pid: 7, windowId: 9n, title: "Form" }],
      setValue: async (target, token, value) => {
        calls.push({ pid: target.pid, windowId: target.windowId, token, value });
        return { route: "accessibility", effect: "confirmed" };
      },
      snapshot: async () => ({ elements: [], title: "Form" })
    });
    const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
    await commands.find((c) => c.action === "act")!.run([
      "--pid", "7", "--set-value", "Ada", "--element-token", "field-token"
    ]);
    expect(calls).toEqual([{ pid: 7, windowId: 9n, token: "field-token", value: "Ada" }]);
  });

  test("act key forwards explicit modifiers through the one-shot computer seam", async () => {
    const calls: Array<{ key: string; modifiers?: string[] }> = [];
    const computer = makeFakeComputer({
      windows: async () => [{ pid: 7, windowId: 9n, title: "Editor" }],
      key: async (_target, key, modifiers) => {
        calls.push({ key, ...(modifiers !== undefined ? { modifiers } : {}) });
      },
      snapshot: async () => ({ elements: [], title: "Editor" })
    });
    const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
    await commands.find((c) => c.action === "act")!.run([
      "--pid", "7", "--key", "I", "--modifiers", "cmd,alt"
    ]);
    expect(calls).toEqual([{ key: "I", modifiers: ["cmd", "option"] }]);
  });

  test("act --format observation returns the observe envelope", async () => {
    const computer = makeFakeComputer({
      windows: async () => [{ pid: 7, windowId: 9n, title: "Editor" }],
      key: async () => {},
      observe: async (target) => ({
        id: "01234567-89ab-cdef-0123-456789abcdef",
        target,
        capturedAt: 1,
        epoch: "epoch",
        revision: 1,
        title: "Editor",
        ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
        image: { status: "unavailable" }
      }),
      snapshot: async () => ({ elements: [], title: "Editor" })
    });
    const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
    const output = await commands.find((c) => c.action === "act")!.run([
      "--pid", "7", "--key", "I", "--format", "observation"
    ]);
    expect(JSON.parse(output as string)).toEqual({
      schemaVersion: 1,
      target: { pid: 7, windowId: "9" },
      observation: expect.objectContaining({ id: "01234567-89ab-cdef-0123-456789abcdef" })
    });
  });

  test("act observation failure retains delivered action outcome", async () => {
    const computer = makeFakeComputer({
      windows: async () => [{ pid: 7, windowId: 9n, title: "Editor" }],
      key: async () => {},
      observe: async () => {
        throw new ComputerError("degraded_snapshot", "the observation degraded");
      }
    });
    const commands = createComputerUseCommands({ createSession: () => makeSession(computer) });
    const error = await Promise.resolve(commands.find((c) => c.action === "act")!.run([
      "--pid", "7", "--key", "I", "--format", "observation"
    ])).then(() => null, (e: Error) => e);
    const body = JSON.parse(error!.message).error;
    expect(body.code).toBe("post_action_observe_failed");
    expect(body.actionDelivered).toBe(true);
    expect(body.actionOutcome).toBe("delivered");
    expect(body.nextStep).toMatch(/do NOT repeat/);
  });
});
