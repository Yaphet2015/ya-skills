import type { ChildProcess } from "node:child_process";
import { FileSpoolReader } from "./worker-lifecycle.js";

const CONTROL_CHUNK_BYTES = 64 * 1024;

export interface ExecControlSpool {
  poll(): void;
  drainToEof(): void;
  failed(): boolean;
}

/** Tail and fully drain the worker's fd3 regular-file control stream. */
export function createExecControlSpool(
  controlPath: string,
  controlReadFd: number,
  onLine: (line: string) => void,
  onFailure: () => void
): ExecControlSpool {
  const reader = new FileSpoolReader(controlPath, CONTROL_CHUNK_BYTES, controlReadFd);
  let failed = false;

  const fail = (): void => {
    if (failed) return;
    failed = true;
    onFailure();
  };

  const processLines = (lines: string[]): void => {
    for (const line of lines) {
      if (line.trim() !== "") onLine(line);
    }
  };

  const poll = (): void => {
    if (failed) return;
    try {
      processLines(reader.poll().lines);
    } catch {
      fail();
    }
  };

  const drainToEof = (): void => {
    if (failed) return;
    try {
      reader.drainToEofSync(processLines);
    } catch {
      fail();
    }
  };

  return { poll, drainToEof, failed: () => failed };
}

export interface ExecOutputCapture {
  stdout: string[];
  stderr: string[];
  attach(child: ChildProcess, onOverflow: () => void, onInvalidUtf8: (kind: "stdout" | "stderr") => void): void;
}

/** Capture worker logs with a combined byte cap and strict UTF-8 decoding. */
export function createExecOutputCapture(cap: number): ExecOutputCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let outputBytes = 0;
  let overflow = false;
  const decoders = {
    stdout: new TextDecoder("utf-8", { fatal: true }),
    stderr: new TextDecoder("utf-8", { fatal: true })
  };

  const attach = (
    child: ChildProcess,
    onOverflow: () => void,
    onInvalidUtf8: (kind: "stdout" | "stderr") => void
  ): void => {
    const capture = (kind: "stdout" | "stderr", chunk: Buffer): void => {
      if (overflow) return;
      if (outputBytes + chunk.byteLength > cap) {
        overflow = true;
        onOverflow();
        return;
      }
      let decoded: string;
      try {
        decoded = decoders[kind].decode(chunk, { stream: true });
      } catch {
        overflow = true;
        onInvalidUtf8(kind);
        return;
      }
      outputBytes += chunk.byteLength;
      if (kind === "stdout") stdout.push(decoded);
      else stderr.push(decoded);
    };
    child.stdout!.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => capture("stderr", chunk));
  };

  return { stdout, stderr, attach };
}
