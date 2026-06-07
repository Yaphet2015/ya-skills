import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FunctionRef, SkillCatalog, SkillManifest } from "./types.js";

type JsonObject = Record<string, unknown>;

export async function loadCatalog(catalogDir: string): Promise<SkillCatalog> {
  const entries = await readdir(catalogDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const skills = [];
  for (const dirName of dirs) {
    const dir = join(catalogDir, dirName);
    const manifestPath = join(dir, "skill.json");
    await assertFile(manifestPath);
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")), dirName);
    skills.push({ ...manifest, dir });
  }

  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  if (byName.size !== skills.length) {
    throw new Error("Skill catalog contains duplicate skill names");
  }

  return { skills, byName };
}

function parseManifest(value: unknown, dirName: string): SkillManifest {
  if (!isObject(value)) {
    throw new Error(`${dirName}/skill.json must contain an object`);
  }

  const name = requireString(value, "name", dirName);
  if (name !== dirName) {
    throw new Error(`skill.json name '${name}' must match directory '${dirName}'`);
  }

  return {
    name,
    description: requireString(value, "description", dirName),
    dependsOn: optionalStringArray(value, "dependsOn", dirName),
    functions: optionalFunctionRefs(value, dirName)
  };
}

async function assertFile(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`${path} must be a file`);
  }
}

function requireString(value: JsonObject, key: string, dirName: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`${dirName}/skill.json field '${key}' must be a non-empty string`);
  }
  return field;
}

function optionalStringArray(value: JsonObject, key: string, dirName: string): string[] {
  const field = value[key];
  if (field === undefined) {
    return [];
  }
  if (!Array.isArray(field) || field.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${dirName}/skill.json field '${key}' must be an array of non-empty strings`);
  }
  return field;
}

function optionalFunctionRefs(value: JsonObject, dirName: string): FunctionRef[] {
  const field = value.functions;
  if (field === undefined) {
    return [];
  }
  if (!Array.isArray(field)) {
    throw new Error(`${dirName}/skill.json field 'functions' must be an array`);
  }

  return field.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`${dirName}/skill.json functions[${index}] must be an object`);
    }
    return {
      domain: requireString(item, "domain", dirName),
      action: requireString(item, "action", dirName)
    };
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
