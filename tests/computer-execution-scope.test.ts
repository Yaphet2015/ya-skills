import { expect, test } from "bun:test";
import { createExecutionScope } from "../packages/computer-runtime/src/execution-scope.js";

test("child budgets cannot extend their parent and sibling cancellation stays local", () => {
  const parent = createExecutionScope({ timeoutMs: 1_000 });
  const first = parent.child({ timeoutMs: 10_000 });
  const second = parent.child();
  expect(first.deadlineAt).toBe(parent.deadlineAt);
  first.abort("first finished");
  expect(first.signal.aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false);
  parent.abort("session closed");
  expect(second.signal.reason).toBe("session closed");
  first.dispose();
  second.dispose();
  parent.dispose();
});

test("deadline owner chooses timeout classification without pretending native work stopped", async () => {
  const scope = createExecutionScope({ timeoutMs: 1 });
  await new Promise<void>((resolve) => scope.onDeadline(resolve));
  expect(scope.remainingMs()).toBe(0);
  expect(scope.signal.aborted).toBe(false);
  scope.dispose();
});

test("disposal cancels watchdog and detaches caller cancellation", async () => {
  const caller = new AbortController();
  const scope = createExecutionScope({ timeoutMs: 1, signal: caller.signal });
  let expired = false;
  scope.onDeadline(() => { expired = true; });
  scope.dispose();
  caller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(expired).toBe(false);
  expect(scope.signal.aborted).toBe(false);
});
