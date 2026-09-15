import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../packages/functions-computer-use/src/args.js";
import { batchCommand, defaultRequestsDir } from "../packages/functions-computer-use/src/batch-command.js";
import { observeCommand } from "../packages/functions-computer-use/src/observe-command.js";
import {
  ComputerError,
  type AxElement,
  type BatchRequest,
  type BatchResult,
  type ComputerSession,
  type Observation,
  type Target,
  type WindowRef
} from "@ya-skills/computer-runtime";

// ---------------------------------------------------------------------------
// parseRequest: observe / batch / visual click flags

describe("parseRequest (agentic additions)", () => {
  test("the plan's reference failures", () => {
    expect(() => parseRequest("act", ["--pid", "1", "--click-x", "2", "--click-y", "3"])).toThrow(/observation/);
    expect(() => parseRequest("act", ["--pid", "1", "--type", "x", "--key", "Return"])).toThrow(/exactly one/);
  });

  test("a visual click needs observation + both coordinates", () => {
    const request = parseRequest("act", [
      "--pid", "1", "--click-x", "2", "--click-y", "3", "--observation", "01234567-89ab-cdef-0123-456789abcdef"
    ]);
    expect(request).toMatchObject({
      kind: "act",
      pid: 1,
      action: "click_point",
      clickPoint: { observationId: "01234567-89ab-cdef-0123-456789abcdef", x: 2, y: 3 }
    });
    expect(() => parseRequest("act", ["--pid", "1", "--click-x", "2", "--observation", "01234567-89ab-cdef-0123-456789abcdef"])).toThrow(/together/);
    expect(() => parseRequest("act", ["--pid", "1", "--click-x", "2", "--click-y", "3", "--observation", "abc"])).toThrow(/UUID/);
    expect(() => parseRequest("act", ["--pid", "1", "--click-x", "-2", "--click-y", "3", "--observation", "01234567-89ab-cdef-0123-456789abcdef"])).toThrow(/non-negative/);
  });

  test("old --x/--y still belong to scroll only", () => {
    const request = parseRequest("act", ["--pid", "1", "--scroll", "down", "--amount", "2", "--x", "5", "--y", "6"]);
    expect(request).toMatchObject({ action: "scroll", scroll: { x: 5, y: 6 } });
    expect(() => parseRequest("observe", ["--pid", "1", "--x", "5"])).toThrow(/not valid for this action|unknown flag/);
  });

  test("observe parses mode, max-dimension, and structured selector", () => {
    const request = parseRequest("observe", [
      "--pid", "9", "--window", "5", "--mode", "both", "--max-dimension", "1600",
      "--select-text", "Save", "--select-match", "contains", "--select-role", "AXButton"
    ]);
    expect(request).toMatchObject({
      kind: "observe",
      pid: 9,
      windowId: 5n,
      mode: "both",
      maxDimension: 1600,
      selector: { text: "Save", match: "contains", role: "AXButton" }
    });
    expect(() => parseRequest("observe", ["--pid", "1", "--mode", "wat"])).toThrow(/mode/);
    expect(() => parseRequest("observe", ["--pid", "1", "--select-match", "exact"])).toThrow(/select-text/);
  });

  test("batch requires --file and --request-id together", () => {
    expect(() => parseRequest("batch", ["--pid", "1"])).toThrow(/--file/);
    expect(() => parseRequest("batch", ["--pid", "1", "--file", "x.json"])).toThrow(/request-id/);
    expect(parseRequest("batch", ["--pid", "1", "--file", "x.json", "--request-id", "r1"])).toMatchObject({
      kind: "batch",
      file: "x.json",
      requestId: "r1"
    });
  });
});

// ---------------------------------------------------------------------------
// batch command orchestration through injected sessions (no SDK anywhere)

