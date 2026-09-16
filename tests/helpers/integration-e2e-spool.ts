import { Buffer } from "node:buffer";

export const INTEGRATION_SPOOL_CHUNK_BYTES = 64 * 1024;

function frameWithBytes(type: string, totalBytes: number): string {
  const prefix = `{"type":"${type}","payload":{"marker":"integration","data":"`;
  const suffix = `"}}\n`;
  const fillerBytes = totalBytes - Buffer.byteLength(prefix + suffix, "utf8");
  if (fillerBytes < 0) throw new Error(`frame prefix exceeds ${totalBytes} bytes`);
  const frame = prefix + "x".repeat(fillerBytes) + suffix;
  if (Buffer.byteLength(frame, "utf8") !== totalBytes) {
    throw new Error(`frame size mismatch for ${type}`);
  }
  return frame;
}

/** A burst whose frame boundaries land exactly on every read boundary. */
export function newlineAlignedIntegrationBurst(): string {
  return [
    frameWithBytes("case_finished", INTEGRATION_SPOOL_CHUNK_BYTES),
    frameWithBytes("hook_finished", INTEGRATION_SPOOL_CHUNK_BYTES),
    frameWithBytes("cleanup_finished", INTEGRATION_SPOOL_CHUNK_BYTES),
    frameWithBytes("run_finished", INTEGRATION_SPOOL_CHUNK_BYTES)
  ].join("");
}

/** A burst whose second frame starts in one chunk and ends in the next. */
export function partialBoundaryIntegrationBurst(): string {
  return [
    frameWithBytes("case_finished", INTEGRATION_SPOOL_CHUNK_BYTES - 13),
    frameWithBytes("hook_finished", INTEGRATION_SPOOL_CHUNK_BYTES + 17),
    frameWithBytes("cleanup_finished", INTEGRATION_SPOOL_CHUNK_BYTES)
  ].join("");
}
