import { expect, test } from "bun:test";
import { createReplay } from "../packages/functions-pbench/src/replay.js";

test("replay rejects unknown runners before creating run state", async () => {
  const replay = createReplay({
    validateCaseBundle: async () => ({ ok: true, errors: [] })
  });

  await expect(
    replay.runCase({
      caseDir: "/missing/case",
      workspaceRoot: "/missing/workspace",
      profile: "current",
      agent: "unknown"
    })
  ).rejects.toThrow('Unknown agent runner "unknown"');
});

test("manual replay delegates case validation through its lifecycle boundary", async () => {
  let validatedCase: string | null = null;
  const replay = createReplay({
    validateCaseBundle: async (caseDir) => {
      validatedCase = caseDir;
      return { ok: false, errors: ["invalid fixture"] };
    }
  });

  await expect(
    replay.startManualRun({
      caseDir: "/cases/bad",
      workspaceRoot: "/workspace",
      profile: "manual"
    })
  ).rejects.toThrow("Invalid pbench case:\ninvalid fixture");
  expect(validatedCase as string | null).toBe("/cases/bad");
});
