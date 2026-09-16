import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RELEASE_WORKFLOWS,
  postPackageReleaseTestCommand,
  readReleaseWorkflow
} from "./helpers/integration-release-workflow.js";

describe("release integration workflow coverage", () => {
  for (const workflowName of RELEASE_WORKFLOWS) {
    test(`${workflowName} runs packaged lane coverage after package:release`, () => {
      const workflow = readReleaseWorkflow(workflowName);
      const packageIndex = workflow.indexOf("bun run package:release");
      const command = postPackageReleaseTestCommand(workflow);
      expect(packageIndex).toBeGreaterThanOrEqual(0);
      expect(command).not.toBeNull();
      expect(command).toContain("tests/computer-lane-release-packaging.test.ts");
      expect(workflow.indexOf(command!)).toBeGreaterThan(packageIndex);
    });
  }

  test("the historical verification pointer delegates mutable current counts", () => {
    const document = readFileSync(resolve("docs/verification/2026-09-14-computer-use-agentic.md"), "utf8");
    const currentSection = document.split("## Historical checkpoint record", 1)[0];
    expect(currentSection).toContain("docs/verification/2026-09-15-parallel-integration.md");
    expect(currentSection).not.toMatch(/default tests PASS \*\*\d+\/\d+/);
    expect(currentSection).not.toMatch(/packaged live lane PASS \*\*\d+\/\d+/);
  });
});
