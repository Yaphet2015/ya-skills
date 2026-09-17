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

  test("the local publish path owns the release: release.yml skips itself when the asset already exists", () => {
    const workflow = readReleaseWorkflow("release.yml");
    const guardIndex = workflow.indexOf("Skip if the release already has the local asset");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    // Every build and publish gate runs only when the guard did not see a
    // locally published asset; otherwise CI would rebuild over local bits.
    expect(workflow).toContain("steps.guard.outputs.skip != 'true'");
    for (const gate of ["Check out repository", "bun run typecheck", "Publish release"]) {
      expect(workflow.indexOf(gate)).toBeGreaterThan(guardIndex);
    }
  });

  test("CI never overwrites published assets (first uploader wins, no clobber)", () => {
    for (const workflowName of RELEASE_WORKFLOWS) {
      const workflow = readReleaseWorkflow(workflowName);
      expect(workflow).not.toContain("--clobber");
      // Both publish paths must check the asset list before uploading and keep
      // whatever already shipped.
      expect(workflow).toContain("--json assets");
      expect(workflow).toContain("already published");
    }
  });

  test("the tap hashes the asset that actually shipped, not this runner's rebuild", () => {
    const workflow = readReleaseWorkflow("release-please.yml");
    const keepIndex = workflow.indexOf("already published");
    expect(keepIndex).toBeGreaterThanOrEqual(0);
    expect(workflow.indexOf("gh release download")).toBeGreaterThan(keepIndex);
    expect(workflow).toContain("asset_sha256: ${{ steps.upload.outputs.asset_sha256 }}");
  });

  test("the historical verification pointer delegates mutable current counts", () => {
    const document = readFileSync(resolve("docs/verification/2026-09-14-computer-use-agentic.md"), "utf8");
    const currentSection = document.split("## Historical checkpoint record", 1)[0];
    expect(currentSection).toContain("2026-09-16-takeover.md");
    expect(currentSection).not.toMatch(/default tests PASS \*\*\d+\/\d+/);
    expect(currentSection).not.toMatch(/packaged live lane PASS \*\*\d+\/\d+/);
  });
});
