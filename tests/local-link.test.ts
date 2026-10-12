import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanLocal, linkLocal, selectLinkPath } from "../scripts/local-link.js";

let temporary: string;
let root: string;
let prefix: string;
let link: string;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "yk-local-link-"));
  root = join(temporary, "checkout with 'quote'");
  prefix = join(temporary, "prefix");
  link = join(prefix, "bin/yk");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
});
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

function buildFixture(root: string, version: string): void {
  const release = join(root, "dist/release/ya-skills");
  mkdirSync(join(release, "skills"), { recursive: true });
  writeFileSync(join(release, "yk"), '#!/bin/sh\nprintf "%s\\n" "$YA_SKILLS_CATALOG_DIR" "$@"\n');
  chmodSync(join(release, "yk"), 0o755);
  writeFileSync(join(root, "dist/yk"), "compiled");
  const archive = join(root, `ya-skills-v${version}-macos-arm64.tar.gz`);
  writeFileSync(archive, "archive");
  writeFileSync(`${archive}.sha256`, "checksum");
}

test("local link runs from another cwd, preserves arguments/env, and restores Homebrew link", () => {
  symlinkSync("../Cellar/ya-skills/0.27.1/bin/yk", link);
  linkLocal(root, link, buildFixture);
  const result = Bun.spawnSync([link, "install", "a skill"], { cwd: temporary, env: { PATH: process.env.PATH, YA_SKILLS_CATALOG_DIR: "" } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim().split("\n")).toEqual([join(root, "dist/release/ya-skills/skills"), "install", "a skill"]);
  const override = Bun.spawnSync([link, "list"], { env: { YA_SKILLS_CATALOG_DIR: "/explicit/catalog" } });
  expect(override.stdout.toString()).toStartWith("/explicit/catalog\n");
  linkLocal(root, link, buildFixture);
  cleanLocal(root);
  expect(readlinkSync(link)).toBe("../Cellar/ya-skills/0.27.1/bin/yk");
  expect(existsSync(join(root, "dist/local"))).toBe(false);
  expect(existsSync(join(root, "dist/release/ya-skills"))).toBe(false);
  expect(existsSync(join(root, "ya-skills-v1.2.3-macos-arm64.tar.gz"))).toBe(false);
  cleanLocal(root);
  expect(readlinkSync(link)).toBe("../Cellar/ya-skills/0.27.1/bin/yk");
});

test("clean removes a new global link and leaves unrelated artifacts", () => {
  linkLocal(root, link, buildFixture);
  writeFileSync(join(root, "dist/keep"), "unrelated");
  cleanLocal(root);
  expect(existsSync(link)).toBe(false);
  expect(readFileSync(join(root, "dist/keep"), "utf8")).toBe("unrelated");
});

test("build failure leaves the previous link usable and partial artifacts cleanable", () => {
  symlinkSync("../previous/yk", link);
  expect(() => linkLocal(root, link, (root, version) => {
    buildFixture(root, version);
    throw new Error("build failed");
  })).toThrow("build failed");
  expect(readlinkSync(link)).toBe("../previous/yk");
  cleanLocal(root);
  expect(readlinkSync(link)).toBe("../previous/yk");
  expect(existsSync(join(root, "dist/yk"))).toBe(false);
});

test("regular files and newer global installations are never overwritten", () => {
  writeFileSync(link, "user command");
  expect(() => linkLocal(root, link, buildFixture)).toThrow("not a symlink");
  expect(readFileSync(link, "utf8")).toBe("user command");
  rmSync(link);
  linkLocal(root, link, buildFixture);
  rmSync(link);
  symlinkSync("../newer/yk", link);
  cleanLocal(root);
  expect(readlinkSync(link)).toBe("../newer/yk");
});

test("rebuild across versions cleans each generated archive", () => {
  linkLocal(root, link, buildFixture);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.4" }));
  linkLocal(root, link, buildFixture);
  cleanLocal(root);
  for (const version of ["1.2.3", "1.2.4"]) {
    expect(existsSync(join(root, `ya-skills-v${version}-macos-arm64.tar.gz.sha256`))).toBe(false);
  }
});

test("link updates the yk that wins PATH when npm's prefix is shadowed", () => {
  const brew = join(temporary, "homebrew");
  const brewBin = join(brew, "bin");
  mkdirSync(brewBin, { recursive: true });
  const oldYk = join(brew, "old-yk");
  writeFileSync(oldYk, '#!/bin/sh\necho old-catalog\n');
  chmodSync(oldYk, 0o755);
  symlinkSync(oldYk, join(brewBin, "yk"));
  // An earlier dev:link used npm's prefix, which loses to Homebrew in PATH.
  linkLocal(root, link, buildFixture);
  const npmBin = join(root, "node_modules/.bin");
  mkdirSync(npmBin, { recursive: true });
  symlinkSync(oldYk, join(npmBin, "yk"));
  const shellPath = `${brewBin}:${join(prefix, "bin")}:/usr/bin:/bin`;
  const selected = selectLinkPath(prefix, `${npmBin}:${shellPath}`);
  linkLocal(root, selected, buildFixture);
  const result = Bun.spawnSync(["/bin/sh", "-c", "yk list"], { env: { PATH: shellPath } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toStartWith(join(root, "dist/release/ya-skills/skills"));
  expect(existsSync(link)).toBe(false);
  cleanLocal(root);
  expect(readlinkSync(join(brewBin, "yk"))).toBe(oldYk);
});

test("explicit prefix overrides PATH and missing yk falls back to npm prefix", () => {
  expect(selectLinkPath(prefix, "/nonexistent")).toBe(link);
  expect(selectLinkPath(prefix, process.env.PATH ?? "", prefix)).toBe(link);
});
