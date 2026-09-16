import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const RELEASE_WORKFLOWS = ["release.yml", "release-please.yml"] as const;

export function readReleaseWorkflow(name: (typeof RELEASE_WORKFLOWS)[number]): string {
  return readFileSync(resolve(".github/workflows", name), "utf8");
}

/** Return the single post-package release-test command from a workflow. */
export function postPackageReleaseTestCommand(workflow: string): string | null {
  const line = workflow
    .split("\n")
    .find((candidate) => candidate.includes("YK_RELEASE_TESTS=1 bun test"));
  return line?.trim() ?? null;
}
