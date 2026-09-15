// Observe command orchestration: strict parsing happened in args.ts; this
// module resolves the target, runs one observation, and prints the
// schemaVersion-1 envelope. Desktop work goes through the shared session.

import { join } from "node:path";
import {
  bigintSafeReplacer,
  createComputerSession,
  createObservationStore,
  defaultArtifactsDir,
  selectWindow,
  type ComputerSession,
  type ObserveOptions,
  type Target
} from "@ya-skills/computer-runtime";
import { COMMAND_DEADLINE_MS } from "./consts.js";

export interface ObserveCommandRequest {
  pid: number;
  windowId?: bigint;
  mode: "auto" | "ax" | "image" | "both";
  maxDimension?: number;
  selector?: { text: string; match: "exact" | "contains"; role?: string };
  outDir?: string;
}

export function observeCommand(
  deps: { createSession?: (options: { deadlineAt: number; artifactsDir?: string }) => ComputerSession } = {}
): (request: ObserveCommandRequest) => Promise<string> {
  const createSession =
    deps.createSession ??
    ((options: { deadlineAt: number; artifactsDir?: string }) => {
      const artifactsDir = options.artifactsDir ?? defaultArtifactsDir();
      return createComputerSession({
        ...options,
        artifactsDir,
        observationStore: createObservationStore(join(artifactsDir, "observations"))
      });
    });
  return async (request) => {
    const platform = process.platform === "darwin" && process.arch === "arm64";
    if (!platform) {
      throw new Error(
        JSON.stringify({
          error: {
            code: "unsupported_platform",
            message: `computer-use requires macOS arm64 (this machine: ${process.platform} ${process.arch})`
          }
        })
      );
    }
    const session = createSession({
      deadlineAt: Date.now() + COMMAND_DEADLINE_MS,
      // --out-dir overrides where the observation PNG evidence lands.
      ...(request.outDir !== undefined ? { artifactsDir: request.outDir } : {})
    });
    try {
      const win = selectWindow(await session.computer.windows(request.pid), request.windowId);
      const target: Target = { pid: request.pid, windowId: win.windowId };
      const options: ObserveOptions = {
        mode: request.mode,
        ...(request.maxDimension !== undefined ? { maxDimension: request.maxDimension } : {}),
        ...(request.selector !== undefined ? { selector: request.selector } : {})
      };
      const observation = await session.computer.observe(target, options);
      return JSON.stringify(
        { schemaVersion: 1, target, observation },
        bigintSafeReplacer
      );
    } finally {
      try {
        await session.close();
      } catch (error) {
        console.error("driver cleanup issue:", error instanceof Error ? error.message : error);
      }
    }
  };
}
