import { describe, expect, test } from "bun:test";
import { ComputerError, createSessionWithBackend } from "../packages/computer-runtime/src/session.js";
import { fakeBackendFactory, FIXTURE_TARGET } from "./helpers/computer-fixtures.js";

const target = FIXTURE_TARGET;

describe("strict AX-only setValue", () => {
  test("sends only the token and value and requires a confirmed accessibility result", async () => {
    const calls: Array<{ target: typeof target; token: string; value: string }> = [];
    const events: string[] = [];
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: fakeBackendFactory({
          setValue: async (receivedTarget, elementToken, value) => {
            calls.push({ target: receivedTarget, token: elementToken, value });
            return {
              isError: false,
              structuredJson: JSON.stringify({
                route: "accessibility",
                effect: "confirmed",
                delivery: { mode: "not_applicable", delivered_count: 1 }
              })
            };
          }
        })
      },
      { onAction: (event) => events.push(`${event.phase}:${event.kind}:${event.outcome ?? ""}`) }
    );
    try {
      await expect(session.computer.setValue(target, "field-token", "Ada")).resolves.toEqual({
        route: "accessibility",
        effect: "confirmed",
        delivery: { mode: "not_applicable", deliveredCount: 1 }
      });
      expect(calls).toEqual([{ target, token: "field-token", value: "Ada" }]);
      expect(events).toEqual(["started:set_value:", "finished:set_value:delivered"]);
    } finally {
      await session.close();
    }
  });

  test("rejects before native dispatch when the backend has no AX-only operation", async () => {
    let calls = 0;
    const session = createSessionWithBackend(
      { load: async () => ({}), create: fakeBackendFactory({ setValue: undefined }) },
      {}
    );
    try {
      const error = await session.computer.setValue(target, "field-token", "Ada").then(
        () => null,
        (value: unknown) => value
      );
      expect(error).toBeInstanceOf(ComputerError);
      expect((error as ComputerError).code).toBe("ax_only_unsupported");
      expect((error as ComputerError).actionOutcome).toBe("not_delivered");
      expect(calls).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("rejects a result without structured AX proof", async () => {
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: fakeBackendFactory({
          setValue: async () => ({ isError: false, action: { route: "accessibility", effect: "confirmed" } })
        })
      },
      {}
    );
    try {
      const error = await session.computer.setValue(target, "field-token", "Ada").then(
        () => null,
        (value: unknown) => value
      );
      expect(error).toBeInstanceOf(ComputerError);
      expect((error as ComputerError).code).toBe("ax_only_unverified");
      expect((error as ComputerError).actionOutcome).toBe("unknown");
    } finally {
      await session.close();
    }
  });

  test("poisons the session when the native result reports another route", async () => {
    let calls = 0;
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: fakeBackendFactory({
          setValue: async () => {
            calls++;
            return {
              isError: false,
              structuredJson: JSON.stringify({ route: "synthetic_events", effect: "confirmed" })
            };
          }
        })
      },
      {}
    );
    try {
      const first = await session.computer.setValue(target, "field-token", "Ada").then(
        () => null,
        (value: unknown) => value
      );
      expect(first).toBeInstanceOf(ComputerError);
      expect((first as ComputerError).code).toBe("ax_only_unverified");
      expect((first as ComputerError).actionOutcome).toBe("unknown");

      const second = await session.computer.setValue(target, "field-token", "Grace").then(
        () => null,
        (value: unknown) => value
      );
      expect(second).toBeInstanceOf(ComputerError);
      expect((second as ComputerError).code).toBe("session_unusable");
      expect(calls).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("rejects an empty token before starting an action", async () => {
    let calls = 0;
    const events: string[] = [];
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: fakeBackendFactory({
          setValue: async () => {
            calls++;
            return { isError: false, structuredJson: JSON.stringify({ route: "accessibility", effect: "confirmed" }) };
          }
        })
      },
      { onAction: (event) => events.push(`${event.phase}:${event.kind}`) }
    );
    try {
      await expect(session.computer.setValue(target, "  ", "Ada")).rejects.toMatchObject({
        code: "invalid_request",
        actionOutcome: "not_delivered"
      });
      expect(calls).toBe(0);
      expect(events).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
