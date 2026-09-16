import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IntegrationBurstFixture {
  root: string;
  suiteFile: string;
  outDir: string;
  cleanup(): void;
}

/**
 * Build a desktop-free consumer suite whose final afterAll hook emits a large
 * event burst immediately before the worker exits. The event names are
 * unique, so the SSOT reducer can prove that no tail was dropped.
 */
export function createIntegrationBurstFixture(options: {
  cleanupSteps: number;
  namePadding: number;
}): IntegrationBurstFixture {
  if (!Number.isSafeInteger(options.cleanupSteps) || options.cleanupSteps < 1) {
    throw new Error("cleanupSteps must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.namePadding) || options.namePadding < 0) {
    throw new Error("namePadding must be a non-negative safe integer");
  }
  const root = mkdtempSync(join(tmpdir(), "yk-integration-e2e-burst-"));
  const suiteFile = join(root, "burst.e2e.ts");
  const outDir = join(root, "runs");
  const padding = "x".repeat(options.namePadding);
  writeFileSync(
    suiteFile,
    `export default {
  apiVersion: 1,
  id: "integration-burst",
  name: "integration burst",
  tests: [{
    id: "terminal-case",
    name: "terminal case",
    async run(context) {
      await context.step("case-body", async () => {});
    }
  }],
  afterAll(context) {
    for (let i = 0; i < ${options.cleanupSteps}; i += 1) {
      void context.step("cleanup-${padding}-" + i, async () => {});
    }
    return context.step("cleanup-terminal-${padding}", async () => {});
  }
};
`,
    { mode: 0o600 }
  );
  return {
    root,
    suiteFile,
    outDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
