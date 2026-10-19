import { join } from "node:path";
import { sessionPaths, sessionRoot } from "@ya-skills/computer-session";
import { createObservationStore, defaultArtifactsDir, zoomObservation } from "@ya-skills/computer-runtime";
import type { ParsedRequest } from "./args.js";
import { COMMAND_DEADLINE_MS } from "./consts.js";
import { stringifyJson } from "./output.js";

/** Resolve local evidence directly. Session sockets and native drivers are unnecessary. */
export async function zoomCommand(request: Extract<ParsedRequest, { kind: "zoom" }>): Promise<string> {
  const sessionDir = request.session === undefined ? undefined : sessionPaths(sessionRoot(), request.session).directory;
  const artifactsDir = sessionDir === undefined ? request.outDir ?? defaultArtifactsDir() : join(sessionDir, "artifacts");
  const store = createObservationStore(join(sessionDir ?? artifactsDir, "observations"));
  const zoom = await zoomObservation(store, request.observationId, request.region, {
    outDir: request.outDir ?? artifactsDir,
    maxDimension: request.maxDimension,
    maxPixels: request.maxPixels,
    deadlineAt: Date.now() + COMMAND_DEADLINE_MS
  });
  return stringifyJson({ schemaVersion: 1, zoom });
}
