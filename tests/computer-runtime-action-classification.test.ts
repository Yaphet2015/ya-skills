import { describe, expect, test } from "bun:test";
import {
  ComputerError,
  createSessionWithBackend,
  type Backend
} from "../packages/computer-runtime/src/session.js";
import { fakeBackendFactory } from "./helpers/computer-fixtures.js";

const target = { pid: 1, windowId: 2n };

function structuredDriverError(
  tag: "Tool" | "InvalidArguments",
  details: { errorCode?: string; message?: string } = {}
): Error {
  const error = new Error(`DriverError.${tag}`) as Error & {
    tag: string;
    inner: { tool: string; message: string; errorCode?: string; reason?: string };
  };
  error.name = `DriverError.${tag}`;
  error.tag = tag;
  error.inner = tag === "Tool"
    ? {
        tool: "type",
        message: details.message ?? "the native action failed",
        ...(details.errorCode !== undefined ? { errorCode: details.errorCode } : {})
      }
    : { tool: "type", message: details.message ?? "invalid arguments", reason: "invalid arguments" };
  return error;
}

function makeSession(
  type: Backend["type"],
  events: string[]
) {
  return createSessionWithBackend(
    { load: async () => ({}), create: fakeBackendFactory({ type }) },
    { onAction: (event) => events.push(`${event.phase}:${event.kind}:${event.outcome ?? ""}`) }
  );
}

describe("native action error classification", () => {
  test("structured Tool timeout and unknown codes are unknown and poison the session", async () => {
    for (const errorCode of ["timeout", "future_native_error"]) {
      let calls = 0;
      const events: string[] = [];
      const session = makeSession(async () => {
        calls++;
        throw structuredDriverError("Tool", { errorCode, message: "private application content" });
      }, events);
      try {
        const first = await session.computer.type(target, "first").then(() => null, (error: unknown) => error);
        expect(first).toBeInstanceOf(ComputerError);
        expect((first as ComputerError).code).toBe("action_failed");
        expect((first as ComputerError).actionOutcome).toBe("unknown");
        expect((first as ComputerError).message).toContain("errorCode=" + errorCode);
        expect((first as ComputerError).message).not.toContain("private application content");
        expect(events).toEqual(["started:type:", "finished:type:unknown"]);

        const second = await session.computer.type(target, "second").then(() => null, (error: unknown) => error);
        expect(second).toBeInstanceOf(ComputerError);
        expect((second as ComputerError).code).toBe("session_unusable");
        expect(calls).toBe(1);
      } finally {
        await session.close();
      }
    }
  });

  test("a Tool class name without structured details is unknown and poisons the session", async () => {
    let calls = 0;
    const events: string[] = [];
    const session = makeSession(async () => {
      calls++;
      const error = new Error("driver operation failed");
      error.name = "DriverError.Tool";
      throw error;
    }, events);
    try {
      const first = await session.computer.type(target, "first").then(() => null, (error: unknown) => error);
      expect(first).toBeInstanceOf(ComputerError);
      expect((first as ComputerError).code).toBe("action_failed");
      expect((first as ComputerError).actionOutcome).toBe("unknown");
      expect((first as ComputerError).message).toContain("driver operation failed");
      expect(events).toEqual(["started:type:", "finished:type:unknown"]);

      const second = await session.computer.type(target, "second").then(() => null, (error: unknown) => error);
      expect(second).toBeInstanceOf(ComputerError);
      expect((second as ComputerError).code).toBe("session_unusable");
      expect(calls).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("only explicit predispatch Tool codes remain not_delivered", async () => {
    for (const errorCode of [
      "stale_element_token",
      "window_target_not_found",
      "px_capture_unavailable"
    ]) {
      let calls = 0;
      const events: string[] = [];
      const session = makeSession(async () => {
        calls++;
        if (calls === 1) throw structuredDriverError("Tool", { errorCode });
        return { isError: false };
      }, events);
      try {
        const first = await session.computer.type(target, "first").then(() => null, (error: unknown) => error);
        expect(first).toBeInstanceOf(ComputerError);
        expect((first as ComputerError).code).toBe("action_refused");
        expect((first as ComputerError).actionOutcome).toBe("not_delivered");
        await session.computer.type(target, "second");
        expect(calls).toBe(2);
        expect(events).toEqual([
          "started:type:",
          "finished:type:not_delivered",
          "started:type:",
          "finished:type:delivered"
        ]);
      } finally {
        await session.close();
      }
    }
  });

  test("InvalidArguments remains a predispatch refusal", async () => {
    let calls = 0;
    const events: string[] = [];
    const session = makeSession(async () => {
      calls++;
      if (calls === 1) throw structuredDriverError("InvalidArguments");
      return { isError: false };
    }, events);
    try {
      const first = await session.computer.type(target, "first").then(() => null, (error: unknown) => error);
      expect(first).toBeInstanceOf(ComputerError);
      expect((first as ComputerError).code).toBe("action_refused");
      expect((first as ComputerError).actionOutcome).toBe("not_delivered");
      await session.computer.type(target, "second");
      expect(calls).toBe(2);
    } finally {
      await session.close();
    }
  });

  test("AbortError after the native action seam is unknown and poisons the session", async () => {
    let calls = 0;
    const events: string[] = [];
    const session = makeSession(async () => {
      calls++;
      const error = new Error("native operation was cancelled");
      error.name = "AbortError";
      throw error;
    }, events);
    try {
      const first = await session.computer.type(target, "first").then(() => null, (error: unknown) => error);
      expect(first).toBeInstanceOf(ComputerError);
      expect((first as ComputerError).code).toBe("aborted");
      expect((first as ComputerError).actionOutcome).toBe("unknown");
      expect(events).toEqual(["started:type:", "finished:type:unknown"]);

      const second = await session.computer.type(target, "second").then(() => null, (error: unknown) => error);
      expect(second).toBeInstanceOf(ComputerError);
      expect((second as ComputerError).code).toBe("session_unusable");
      expect(calls).toBe(1);
    } finally {
      await session.close();
    }
  });
});
