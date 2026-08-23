import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "./adapters/types.js";
import { asArray, asObject, relativePathFrom } from "./shared.js";

export type ReplayRequirements = {
  profile: "local" | "live-integration";
  network: "none" | "optional" | "required" | "unknown";
  requiredEnv: string[];
  notes: string[];
};

export type AgentVisibleSurface = { label: string; text: string };

export function normalizeReplayRequirements(value: unknown): ReplayRequirements {
  const object = asObject(value) ?? {};
  const profile = object.profile === "live-integration" ? "live-integration" : "local";
  const networkValues = new Set(["none", "optional", "required", "unknown"]);
  const network = typeof object.network === "string" && networkValues.has(object.network)
    ? object.network as ReplayRequirements["network"]
    : "unknown";
  return {
    profile,
    network,
    requiredEnv: Array.isArray(object.requiredEnv)
      ? object.requiredEnv.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    notes: Array.isArray(object.notes)
      ? object.notes.filter((item): item is string => typeof item === "string" && item.length > 0)
      : []
  };
}

export function requiredReplayEnv(manifest: JsonObject): string[] {
  const names = new Set(normalizeReplayRequirements(manifest.replayRequirements).requiredEnv);
  for (const validator of asArray(manifest.validators)) {
    if (!Array.isArray(validator.requiredEnv)) continue;
    for (const name of validator.requiredEnv) {
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function buildPublicCaseManifest(manifest: JsonObject): JsonObject {
  const documents = asObject(manifest.documents) ?? {};
  const publicDocuments = Object.fromEntries(
    Object.entries(documents).filter(([, value]) => typeof value === "string" && value.startsWith("public/"))
  );
  const subjects = asArray(manifest.subjects).map((subject) => {
    const copy = { ...subject };
    delete copy.sourceRootAtCapture;
    return copy;
  });
  return {
    $schema: manifest.$schema,
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    title: manifest.title,
    status: manifest.status,
    privacy: manifest.privacy,
    metadata: manifest.metadata,
    documents: publicDocuments,
    subjects,
    setupCommands: manifest.setupCommands,
    replayRequirements: normalizeReplayRequirements(manifest.replayRequirements)
  };
}

function forbiddenAgentVisibleHits(text: string, forbiddenPaths: string[]): string[] {
  const hits: string[] = [];
  if (/(^|[\s"'`(=:[{])\/private(?:\/[^\s"'`)>\]}]*)?/.test(text)) hits.push("absolute /private path");
  if (/(^|[\s"'`(=:[{])(?:\.\/)?private[\\/][^\s"'`)>\]}]*/.test(text)) hits.push("private evaluator path");
  if (/\bPB_PRIVATE_DIR\b/.test(text)) hits.push("PB_PRIVATE_DIR");
  if (/\bPB_CASE_DIR\b/.test(text)) hits.push("PB_CASE_DIR");
  if (/(^|[\s"'`(=:[{])[\w-]+-session\.jsonl\b/.test(text)) hits.push("raw transcript path");
  for (const path of forbiddenPaths) if (path && text.includes(path)) hits.push("original case directory");
  return [...new Set(hits)];
}

function assertNoAgentVisiblePrivateReferences(
  surfaces: AgentVisibleSurface[],
  forbiddenPaths: string[]
): void {
  const labels = new Set<string>();
  for (const surface of surfaces) {
    const hits = forbiddenAgentVisibleHits(surface.text, forbiddenPaths);
    if (hits.length > 0) labels.add(`${surface.label} (${hits.join(", ")})`);
  }
  if (labels.size > 0) {
    throw new Error(`Agent-visible pbench replay input contains private evaluator path references: ${[...labels].join(", ")}`);
  }
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function assertPublicReplayHasNoPrivateReferences(
  publicDir: string,
  options: { caseDir?: string; extraSurfaces?: AgentVisibleSurface[] } = {}
): Promise<void> {
  const surfaces: AgentVisibleSurface[] = [];
  for (const file of await listFilesRecursively(publicDir)) {
    try {
      surfaces.push({ label: `public/${relativePathFrom(publicDir, file)}`, text: await readFile(file, "utf8") });
    } catch {
      // Ignore non-text public files.
    }
  }
  surfaces.push(...(options.extraSurfaces ?? []));
  assertNoAgentVisiblePrivateReferences(surfaces, options.caseDir ? [options.caseDir] : []);
}