function fakeSession(deps: {
  windows: WindowRef[];
  batchResult?: BatchResult | ((request: BatchRequest) => BatchResult);
  observation?: Observation;
  target?: Target;
}): ComputerSession {
  const target: Target = deps.target ?? { pid: 1, windowId: 10n };
  const computer = {
    apps: async () => [],
    windows: async () => deps.windows,
    snapshot: async () => ({ elements: [], title: "" }),
    observe: async (): Promise<Observation> =>
      deps.observation ??
      ({
        id: "obs-1",
        target,
        capturedAt: Date.now(),
        epoch: "e",
        revision: 0,
        title: "t",
        ax: { status: "usable", elements: [] as AxElement[], total: 0, returned: 0, complete: true },
        image: { status: "unavailable" }
      } as Observation),
    clickPoint: async () => undefined,
    batch: async (_target: Target, request: BatchRequest): Promise<BatchResult> => {
      if (typeof deps.batchResult === "function") return deps.batchResult(request);
      return deps.batchResult ?? {
        status: "completed",
        steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
      };
    },
    click: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    scroll: async () => undefined,
    waitFor: async () => []
  };
  return {
    computer,
    metadata: async () => ({ driverVersion: "test", pid: 1 }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    close: async () => undefined
  };
}

describe("batchCommand (journal-backed dedup, no replay)", () => {
  async function makeDeps() {
    const dir = await mkdtemp(join(tmpdir(), "cu-batch-cli-"));
    const file = join(dir, "steps.json");
    await writeFile(file, JSON.stringify({ actions: [{ kind: "key", key: "Return" }] }));
    return { dir, file };
  }

  test("a completed batch prints a schemaVersion-1 result", async () => {
    const { dir, file } = await makeDeps();
    try {
      const run = batchCommand({
        requestsDir: join(dir, "requests"),
        createSession: () => fakeSession({ windows: [{ pid: 1, windowId: 10n, title: "W" }] })
      });
      const out = await run({ pid: 1, file, requestId: "r-1" });
      const parsed = JSON.parse(out);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.result.status).toBe("completed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--out-dir is passed to the batch session", async () => {
    const { dir, file } = await makeDeps();
    try {
      let seen: { artifactsDir?: string } | undefined;
      const run = batchCommand({
        requestsDir: join(dir, "requests"),
        createSession: (options) => {
          seen = options;
          return fakeSession({ windows: [{ pid: 1, windowId: 10n, title: "W" }] });
        }
      });
      await run({ pid: 1, file, requestId: "r-out", outDir: "/tmp/batch-evidence" });
      expect(seen?.artifactsDir).toBe("/tmp/batch-evidence");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the same request-id + same content replays nothing", async () => {
    const { dir, file } = await makeDeps();
    try {
      let runs = 0;
      const run = batchCommand({
        requestsDir: join(dir, "requests"),
        createSession: () => {
          runs++;
          return fakeSession({ windows: [{ pid: 1, windowId: 10n, title: "W" }] });
        }
      });
      await run({ pid: 1, file, requestId: "r-2" });
      const second = await run({ pid: 1, file, requestId: "r-2" });
      expect(runs).toBe(1);
      expect(JSON.parse(second).result.status).toBe("completed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the same request-id with different content is a conflict", async () => {
    const { dir, file } = await makeDeps();
    try {
      const run = batchCommand({
        requestsDir: join(dir, "requests"),
        createSession: () => fakeSession({ windows: [{ pid: 1, windowId: 10n, title: "W" }] })
      });
      await run({ pid: 1, file, requestId: "r-3" });
      await writeFile(file, JSON.stringify({ actions: [{ kind: "key", key: "Escape" }] }));
      const error = await run({ pid: 1, file, requestId: "r-3" }).then(() => null, (e: unknown) => e);
      expect((error as Error).message).toMatch(/request_conflict/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("failed and interrupted batches exit non-zero with receipts attached", async () => {
    const { dir, file } = await makeDeps();
    await writeFile(file, JSON.stringify({ actions: [
      { kind: "key", key: "Return" },
      { kind: "type", text: "later" },
      { kind: "type", text: "never" }
    ] }));
    try {
      let calls = 0;
      const run = batchCommand({
        requestsDir: join(dir, "requests"),
        createSession: () =>
          fakeSession({
            windows: [{ pid: 1, windowId: 10n, title: "W" }],
            batchResult: (request) => {
              calls++;
              if (calls === 1) return { status: "completed", steps: [{ index: 0, kind: request.actions[0]!.kind, status: "delivered" }] };
              return { status: "interrupted", steps: [{ index: 0, kind: request.actions[0]!.kind, status: "unknown" }] };
            }
          })
      });
      const error = await run({ pid: 1, file, requestId: "r-4" }).then(() => null, (e: unknown) => e);
      const parsed = JSON.parse((error as Error).message);
      expect(parsed.error.code).toBe("batch_interrupted");
      expect(parsed.error.result.steps.map((s: { status: string }) => s.status)).toEqual([
        "delivered",
        "unknown",
        "not_run"
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an invalid batch file fails before any driver starts", async () => {
    const { dir } = await makeDeps();
    const file = join(dir, "bad.json");
    await writeFile(file, JSON.stringify({ actions: [{ kind: "explode" }] }));
    let sessions = 0;
    try {
      const run = batchCommand({
        requestsDir: join(dir, "requests"),
        createSession: () => {
          sessions++;
          return fakeSession({ windows: [] });
        }
      });
      const error = await run({ pid: 1, file, requestId: "r-5" }).then(() => null, (e: unknown) => e);
      expect((error as Error).message).toMatch(/batch_request_invalid/);
      expect(sessions).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unknown-delivery mid-run failure records unknown, never replays", async () => {
    const { dir, file } = await makeDeps();
    try {
      const run = batchCommand({
        requestsDir: join(dir, "requests"),
        createSession: () => {
          const session = fakeSession({ windows: [{ pid: 1, windowId: 10n, title: "W" }] });
          (session.computer as unknown as { batch: () => Promise<BatchResult> }).batch = async () => {
            throw new ComputerError("command_timeout", "native call timed out", "unknown");
          };
          return session;
        }
      });
      const error = await run({ pid: 1, file, requestId: "r-6" }).then(() => null, (e: unknown) => e);
      const parsedError = JSON.parse((error as Error).message);
      expect(parsedError.error.code).toBe("batch_unknown");
      expect(parsedError.error.result.steps[0].status).toBe("unknown");
      expect(parsedError.error.message).toMatch(/native call timed out/);
      // A retry with the same id reads the terminal unknown state and refuses.
      const retry = await run({ pid: 1, file, requestId: "r-6" }).then(() => null, (e: unknown) => e);
      expect((retry as Error).message).toMatch(/batch_not_replayed|batch_in_progress/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defaultRequestsDir lives in the user cache", () => {
    expect(defaultRequestsDir()).toContain("Library/Caches/ya-skills");
  });
});

describe("observeCommand (schemaVersion-1 envelope)", () => {
  test("prints target + observation with independent channels", async () => {
    const run = observeCommand({
      createSession: () => fakeSession({ windows: [{ pid: 1, windowId: 10n, title: "W" }] })
    });
    const out = await run({ pid: 1, mode: "both" });
    const parsed = JSON.parse(out);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.target).toEqual({ pid: 1, windowId: "10" });
    expect(parsed.observation.id).toBe("obs-1");
    expect(parsed.observation.ax.status).toBe("usable");
    expect(parsed.observation.image.status).toBe("unavailable");
  });

  test("--out-dir is passed to the observation session", async () => {
    let seen: { artifactsDir?: string } | undefined;
    const run = observeCommand({
      createSession: (options) => {
        seen = options;
        return fakeSession({ windows: [{ pid: 1, windowId: 10n, title: "W" }] });
      }
    });
    await run({ pid: 1, mode: "both", outDir: "/tmp/observation-evidence" });
    expect(seen?.artifactsDir).toBe("/tmp/observation-evidence");
  });

  test("a missing window fails with the shared selector error", async () => {
    const run = observeCommand({
      createSession: () => fakeSession({ windows: [] })
    });
    await expect(run({ pid: 1, mode: "ax" })).rejects.toThrow(/no usable window|not found/);
  });
});
