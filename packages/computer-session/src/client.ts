// One-shot request client (B1): connect, send one frame, read one reply.
// A wait timeout never resends a mutation — it returns the requestId so the
// caller can ask `status` instead.

import { connect } from "node:net";
import { FrameReader, decodeReply, decodeSessionReply, encodeControl, encodeRequest } from "./protocol.js";
import type { SessionControl, SessionControlReply, SessionReply, SessionRequest } from "./types.js";

export interface SendResult {
  reply: SessionReply | null;
  timedOut: boolean;
}

function roundtrip(socketPath: string, line: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const reader = new FrameReader();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(Object.assign(new Error(`no reply within ${timeoutMs}ms`), { code: "client_timeout" }));
      });
    }, timeoutMs);
    socket.on("connect", () => {
      if (!settled) socket.write(line);
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        const frames = reader.push(chunk);
        if (frames.length > 0) {
          finish(() => {
            socket.end();
            resolve(frames[0]!);
          });
        }
      } catch (error) {
        finish(() => {
          socket.destroy();
          reject(error);
        });
      }
    });
    socket.on("error", (error) => {
      finish(() => reject(error));
    });
    socket.on("close", () => {
      // A host cancelling/closing a business request destroys that socket.
      // Report the closure immediately instead of waiting for the mutation
      // timeout; the journal/status control plane remains available.
      finish(() => reject(Object.assign(new Error("connection closed before a reply"), { code: "connection_closed" })));
    });
  });
}

export async function sendRequest(
  socketPath: string,
  request: SessionRequest,
  timeoutMs: number
): Promise<SessionReply> {
  const line = await roundtrip(socketPath, encodeRequest(request), timeoutMs);
  return decodeSessionReply(line, request.operation);
}

export async function sendControl(
  socketPath: string,
  control: SessionControl,
  timeoutMs: number
): Promise<SessionControlReply> {
  const line = await roundtrip(socketPath, encodeControl(control), timeoutMs);
  return decodeReply(line) as unknown as SessionControlReply;
}
