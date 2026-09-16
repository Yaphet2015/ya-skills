import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  decodeRequest,
  encodeControl,
  FrameReader
} from "../../packages/computer-session/src/protocol.js";
import type { SessionReply, SessionRequest } from "../../packages/computer-session/src/types.js";

export interface IntegrationCliPeer {
  socketPath: string;
  requests: SessionRequest[];
  close(): Promise<void>;
}

/**
 * A real Unix-socket peer for CLI boundary tests. The public command routes
 * through sendRequest, encodeRequest, and decodeSessionReply; this peer only
 * supplies a deterministic, schema-valid terminal reply and records the
 * decoded request envelope.
 */
export async function startIntegrationCliPeer(
  root: string,
  replyFor: (request: SessionRequest) => SessionReply = (request) => ({
    schemaVersion: 1,
    requestId: request.requestId,
    status: "completed",
    result: {
      status: "completed",
      steps: request.operation.kind === "batch"
        ? request.operation.request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
        : []
    }
  })
): Promise<IntegrationCliPeer> {
  const socketPath = join(root, "peer.sock");
  const requests: SessionRequest[] = [];
  const server: Server = createServer((socket) => {
    const reader = new FrameReader();
    socket.on("data", (chunk) => {
      try {
        for (const frame of reader.push(chunk)) {
          const request = decodeRequest(frame);
          requests.push(request);
          socket.end(encodeControl(replyFor(request)));
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}
