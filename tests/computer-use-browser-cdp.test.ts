import { describe, expect, test } from "bun:test";
import {
  BrowserCdpError,
  evaluateTarget,
  listTargets,
  type CdpWebSocketLike
} from "../skills/computer-use/scripts/browser-cdp.mjs";

const targetPayload = [
  {
    id: "tab-a",
    type: "page",
    title: "A",
    url: "https://example.test/a",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/tab-a",
    ignored: "not exposed"
  },
  {
    id: "tab-b",
    type: "page",
    title: "B",
    url: "https://example.test/b",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/tab-b"
  }
];

function mockFetch(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
}

class MockWebSocket implements CdpWebSocketLike {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(value: any) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(event: string, listener: (value: any) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: (value: any) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
    const request = JSON.parse(data) as { id: number };
    queueMicrotask(() => {
      // An unrelated event proves that evaluateTarget waits for the matching
      // request id instead of treating the first CDP message as the answer.
      this.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired" }) });
      this.emit("message", {
        data: JSON.stringify({
          id: request.id,
          result: { result: { type: "object", value: { title: "B", ready: true } } }
        })
      });
    });
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(event: string, value: any): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

describe("browser CDP helper", () => {
  test("lists bounded, projected targets without exposing unrelated fields", async () => {
    const targets = await listTargets({ fetchImpl: mockFetch(targetPayload) });
    expect(targets).toEqual([
      {
        id: "tab-a",
        type: "page",
        title: "A",
        url: "https://example.test/a",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/tab-a"
      },
      {
        id: "tab-b",
        type: "page",
        title: "B",
        url: "https://example.test/b",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/tab-b"
      }
    ]);
  });

  test("evaluates only the explicitly selected target and returns a compact result", async () => {
    MockWebSocket.instances = [];
    const result = await evaluateTarget({
      targetId: "tab-b",
      expression: "document.title",
      fetchImpl: mockFetch(targetPayload),
      webSocketFactory: MockWebSocket,
      timeoutMs: 500
    });
    expect(result).toEqual({
      target: {
        id: "tab-b",
        type: "page",
        title: "B",
        url: "https://example.test/b",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/tab-b"
      },
      result: { title: "B", ready: true }
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toBe("ws://127.0.0.1/devtools/tab-b");
    expect(JSON.parse(MockWebSocket.instances[0]!.sent[0]!)).toEqual({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: "document.title",
        awaitPromise: true,
        returnByValue: true,
        userGesture: false
      }
    });
  });

  test("does not select a target implicitly", async () => {
    const error = await evaluateTarget({
      targetId: "missing",
      expression: "document.title",
      fetchImpl: mockFetch(targetPayload)
    }).then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(BrowserCdpError);
    expect((error as BrowserCdpError).code).toBe("cdp_target_not_found");
  });

  test("fails closed when the discovery body exceeds the output budget", async () => {
    const error = await listTargets({
      fetchImpl: mockFetch({ text: "x".repeat(20_000) }),
      maxOutputBytes: 128
    }).then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(BrowserCdpError);
    expect((error as BrowserCdpError).code).toBe("cdp_output_limit");
  });

  test("times out and closes a WebSocket that never opens", async () => {
    class NeverOpens implements CdpWebSocketLike {
      readyState = 0;
      closed = false;
      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void {
        this.closed = true;
      }
    }
    let socket: NeverOpens | undefined;
    const error = await evaluateTarget({
      targetId: "tab-a",
      expression: "document.title",
      fetchImpl: mockFetch(targetPayload),
      webSocketFactory: class extends NeverOpens {
        constructor(url: string) {
          super();
          void url;
          socket = this;
        }
      },
      timeoutMs: 20
    }).then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(BrowserCdpError);
    expect((error as BrowserCdpError).code).toBe("cdp_timeout");
    expect(socket?.closed).toBe(true);
  });
});
