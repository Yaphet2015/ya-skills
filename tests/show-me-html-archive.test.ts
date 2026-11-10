import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

let catalogDir: string;
beforeEach(async () => { catalogDir = await mkdtemp(join(tmpdir(), "yk-show-me-archive-")); });
afterEach(async () => { await rm(catalogDir, { recursive: true, force: true }); });

async function validateAndBuildReport(skillDir: string, graphFile: string, outputFile: string) {
  for (const [script, args] of [
    ["validate.cjs", [graphFile]],
    ["build-report.cjs", [graphFile, outputFile]]
  ] as const) {
    const proc = Bun.spawn(["node", join(skillDir, "tools", script), ...args], {
      stdout: "pipe", stderr: "pipe"
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
  }
}

test("archived show-me supports an architecture without commits, statistics or a guided tour", async () => {
  const skillDir = resolve("archive", "show-me-html", "show-me");
  const docFile = join(catalogDir, "architecture.json");
  const outFile = join(catalogDir, "report.html");
  await Bun.write(docFile, JSON.stringify({
    schemaVersion: "0.2.0", kind: "graph", title: "请求怎样到达服务", summary: "用户发送请求，服务处理请求。",
    lenses: ["architecture"],
    lanes: [{ id: "client", label: "客户端" }, { id: "server", label: "服务端" }],
    nodes: [
      { id: "page", label: "页面", kind: "ui", delta: "unchanged", lane: "client" },
      { id: "api", label: "服务", kind: "service", delta: "unchanged", lane: "server" }
    ],
    edges: [{ id: "request", from: "page", to: "api", kind: "http", delta: "unchanged", label: "发送请求" }]
  }));
  await validateAndBuildReport(skillDir, docFile, outFile);
  const html = await readFile(outFile, "utf8");
  expect(html).toContain("请求怎样到达服务");
  expect(html).not.toContain("mermaid.initialize");
});

test("archived show-me tools validate and build offline", async () => {
  const skillDir = resolve("archive", "show-me-html", "show-me");
  const example = join(skillDir, "references", "example.graph.json");

  const validate = Bun.spawn(["node", join(skillDir, "tools", "validate.cjs"), example], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [validateOut, , validateCode] = await Promise.all([
    new Response(validate.stdout).text(),
    new Response(validate.stderr).text(),
    validate.exited
  ]);
  expect(validateCode).toBe(0);
  expect(validateOut).toContain("VALID");

  const outDir = await mkdtemp(join(tmpdir(), "yk-show-pr-"));
  const outFile = join(outDir, "report.html");
  const build = Bun.spawn(["node", join(skillDir, "tools", "build-report.cjs"), example, outFile], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [, buildErr, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited
  ]);
  expect(buildErr).toBe("");
  expect(buildCode).toBe(0);
  const html = await readFile(outFile, "utf8");
  expect(html).toContain("<!doctype html>");
  await rm(outDir, { recursive: true, force: true });
});

async function buildExampleClone(mutate?: (doc: Record<string, unknown>) => void) {
  const skillDir = resolve("archive", "show-me-html", "show-me");
  const example = join(skillDir, "references", "example.graph.json");
  const doc = JSON.parse(await readFile(example, "utf8"));
  if (mutate) mutate(doc);
  const outDir = await mkdtemp(join(tmpdir(), "yk-show-pr-clone-"));
  const docFile = join(outDir, "doc.json");
  // evidence paths resolve relative to the document, so copy the real file next to it
  const evidenceDir = join(outDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  await Bun.write(
    join(evidenceDir, "batch-result.png"),
    Bun.file(join(skillDir, "references", "evidence", "batch-result.png"))
  );
  await Bun.write(docFile, JSON.stringify(doc));
  const outFile = join(outDir, "report.html");
  const build = Bun.spawn(["node", join(skillDir, "tools", "build-report.cjs"), docFile, outFile], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [, buildErr, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited
  ]);
  const html = await readFile(outFile, "utf8");
  return { outDir, outFile, docFile, html, buildErr, buildCode };
}

test('archived show-me reports are readable and explorable before scripts run', async () => {
  const { html, outDir, docFile } = await buildExampleClone();
  try {
    const source = JSON.parse(await readFile(docFile, 'utf8'));
    const headings: string[] = [];
    const summaries: string[] = [];
    const sources: string[] = [];
    const mermaid: string[] = [];
    const images: string[] = [];
    let diagrams = 0;
    let selectedViews = 0;
    let closedSections = 0;
    const reader = new HTMLRewriter()
      .on('h1', {
        text(chunk) {
          headings.push(chunk.text);
        },
      })
      .on('header .summary', {
        text(chunk) {
          summaries.push(chunk.text);
        },
      })
      .on('svg[role=img]', {
        element() {
          diagrams++;
        },
      })
      .on('.mermaid', {
        text(chunk) {
          mermaid.push(chunk.text);
        },
      })
      .on('img', {
        element(el) {
          images.push(el.getAttribute('src') || '');
        },
      })
      .on('input[type=radio][checked]', {
        element() {
          selectedViews++;
        },
      })
      .on('details.report-section', {
        element(el) {
          expect(el.hasAttribute('open')).toBe(false);
          closedSections++;
        },
      })
      .on('details code', {
        text(chunk) {
          sources.push(chunk.text);
        },
      });
    await reader.transform(new Response(html)).text();
    expect(headings.join('')).toContain('批量发送广播');
    expect(summaries.join('')).toBe(source.summary);
    expect(diagrams).toBeGreaterThan(0);
    expect(selectedViews).toBe(1);
    expect(closedSections).toBeGreaterThan(0);
    expect(sources.join('')).toContain('sendBroadcastBulk.ts');
    expect(mermaid.join('')).toContain('stateDiagram-v2');
    expect(images.some((source) => source.startsWith('data:image/png;base64,'))).toBe(true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('archived show-me refuses a host size limit without replacing an existing report', async () => {
  const { outDir, outFile, docFile } = await buildExampleClone();
  try {
    await Bun.write(outFile, 'previous report');
    const proc = Bun.spawn(
      [
        'node',
        resolve('archive/show-me-html/show-me/tools/build-report.cjs'),
        docFile,
        outFile,
        '--max-bytes',
        '1024',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain('size limit');
    expect(await Bun.file(outFile).text()).toBe('previous report');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("archived show-me tools fail loudly without explicit paths", async () => {
  const skillDir = resolve("archive", "show-me-html", "show-me");
  const run = async (script: string, ...args: string[]) => {
    const proc = Bun.spawn(["node", join(skillDir, "tools", script), ...args], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return { err, code };
  };

  // Agent always passes argv (SKILL.md); missing args must not fall back to a default path
  const validate = await run("validate.cjs");
  expect(validate.code).toBe(1);
  expect(validate.err).toContain("usage");

  const buildNone = await run("build-report.cjs");
  expect(buildNone.code).toBe(1);
  expect(buildNone.err).toContain("usage");

  const buildGraphOnly = await run(
    "build-report.cjs",
    join(skillDir, "references", "example.graph.json")
  );
  expect(buildGraphOnly.code).toBe(1);
  expect(buildGraphOnly.err).toContain("usage");
});

test("archived show-me report omits the mermaid bundle when the document has no mermaid", async () => {
  const { html, buildCode, outDir } = await buildExampleClone((doc) => {
    doc.mermaid = [];
  });

  expect(buildCode).toBe(0);
  expect(html).toContain("<!doctype html>");
  expect(html).not.toContain("mermaid.initialize");
  await rm(outDir, { recursive: true, force: true });
});

test("archived show-me validator rejects missing evidence files and unlisted design choices", async () => {
  const skillDir = resolve("archive", "show-me-html", "show-me");
  const example = JSON.parse(await readFile(join(skillDir, "references", "example.graph.json"), "utf8"));
  const outDir = await mkdtemp(join(tmpdir(), "yk-show-pr-bad-"));
  const docFile = join(outDir, "doc.json");

  const runValidate = async () => {
    const proc = Bun.spawn(["node", join(skillDir, "tools", "validate.cjs"), docFile], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [out, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return { out, errText, code };
  };

  example.evidence[0].path = "evidence/does-not-exist.png";
  await Bun.write(docFile, JSON.stringify(example));
  let result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("evidence");

  example.evidence[0].path = "evidence/batch-result.png";
  example.design[0].chosen = "不存在的选项";
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("chosen");

  example.design[0].chosen = example.design[0].options[0].label;
  example.repro[0].result = "x".repeat(501);
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("result");

  example.repro[0].result = "自动化覆盖：3 项通过";
  example.repro[3].steps = "not-an-array";
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("steps");

  example.repro[3].steps = ["pnpm dev 启动应用"];
  example.repro[3].expected = "";
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("expected");

  example.repro[3].expected = "POST /email/batch 恰为 4 次，且无任何单封请求。";
  example.repro[0].manual = "yes";
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("manual");

  example.repro[0].manual = undefined;
  example.testSteps[0].steps = [];
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("steps");

  await rm(outDir, { recursive: true, force: true });
});
