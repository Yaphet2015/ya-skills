import { expect, test } from "bun:test";
import { executeHostedBatch } from "../packages/computer-session/src/host-batch.js";
import { callDriverStep } from "../packages/computer-session/src/host-driver.js";
import { executeBatchSequence } from "../packages/computer-runtime/src/batch-sequence.js";
import { ComputerError, type ActionReceipt, type BatchRequest } from "@ya-skills/computer-runtime";

const request: BatchRequest = { actions: [{ kind: "type", text: "a" }, { kind: "type", text: "b" }] };

test("journal latency can close admission before dispatch in every batch mode", async () => {
  for (const mode of ["standalone", "hosted", "script"] as const) {
    let expired = false;
    let dispatched = false;
    const recorded: ActionReceipt[] = [];
    const failure = { code: "batch_deadline", message: "expired during durable start" };
    const result = await executeBatchSequence(request, {
      mode, deadlineAt: Date.now() + 1000,
      boundary: () => expired ? failure : null,
      started: async () => { expired = true; },
      dispatch: async () => { dispatched = true; throw new Error("must not dispatch"); },
      recorded: async (receipt) => { recorded.push(receipt); }
    });
    expect(dispatched).toBe(false);
    expect(result.status).toBe("interrupted");
    expect(recorded.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    expect(recorded[0]!.error).toEqual(failure);
    expect(recorded[1]!.error).toEqual(mode === "standalone" ? undefined : failure);
  }
});

test("a receipt persistence failure prevents later dispatch and is not recast as a driver error", async () => {
  let calls = 0;
  const failure = new Error("disk full");
  await expect(executeBatchSequence(request, {
    mode: "hosted", deadlineAt: Date.now() + 1000,
    boundary: () => null,
    started: () => {},
    dispatch: async (action, context) => {
      calls++;
      return { status: "completed", receipt: { index: context.index, kind: action.kind, status: "delivered" } };
    },
    recorded: async () => { throw failure; }
  })).rejects.toBe(failure);
  expect(calls).toBe(1);
});

test("unknown script delivery preserves global indices and never dispatches the tail", async () => {
  let calls = 0;
  const result = await executeBatchSequence(request, {
    mode: "script", deadlineAt: Date.now() + 1000, indexOffset: 7,
    boundary: () => null, started: () => {}, recorded: async () => {},
    dispatch: async () => { calls++; throw new Error("worker exited"); }
  });
  expect(calls).toBe(1);
  expect(result.status).toBe("interrupted");
  expect(result.steps.map((r) => [r.index, r.status, r.error?.code])).toEqual([
    [7, "unknown", "action_failed"], [8, "not_run", "not_run_after_unknown"]
  ]);
});


test("hosted batches keep missing-status driver failures distinct from interruption", async () => {
  const result = await executeHostedBatch({
    call: async () => ({ steps: [{ status: "not_delivered", error: { code: 7, message: null } }] })
  }, async () => {}, "request", request, new AbortController().signal, Date.now() + 1000);
  expect(result.status).toBe("failed");
  expect(result.steps[1]).toEqual({
    index: 1, kind: "type", status: "not_run",
    error: { code: "action_failed", message: "the action ended with not_delivered" }
  });
});

test("step capability is selected before dispatch and never retried after an error", async () => {
  const calls: string[] = [];
  await expect(callDriverStep({
    supportsStep: true,
    call: async (method) => {
      calls.push(method);
      throw new ComputerError("invalid_request", "step failed after entering the driver");
    }
  }, request.actions[0]!, { index: 0, deadlineAt: Date.now() + 1000 })).rejects.toThrow("step failed");
  expect(calls).toEqual(["step"]);
});

test("legacy driver capability uses a single batch adapter call", async () => {
  const calls: string[] = [];
  const result = await callDriverStep({
    supportsStep: false,
    call: async (method, args) => {
      calls.push(method);
      expect(args.request).toMatchObject({ actions: [request.actions[0]], maxActions: 1 });
      return { status: "completed", steps: [{ index: 0, kind: "type", status: "delivered" }] };
    }
  }, request.actions[0]!, { index: 4, deadlineAt: Date.now() + 1000 });
  expect(calls).toEqual(["batch"]);
  expect(result).toEqual({
    status: "completed",
    receipt: { index: 4, kind: "type", status: "delivered" }
  });
});

test("host never replays a step error as batch after delivery", async () => {
  const calls: string[] = [];
  let delivered = 0;
  const result = await executeHostedBatch({
    supportsStep: true,
    call: async (method) => {
      calls.push(method);
      if (method !== "step") throw new Error("batch replayed");
      delivered++;
      throw new ComputerError("invalid_request", "step result was lost", "unknown");
    }
  }, async () => {}, "request", { actions: [{ kind: "type", text: "a" }] }, new AbortController().signal, Date.now() + 1000);

  expect(delivered).toBe(1);
  expect(calls).toEqual(["step"]);
  expect(result.status).toBe("interrupted");
  expect(result.steps[0]).toMatchObject({ status: "unknown", error: { code: "invalid_request" } });
});

test("host keeps an undefined step result unknown without a batch replay", async () => {
  const calls: string[] = [];
  let delivered = 0;
  const result = await executeHostedBatch({
    supportsStep: true,
    call: async (method) => {
      calls.push(method);
      if (method !== "step") throw new Error("batch replayed");
      delivered++;
      return undefined;
    }
  }, async () => {}, "request", { actions: [{ kind: "type", text: "a" }] }, new AbortController().signal, Date.now() + 1000);

  expect(delivered).toBe(1);
  expect(calls).toEqual(["step"]);
  expect(result.status).toBe("interrupted");
  expect(result.steps[0]).toMatchObject({ status: "unknown" });
});
