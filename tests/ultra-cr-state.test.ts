import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("skills/ultra-cr/scripts/review_state.py");

type Command = (...args: string[]) => { code: number; output: string; error: string };

async function fixture(
  run: (root: string, command: Command) => Promise<void>,
  snapshot: Record<string, unknown> = { head: "abc", base: "def", options: {} },
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ultra-cr-state-"));
  function command(...args: string[]): ReturnType<Command> {
    const result = Bun.spawnSync(["python3", script, ...args, "--session", root]);
    return {
      code: result.exitCode,
      output: result.stdout.toString(),
      error: result.stderr.toString(),
    };
  }
  try {
    await writeFile(join(root, "snapshot.json"), JSON.stringify(snapshot));
    expect(command("init", "--snapshot", join(root, "snapshot.json")).code).toBe(0);
    await run(root, command);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const reviewer = { id: "principal-1", risk: "behavior", paths: ["src/load.ts"], checks: ["cancellation"] };
const finding = {
  id: "F1", category: "bug", severity: "blocker", status: "CONFIRMED",
  location: "src/load.ts:12", trigger: "cancel during load", impact: "writes stale state", evidence: ["load.ts:12-18"],
};

test("review checkpoints validate artifacts and recover from a lost reviewer report", async () => {
  await fixture(async (root, command) => {
    await writeFile(join(root, "reviewers.json"), JSON.stringify([reviewer]));
    expect(command("plan", "--kind", "reviewers", "--input", join(root, "reviewers.json")).code).toBe(0);
    const paths = JSON.parse(command("paths").output);
    const report = paths["4"][0];
    expect(command("complete", "--phase", "4").code).toBe(1);
    await writeFile(report, "## Summary\n无发现。\n");
    expect(command("complete", "--phase", "4").code).toBe(0);
    expect(JSON.parse(command("status").output).phases["4"]).toBe("DONE");
    await rm(report);
    expect(JSON.parse(command("status").output).phases["4"]).toBe("NOT_STARTED");
    expect(await readFile(join(root, "PROGRESS.md"), "utf8")).toContain("NOT_STARTED");
  });
});

test("batch validation preserves each finding and rejects missing or duplicate verdicts", async () => {
  await fixture(async (root, command) => {
    const candidates = [finding, { ...finding, id: "F2", severity: "high" }];
    const paths = JSON.parse(command("paths").output);
    await writeFile(paths["5"][0], JSON.stringify(candidates));
    await writeFile(join(root, "batches.json"), JSON.stringify([{ id: "batch-1", finding_ids: ["F1", "F2"] }]));
    expect(command("plan", "--kind", "batches", "--input", join(root, "batches.json")).code).toBe(0);
    const updated = JSON.parse(command("paths").output);
    const batch = updated["5.5"].find((path: string) => path.endsWith("batch-1.json"));
    await writeFile(updated["5.5"][0], "# 验证汇总\n两条发现。\n");
    const first = { id: "F1", verdict: "CONFIRMED", evidence: ["src/load.ts:12"] };
    await writeFile(batch, JSON.stringify([first]));
    expect(command("complete", "--phase", "5.5").code).toBe(1);
    await writeFile(batch, JSON.stringify([first, first]));
    expect(command("complete", "--phase", "5.5").code).toBe(1);
    await writeFile(batch, JSON.stringify([first, { id: "F2", verdict: "UNVERIFIED", evidence: [], reason: "调用方契约未知" }]));
    expect(command("complete", "--phase", "5.5").code).toBe(0);
  });
});

test("final verdict needs independent blocker evidence and cannot clear unresolved findings", async () => {
  await fixture(async (root, command) => {
    const paths = JSON.parse(command("paths").output);
    await writeFile(paths["5"][0], JSON.stringify([finding]));
    await writeFile(paths["7"][0], "# 审查结果\n存在待验证问题。\n");
    await writeFile(paths["7"][1], JSON.stringify({ verdict: "REQUEST_CHANGES", finding_ids: ["F1"], unverified_ids: [] }));
    expect(command("complete", "--phase", "7").code).toBe(1);
    await writeFile(paths["7"][1], JSON.stringify({ verdict: "NO_FINDINGS", finding_ids: [], unverified_ids: [] }));
    expect(command("complete", "--phase", "7").code).toBe(1);
    await writeFile(paths["7"][1], JSON.stringify({ verdict: "INCOMPLETE", finding_ids: [], unverified_ids: ["F1"] }));
    expect(command("complete", "--phase", "7").code).toBe(0);
    await writeFile(join(root, "batches.json"), JSON.stringify([{ id: "batch-1", finding_ids: ["F1"] }]));
    expect(command("plan", "--kind", "batches", "--input", join(root, "batches.json")).code).toBe(1);
  });
});

test("session identity and canonical paths prevent overwriting another snapshot or escaping the session", async () => {
  await fixture(async (root, command) => {
    await writeFile(join(root, "other.json"), JSON.stringify({ head: "changed", base: "def", options: {} }));
    expect(command("init", "--snapshot", join(root, "other.json")).code).toBe(1);
    await writeFile(join(root, "reviewers.json"), JSON.stringify([{ ...reviewer, id: "../../outside" }]));
    expect(command("plan", "--kind", "reviewers", "--input", join(root, "reviewers.json")).code).toBe(1);
  });
});

test("confirmed blockers and false alarms produce a consistent final decision from batch evidence", async () => {
  await fixture(async (root, command) => {
    await writeFile(join(root, "reviewers.json"), JSON.stringify([reviewer]));
    expect(command("plan", "--kind", "reviewers", "--input", join(root, "reviewers.json")).code).toBe(0);
    let paths = JSON.parse(command("paths").output);
    await writeFile(paths["1"][0], "# 项目规则\n已核对。\n");
    await writeFile(paths["2"][0], "# 审查上下文\n已核对。\n");
    await writeFile(paths["4"][0], "## Summary\n发现两个候选问题。\n");
    await writeFile(paths["5"][0], JSON.stringify([
      { ...finding, status: "UNVERIFIED" },
      { ...finding, id: "F2", severity: "high", status: "UNVERIFIED" },
      { id: "F3", category: "style", severity: "low", status: "EXCLUDED", location: "src/load.ts:8", reason: "命名偏好" },
    ]));
    await writeFile(join(root, "batches.json"), JSON.stringify([{ id: "batch-1", finding_ids: ["F1", "F2"] }]));
    expect(command("plan", "--kind", "batches", "--input", join(root, "batches.json")).code).toBe(0);
    paths = JSON.parse(command("paths").output);
    await writeFile(paths["5.5"][0], "# 验证汇总\n一条确认，一条误报。\n");
    await writeFile(paths["5.5"][1], JSON.stringify([
      { id: "F1", verdict: "CONFIRMED", evidence: ["src/load.ts:12-18"] },
      { id: "F2", verdict: "FALSE_ALARM", evidence: ["src/state.ts:20 已存在保护"] },
    ]));
    await writeFile(paths["7"][0], "# 审查结果\nF1 已确认，要求修改。\n");
    await writeFile(paths["7"][1], JSON.stringify({ verdict: "REQUEST_CHANGES", finding_ids: ["F1"], unverified_ids: [] }));
    for (const phase of ["1", "2", "3", "4", "5", "5.5", "7", "8"]) {
      const result = command("complete", "--phase", phase);
      expect(result.error).toBe("");
      expect(result.code).toBe(0);
    }
    expect(Object.values(JSON.parse(command("status").output).phases).every(value => value === "DONE")).toBe(true);
    await writeFile(paths["5.5"][1], JSON.stringify([
      { id: "F1", verdict: "REFINED", severity: "medium", description: "范围有限的状态错误", evidence: ["src/load.ts:12-18"] },
      { id: "F2", verdict: "FALSE_ALARM", evidence: ["src/state.ts:20 已存在保护"] },
    ]));
    expect(command("complete", "--phase", "7").code).toBe(1);
    await writeFile(paths["7"][1], JSON.stringify({ verdict: "FINDINGS", finding_ids: ["F1"], unverified_ids: [] }));
    expect(command("complete", "--phase", "7").code).toBe(0);
  });
});

test("an explicitly empty comparison can finish without fabricating reviewer work", async () => {
  await fixture(async (root, command) => {
    const paths = JSON.parse(command("paths").output);
    await writeFile(paths["1"][0], "# 项目规则\n无新增变更。\n");
    await writeFile(paths["2"][0], "# 审查上下文\n已确认比较结果为空。\n");
    await writeFile(paths["5"][0], "[]");
    await writeFile(paths["5.5"][0], "# 验证汇总\n没有候选问题。\n");
    await writeFile(paths["7"][0], "# 审查结果\n审查范围没有变更。\n");
    await writeFile(paths["7"][1], JSON.stringify({ verdict: "NO_FINDINGS", finding_ids: [], unverified_ids: [] }));
    for (const phase of ["1", "2", "3", "4", "5", "5.5", "7", "8"]) {
      expect(command("complete", "--phase", phase).code).toBe(0);
    }
  }, { head: "same", base: "same", empty_diff: true, options: {} });
});
