import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const compilerPath = join(import.meta.dir, "../skills/svg-icons/compiler.mjs");

function baseIcon(shapes: unknown[]) {
  return {
    name: "bar",
    title: "Bar",
    categories: ["shapes"],
    keywords: ["line"],
    shapes
  };
}

test("compileToSvg draws a 24-grid line with the family stroke", async () => {
  const { compileToSvg } = await import(compilerPath);
  const svg = compileToSvg(baseIcon([{ line: [4, 12, 20, 12] }]));
  expect(svg).toContain('viewBox="0 0 24 24"');
  expect(svg).toContain('stroke-width="2"');
  expect(svg).toContain('stroke-linecap="round"');
  expect(svg).toContain('stroke="currentColor"');
  expect(svg).toContain('d="M4 12L20 12"');
});

test("compileToSvg rejects a third ink", async () => {
  const { compileToSvg } = await import(compilerPath);
  expect(() =>
    compileToSvg(
      baseIcon([
        { line: [4, 8, 20, 8], ink: 1 },
        { line: [4, 12, 20, 12], ink: 2 },
        { line: [4, 16, 20, 16], ink: 3 }
      ])
    )
  ).toThrow(/ink/);
});

test("compileToSvg splits two inks onto separate colored paths", async () => {
  const { compileToSvg } = await import(compilerPath);
  const svg = compileToSvg(
    baseIcon([
      { line: [4, 8, 20, 8], ink: 1 },
      { line: [4, 16, 20, 16], ink: 2 }
    ]),
    { ink1: "#111111", ink2: "#2563eb" }
  );
  expect(svg).toContain('stroke="#111111"');
  expect(svg).toContain('stroke="#2563eb"');
  expect(svg).toContain('d="M4 8L20 8"');
  expect(svg).toContain('d="M4 16L20 16"');
});

test("compileToSvg paints a used glyph with ink 2", async () => {
  const { compileToSvg } = await import(compilerPath);
  const svg = compileToSvg(
    {
      name: "folder-pencil",
      title: "Folder pencil",
      categories: ["content"],
      keywords: ["folder", "edit"],
      shapes: [
        { use: "mark" },
        { use: "mark", scale: 0.5, offset: [6, 6], ink: 2 }
      ]
    },
    {
      library: [
        {
          name: "mark",
          title: "Mark",
          categories: ["shapes"],
          keywords: ["line"],
          shapes: [{ line: [4, 12, 20, 12] }]
        }
      ],
      ink2: "#2563eb"
    }
  );
  expect(svg).toContain('stroke="#2563eb"');
  expect(svg).toMatch(/d="M4 12L20 12"/);
});

test("compileToSvg rejects points outside the safe area", async () => {
  const { compileToSvg } = await import(compilerPath);
  expect(() => compileToSvg(baseIcon([{ line: [0, 12, 20, 12] }]))).toThrow(/safe area/);
});

test("compiler source does not mention regen-icons", async () => {
  const source = await readFile(compilerPath, "utf8");
  expect(source.toLowerCase()).not.toContain("regen-icons");
  expect(source.toLowerCase()).not.toContain("kazdenc");
});

test("vendored library includes 225 drawings and compiles folder", async () => {
  const srcDir = join(import.meta.dir, "../skills/svg-icons/src");
  const { loadLibrary, compileToSvg } = await import(compilerPath);
  const library = loadLibrary(srcDir);
  expect(library).toHaveLength(225);
  const folder = library.find((icon: { name: string }) => icon.name === "folder");
  expect(folder).toBeDefined();
  const svg = compileToSvg(folder, { library });
  expect(svg).toContain('viewBox="0 0 24 24"');
  expect(svg).toContain("M5 5");
});

test("cli --emit writes svg using the skill library directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svg-icons-"));
  const libraryDir = join(dir, "src");
  await mkdir(libraryDir);
  await writeFile(
    join(libraryDir, "mark.icon.json"),
    JSON.stringify({
      name: "mark",
      title: "Mark",
      categories: ["shapes"],
      keywords: ["line"],
      shapes: [{ line: [4, 12, 20, 12] }]
    })
  );
  const iconPath = join(dir, "folder-pencil.icon.json");
  const outPath = join(dir, "folder-pencil.svg");
  await writeFile(
    iconPath,
    JSON.stringify({
      name: "folder-pencil",
      title: "Folder pencil",
      categories: ["content"],
      keywords: ["folder", "edit"],
      shapes: [
        { use: "mark" },
        { use: "mark", scale: 0.5, offset: [6, 6], ink: 2 }
      ]
    })
  );
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      compilerPath,
      "--emit",
      iconPath,
      "-o",
      outPath,
      "--library",
      libraryDir,
      "--ink2",
      "#2563eb"
    ],
    cwd: dirname(fileURLToPath(import.meta.url))
  });
  expect(result.exitCode).toBe(0);
  const svg = await readFile(outPath, "utf8");
  expect(svg).toContain('stroke="#2563eb"');
});
