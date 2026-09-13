import { describe, expect, test } from "bun:test";
import { createComputerUseCommands, parseRequest } from "@ya-skills/functions-computer-use";

describe("command registration", () => {
  test("registers exactly the five desktop operations", () => {
    expect(createComputerUseCommands().map((command) => `${command.domain} ${command.action}`)).toEqual([
      "computer-use doctor",
      "computer-use apps",
      "computer-use windows",
      "computer-use perceive",
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

  test("key with empty text is rejected", () => {
    expect(() => parseRequest("act", ["--pid", "1", "--key", ""])).toThrow(/--key/);
  });

  test("boolean flags: shot and activate", () => {
    const req = parseRequest("perceive", ["--pid", "1", "--shot"]);
    expect((req as { shot: boolean }).shot).toBe(true);
    expect((req as { activate: boolean }).activate).toBe(false);
    const act = parseRequest("perceive", ["--pid", "1", "--shot", "--activate"]);
    expect((act as { activate: boolean }).activate).toBe(true);
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
