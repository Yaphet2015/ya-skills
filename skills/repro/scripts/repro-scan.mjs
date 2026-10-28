#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const usage = "Usage: repro-scan.mjs --base <target-ref-or-sha> [--repo <path>]";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
}

function scan() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      repo: { type: "string", default: process.cwd() },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: false
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!values.base || values.base.startsWith("-")) {
    throw new Error(`An explicit comparison base is required. ${usage}`);
  }

  const root = git(values.repo, "rev-parse", "--show-toplevel").trimEnd();
  const head = git(root, "rev-parse", "--verify", "HEAD^{commit}").trim();
  const baseCommit = git(root, "rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`).trim();
  const mergeBases = git(root, "merge-base", "--all", baseCommit, head).trim().split("\n");
  if (mergeBases.length !== 1) {
    throw new Error("Multiple merge bases; select an explicit comparison scope before generating the sheet.");
  }
  const mergeBase = mergeBases[0];
  const branchName = git(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
  const files = new Map();

  function add(path, layer, status) {
    if (!files.has(path)) files.set(path, { path, changes: [] });
    files.get(path).changes.push({ layer, status });
  }

  function diff(layer, ...revisions) {
    const fields = git(root, "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--ignore-submodules=none", "--name-status", "-z", ...revisions, "--").split("\0");
    fields.pop();
    for (let index = 0; index < fields.length; index += 2) {
      add(fields[index + 1], layer, fields[index]);
    }
  }

  diff("committed", mergeBase, head);
  diff("staged", "--cached", head);
  diff("unstaged");
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0");
  for (const path of untracked) {
    if (path) add(path, "untracked", "?");
  }

  process.stdout.write(`${JSON.stringify({
    root,
    branch: branchName === "HEAD" ? null : branchName,
    head,
    baseRef: values.base,
    baseCommit,
    mergeBase,
    files: [...files.keys()].sort().map((path) => files.get(path))
  }, null, 2)}\n`);
}

try {
  scan();
} catch (error) {
  const detail = error.stderr?.toString().trim() || error.message;
  process.stderr.write(`repro-scan: ${detail}\n`);
  process.exitCode = 1;
}
