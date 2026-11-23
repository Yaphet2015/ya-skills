import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { CaptureOptions, CaptureResult } from "./authoring.js";
import type { JsonObject } from "./adapters/types.js";
import { dockerHarborRuntime, fileDigest, HARBOR_VERSION, type HarborRuntime, type HarborTrial, type Image } from "./harbor-runtime.js";
import { asArray, asObject, normalizeRunProfile, pathExists, readJson, writeJson } from "./shared.js";
import { assertNoAgentVisiblePrivateReferences } from "./replay-boundary.js";

const exec = promisify(execFile);
const taskFolder = "harbor";
const pending = "# PBENCH_AUTHORING_REQUIRED";
const nodeImage = "node:22.22.0-bookworm-slim";
const archiveName = "images.tar";

type CaptureHarborOptions = CaptureOptions & { task?: string; baselineOnly?: boolean };
type CaseLocation = { caseDir: string; workspaceRoot: string };
type Snapshot = { revision: string; directory: string; images: [Image, Image]; archiveDigest: string };
type SampleResult = { sample: string; expected: number; reward: number | null; valid: boolean; error: string | null };
export type HarborRun = HarborTrial & {
  schemaVersion: 2;
  caseId: string;
  revision: string;
  profile: string;
  agent: string;
  model: string;
  requestedModel?: string;
  envNames: string[];
  skill?: string;
  verifierStatus?: string;
};

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

function gitSubject(manifest: JsonObject, workspaceRoot: string) {
  const subject = asArray(manifest.subjects)[0];
  const commit = asObject(subject?.baseline)?.commit;
  const repoId = subject?.repoId;
  if (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/.test(commit) ||
      typeof repoId !== "string" || !/^repo_[a-f0-9]+$/.test(repoId)) {
    throw new Error("The case does not have a valid Git baseline.");
  }
  return {
    commit,
    cache: join(workspaceRoot, "repos", `${repoId}.git`),
    source: typeof subject.sourceRootAtCapture === "string" ? subject.sourceRootAtCapture : null
  };
}

async function exportGitBaseline(location: CaseLocation, manifest: JsonObject, destination: string): Promise<void> {
  const subject = gitSubject(manifest, location.workspaceRoot);
  await mkdir(destination, { recursive: true });
  await git(["-C", destination, "init", "--template="]);
  await git(["-C", destination, "fetch", "--depth=1", "--no-tags", pathToFileURL(subject.cache).href, subject.commit]);
  await git(["-C", destination, "checkout", "--detach", subject.commit]);
  await rm(join(destination, ".git", "FETCH_HEAD"), { force: true });
}

async function defaultTask(task: string, id: string): Promise<void> {
  const environment = join(task, "environment");
  const source = join(environment, "source");
  const tests = join(task, "tests");
  const packagePath = join(source, "package.json");
  const pkg = (await pathExists(packagePath)) ? await readJson(packagePath) : {};
  const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  let install = "";
  if (/^pnpm@\d+\.\d+\.\d+$/.test(packageManager) && await pathExists(join(source, "pnpm-lock.yaml"))) {
    install = `RUN npm install -g ${packageManager} && pnpm install --frozen-lockfile\n`;
  } else if (/^bun@\d+\.\d+\.\d+$/.test(packageManager) &&
      (await pathExists(join(source, "bun.lock")) || await pathExists(join(source, "bun.lockb")))) {
    install = `RUN npm install -g ${packageManager} && bun install --frozen-lockfile\n`;
  } else if (await pathExists(join(source, "package-lock.json"))) {
    install = "RUN npm ci\n";
  } else if (await pathExists(packagePath) || await pathExists(join(source, "pyproject.toml"))) {
    install = `${pending} Pin the toolchain and add reproducible setup for this task.\n`;
  }

  await mkdir(tests, { recursive: true });
  await Promise.all([
    writeFile(join(environment, "Dockerfile"),
      `FROM ${nodeImage}\nRUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*\nWORKDIR /app\nCOPY source/ /app/\n${install}`),
    writeFile(join(tests, "Dockerfile"), `FROM ${nodeImage}\nCOPY . /tests/\n`),
    writeFile(join(tests, "test.sh"), `#!/bin/sh\n${pending} Implement checks for the final state and write /logs/verifier/reward.json.\nexit 2\n`, { mode: 0o755 }),
    writeFile(join(task, "task.toml"), [
      "artifacts = []", "", "[task]", `name = "pbench/${id}"`, "",
      "[agent]", "timeout_sec = 1800", "", "[verifier]", "environment_mode = \"separate\"",
      "timeout_sec = 120", ""
    ].join("\n"))
  ]);
}

export async function prepareHarborCase(location: CaseLocation, options: { template?: string; baselineOnly?: boolean } = {}) {
  const manifestPath = join(location.caseDir, "case.json");
  const manifest = await readJson(manifestPath);
  const caseId = String(manifest.id);
  if (!/^case_[a-z0-9_-]+$/i.test(caseId)) throw new Error("Invalid pbench case ID.");
  const task = join(location.caseDir, taskFolder);
  const source = join(task, "environment", "source");
  if (options.template) await cp(resolve(options.template), task, { recursive: true, errorOnExist: true, force: false });
  if (await pathExists(source)) throw new Error("The pbench task template must leave environment/source for the captured Git baseline.");
  await exportGitBaseline(location, manifest, source);
  if (!options.template) await defaultTask(task, caseId);
  const instruction = join(task, "instruction.md");
  if (!(await pathExists(instruction))) {
    await cp(join(location.caseDir, "public", "prompt.md"), instruction);
  }
  await writeJson(join(location.caseDir, "private", "capture-manifest.json"), manifest);
  await rename(join(location.caseDir, "public"), join(location.caseDir, "private", "replay-evidence"));
  await writeJson(manifestPath, {
    schemaVersion: 2,
    id: caseId,
    title: manifest.title,
    privacy: manifest.privacy,
    metadata: manifest.metadata,
    subjects: manifest.subjects,
    harbor: { version: HARBOR_VERSION },
    replayStart: options.baselineOnly ? { status: "baseline" } : manifest.replayStart ?? { status: "unresolved" }
  });
  await writeFile(join(location.caseDir, "private", "authoring-checklist.md"), [
    "# Harbor case",
    "",
    "- Review harbor/instruction.md and pick the starting state in case.json.",
    "- Keep the session evidence under private/. Put reviewed starting files in harbor/environment/source.",
    "- Pin task dependencies in harbor/environment/Dockerfile.",
    "- Declare outputs in harbor/task.toml and check them in harbor/tests/test.sh.",
    "- If available, reuse a known failed and successful Harbor trial or Git commit through yk pbench validate.",
    ""
  ].join("\n"));
}

async function taskProblems(caseDir: string): Promise<string[]> {
  const manifest = await readJson(join(caseDir, "case.json"));
  if (manifest.schemaVersion !== 2) return ["This case predates Harbor. Migrate it before running it."];
  const task = join(caseDir, taskFolder);
  const errors: string[] = [];
  const start = asObject(manifest.replayStart)?.status;
  if (start !== "clean" && start !== "baseline" && start !== "curated") {
    errors.push("Choose a starting state in case.json. Use baseline or curate harbor/environment/source first.");
  }
  const composeFiles = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  const compose = await Promise.all(["environment", "tests"].flatMap((dir) =>
    composeFiles.map((name) => pathExists(join(task, dir, name)))));
  if (await pathExists(join(task, "steps")) || compose.some(Boolean)) {
    errors.push("PBench currently requires a single-step task and separate agent and verifier Dockerfiles.");
  }
  for (const name of ["instruction.md", "task.toml", "environment/Dockerfile", "tests/Dockerfile", "tests/test.sh"]) {
    try {
      const contents = await readFile(join(task, name), "utf8");
      if (!contents.trim() || contents.includes(pending)) errors.push(`Complete harbor/${name}.`);
      if (name === "instruction.md") assertNoAgentVisiblePrivateReferences([{ label: name, text: contents }], [caseDir]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") errors.push(`Missing harbor/${name}.`);
      else if (name === "instruction.md") errors.push((error as Error).message);
      else throw error;
    }
  }
  return errors;
}

async function taskDigest(root: string, checkLinks = false): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory)).sort()) {
      const path = join(directory, entry);
      const relativePath = prefix + entry;
      const info = await lstat(path);
      if (info.isDirectory()) {
        hash.update(JSON.stringify([relativePath, "directory"]));
        await walk(path, relativePath + "/");
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (checkLinks && !resolve(directory, target).startsWith(root + sep)) {
          throw new Error(`Skill link points outside the saved directory: ${relativePath}`);
        }
        hash.update(JSON.stringify([relativePath, "symlink", target]));
      } else if (info.isFile()) {
        hash.update(JSON.stringify([relativePath, info.mode & 0o111, await fileDigest(path)]));
      } else {
        throw new Error(`Unsupported Harbor task entry: ${relativePath}`);
      }
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

async function verifyArchive(snapshot: Snapshot): Promise<void> {
  if (await fileDigest(join(snapshot.directory, archiveName)) !== snapshot.archiveDigest) {
    throw new Error(`PBench image archive checksum mismatch: ${snapshot.directory}`);
  }
}

async function loadSnapshot(caseDir: string, revision: string): Promise<Snapshot | null> {
  const directory = join(caseDir, ".snapshots", revision);
  const metadata = join(directory, "snapshot.json");
  if (!(await pathExists(metadata))) return null;
  const data = await readJson(metadata);
  const images = asArray(data.images);
  if (data.revision !== revision || data.harborVersion !== HARBOR_VERSION || typeof data.archiveDigest !== "string" ||
      images.length !== 2 || images.some((image) => typeof image.tag !== "string" || typeof image.id !== "string")) {
    throw new Error(`Invalid pbench snapshot: ${metadata}`);
  }
  return { revision, directory, images: images as [Image, Image], archiveDigest: data.archiveDigest };
}

async function freeze(runtime: HarborRuntime, caseDir: string, revision: string): Promise<Snapshot> {
  const existing = await loadSnapshot(caseDir, revision);
  if (existing) return existing;

  const snapshots = join(caseDir, ".snapshots");
  await mkdir(snapshots, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(snapshots, "build-"));
  try {
    const task = join(staging, taskFolder);
    await cp(join(caseDir, taskFolder), task, { recursive: true, verbatimSymlinks: true });
    if (await taskDigest(task) !== revision) throw new Error("The Harbor task changed while preparing the snapshot. Retry validation.");
    await mkdir(join(staging, "configuration"));
    await Promise.all([
      cp(join(task, "task.toml"), join(staging, "configuration", "task.toml")),
      cp(join(task, "instruction.md"), join(staging, "configuration", "instruction.md")),
      cp(join(task, "environment", "Dockerfile"), join(staging, "configuration", "environment.Dockerfile")),
      cp(join(task, "tests", "Dockerfile"), join(staging, "configuration", "verifier.Dockerfile"))
    ]);
    const archive = join(staging, archiveName);
    const images = await runtime.build(task, join(staging, "build"), archive);
    const archiveDigest = await fileDigest(archive);
    await rm(task, { recursive: true, force: true });
    await writeJson(join(staging, "snapshot.json"), { revision, images, archiveDigest, harborVersion: HARBOR_VERSION });
    try {
      await rename(staging, join(snapshots, revision));
    } catch (error) {
      const winner = await loadSnapshot(caseDir, revision);
      if (!winner) throw error;
      return winner;
    }
    return { revision, directory: join(snapshots, revision), images, archiveDigest };
  } catch (error) {
    throw new Error(`${(error as Error).message} Snapshot build evidence is in ${staging}.`, { cause: error });
  } finally {
    // A successful rename removes staging. Keep build logs when a build fails.
    if (await pathExists(join(staging, "snapshot.json"))) await rm(staging, { recursive: true, force: true });
  }
}

async function restoreTask(runtime: HarborRuntime, caseDir: string, snapshot: Snapshot, destination: string) {
  await verifyArchive(snapshot);
  await runtime.restore(snapshot.images, join(snapshot.directory, archiveName));
  await cp(join(caseDir, taskFolder), destination, { recursive: true, verbatimSymlinks: true });
  if (await taskDigest(destination) !== snapshot.revision) {
    throw new Error("The Harbor task changed during invocation. Retry with the current version.");
  }
  await runtime.configure(destination, snapshot.images);
}

async function resolveTrial(sample: string, location: CaseLocation, caseId: string): Promise<string> {
  let directory: string;
  if (sample.startsWith("run:")) {
    const id = sample.slice(4);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Use a trial ID from yk pbench report after run:.");
    const run = await readJson(join(location.workspaceRoot, "runs", id, "run.json"));
    if (run.schemaVersion !== 2 || run.caseId !== caseId || typeof run.directory !== "string") {
      throw new Error("The selected trial belongs to a different pbench case.");
    }
    directory = run.directory;
  } else {
    directory = resolve(sample.slice(6));
  }
  if (!(await pathExists(join(directory, "result.json")))) throw new Error(`No local Harbor trial result in ${directory}.`);
  return directory;
}

async function addGitSample(task: string, sample: string, location: CaseLocation, manifest: JsonObject): Promise<void> {
  const subject = gitSubject(manifest, location.workspaceRoot);
  const ref = sample.slice(4);
  if (!ref || ref.startsWith("-")) throw new Error("Supply a Git commit or ref after git:.");
  let args = ["--git-dir", subject.cache];
  const commit = await git([...args, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).catch(async () => {
    if (!subject.source) throw new Error(`Git sample not found: ${ref}`);
    args = ["-C", subject.source];
    return git([...args, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  });
  const solution = join(task, "solution");
  await rm(solution, { recursive: true, force: true });
  await mkdir(solution);
  await git([...args, "diff", "--binary", `--output=${join(solution, "sample.patch")}`, subject.commit, commit]);
  await writeFile(join(solution, "solve.sh"),
    "#!/bin/sh\nset -eu\ncd /app\nif [ -s /solution/sample.patch ]; then git apply --binary /solution/sample.patch; fi\n",
    { mode: 0o755 });
}

async function testSample(
  runtime: HarborRuntime, location: CaseLocation, manifest: JsonObject, task: string,
  directory: string, sample: string, expected: number
): Promise<SampleResult> {
  try {
    let trial: HarborTrial | undefined;
    if (sample.startsWith("run:") || sample.startsWith("trial:")) {
      [trial] = await runtime.regrade(task, await resolveTrial(sample, location, String(manifest.id)), directory);
    } else if (sample === "nop" || sample === "oracle" || sample.startsWith("git:")) {
      let sampleTask = task;
      if (sample.startsWith("git:")) {
        sampleTask = join(directory, taskFolder);
        await cp(task, sampleTask, { recursive: true, verbatimSymlinks: true });
        await addGitSample(sampleTask, sample, location, manifest);
      }
      [trial] = await runtime.run({ directory, task: sampleTask, agent: sample === "nop" ? "nop" : "oracle" });
    } else {
      throw new Error("Expected nop, oracle, run:TRIAL_ID, trial:PATH, or git:COMMIT.");
    }
    return {
      sample, expected, reward: trial?.rewards.reward ?? null,
      valid: trial?.rewardValid === true && !trial.error,
      error: trial?.error ?? (trial ? null : "Harbor did not produce a trial.")
    };
  } catch (error) {
    return { sample, expected, reward: null, valid: false, error: (error as Error).message };
  }
}

export function createHarborWorkflow(options: {
  captureSession: (options: CaptureOptions) => Promise<CaptureResult>;
  runtime?: HarborRuntime;
}) {
  const runtime = options.runtime ?? dockerHarborRuntime;

  async function capture(input: CaptureHarborOptions) {
    const result = await options.captureSession(input);
    const location = { caseDir: result.caseDir, workspaceRoot: result.workspaceRoot };
    try {
      await prepareHarborCase(location, { template: input.task, baselineOnly: input.baselineOnly });
    } catch (error) {
      throw new Error(`Capture evidence is in ${result.transactionPath}. ${(error as Error).message}`, { cause: error });
    }

    const destination = join(result.workspaceRoot, "cases", result.caseId);
    const staging = await mkdtemp(join(dirname(destination), ".capture-"));
    try {
      await cp(result.caseDir, staging, { recursive: true, verbatimSymlinks: true });
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const txPath = join(result.transactionPath, "transaction.json");
    await writeJson(txPath, { ...await readJson(txPath), caseDir: destination });
    await rm(result.caseDir, { recursive: true, force: true });

    const saved = { ...result, caseDir: destination, authoringChecklistPath: join(destination, "private", "authoring-checklist.md") };
    const errors = await taskProblems(destination);
    if (errors.length) return { ...saved, state: "needs-authoring", errors };
    try {
      const snapshot = await freeze(runtime, destination, await taskDigest(join(destination, taskFolder)));
      return { ...saved, state: "saved", revision: snapshot.revision, verifierStatus: "pending" };
    } catch (error) {
      return { ...saved, state: "needs-snapshot", errors: [(error as Error).message] };
    }
  }

  async function inspect(caseDir: string) {
    const errors = await taskProblems(caseDir);
    if (errors.length) return { ok: false, state: "needs-authoring", errors, warnings: [] };
    const revision = await taskDigest(join(caseDir, taskFolder));
    const snapshot = await loadSnapshot(caseDir, revision);
    const assessment = snapshot && join(snapshot.directory, "assessment.json");
    const verifierStatus = assessment && await pathExists(assessment)
      ? String((await readJson(assessment)).verifierStatus) : "pending";
    return { ok: true, state: snapshot ? "saved" : "needs-snapshot", revision, verifierStatus, errors, warnings: [] };
  }

  async function save(caseDir: string) {
    const status = await inspect(caseDir);
    if (!status.ok || !status.revision) return status;
    await freeze(runtime, caseDir, status.revision);
    return inspect(caseDir);
  }

  async function validate(location: CaseLocation, samples: { fail?: string; pass?: string }) {
    const status = await save(location.caseDir);
    if (!status.ok || !status.revision) return status;
    const manifest = await readJson(join(location.caseDir, "case.json"));
    const snapshot = await loadSnapshot(location.caseDir, status.revision);
    if (!snapshot) throw new Error("PBench snapshot disappeared during validation.");
    const directory = await mkdtemp(join(snapshot.directory, "validation-"));
    const task = join(directory, taskFolder);
    await restoreTask(runtime, location.caseDir, snapshot, task);
    const samplesPath = join(location.caseDir, "private", "samples.json");
    const previous = await pathExists(samplesPath) ? await readJson(samplesPath) : {};
    const fail = samples.fail ?? (typeof previous.fail === "string" ? previous.fail : "nop");
    const pass = samples.pass ?? (typeof previous.pass === "string" ? previous.pass :
      (await pathExists(join(task, "solution", "solve.sh")) ? "oracle" : undefined));
    const results = [await testSample(runtime, location, manifest, task, join(directory, "fail"), fail, 0)];
    if (pass) results.push(await testSample(runtime, location, manifest, task, join(directory, "pass"), pass, 1));
    const errors = results.filter((result) => !result.valid || result.reward !== result.expected).map((result) =>
      `${result.sample} expected ${result.expected}, got ${result.error ?? result.reward ?? "no reward"}`);
    const verifierStatus = errors.length === 0 && results.length === 2 ? "verified" : "pending";
    const result = {
      ok: errors.length === 0, revision: snapshot.revision, verifierStatus, results, errors, directory,
      warnings: pass ? [] : ["Provide a known successful trial or Git commit with --pass."]
    };
    const assessment = join(snapshot.directory, "assessment.json");
    const temporary = join(directory, "assessment.json");
    await writeJson(temporary, result);
    await rename(temporary, assessment);
    if (verifierStatus === "verified") {
      await writeJson(temporary, { fail, pass });
      await rename(temporary, samplesPath);
    }
    return result;
  }

  async function run(location: CaseLocation, input: {
    agent: string; model: string; profile?: string; attempts: number; envNames: string[]; skill?: string
  }) {
    if (!["codex", "claude", "claude-code"].includes(input.agent)) throw new Error("Choose codex or claude for --agent.");
    const agent = input.agent === "claude" ? "claude-code" : input.agent;
    const status = await inspect(location.caseDir);
    if (!status.ok || !status.revision) throw new Error(status.errors.join("\n"));
    const snapshot = await loadSnapshot(location.caseDir, status.revision);
    if (!snapshot) throw new Error("Save the snapshot first with yk pbench finalize --case CASE.");
    const manifest = await readJson(join(location.caseDir, "case.json"));
    const caseId = String(manifest.id);
    for (const name of input.envNames) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !process.env[name]) throw new Error(`Missing or invalid environment variable: ${name}`);
    }
    const modelCredentials = agent === "codex" ? ["OPENAI_API_KEY"] : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
    const envNames = [...new Set([...input.envNames, ...modelCredentials.filter((name) => process.env[name])])].sort();
    const runs = join(location.workspaceRoot, "runs");
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(runs, "job-"));
    const task = join(directory, taskFolder);
    await restoreTask(runtime, location.caseDir, snapshot, task);
    await rm(join(task, "solution"), { recursive: true, force: true });
    let skill: string | undefined;
    let skillDigest: string | undefined;
    if (input.skill) {
      const source = resolve(input.skill);
      skill = join(directory, "skills", basename(source));
      await cp(source, skill, { recursive: true, dereference: false, verbatimSymlinks: true });
      if (!(await lstat(skill)).isDirectory()) throw new Error("--skill requires a real directory with SKILL.md.");
      skillDigest = await taskDigest(skill, true);
      if (!(await pathExists(join(skill, "SKILL.md")))) throw new Error("--skill requires a directory with SKILL.md.");
    }
    const trials = await runtime.run({
      directory, task, agent, model: input.model, attempts: input.attempts, envNames, skill
    });
    for (const trial of trials) {
      const record: HarborRun = {
        ...trial, schemaVersion: 2, caseId, revision: snapshot.revision,
        profile: normalizeRunProfile(input.profile), agent, model: trial.model ?? input.model,
        requestedModel: input.model, envNames,
        skill: skillDigest, verifierStatus: status.verifierStatus
      };
      await writeJson(join(runs, trial.id, "run.json"), record);
    }
    return { caseId, revision: snapshot.revision, directory, verifierStatus: status.verifierStatus, trials };
  }

  return { capture, inspect, save, validate, run };
}

export async function harborTransaction(transactionPath: string): Promise<CaseLocation> {
  const manifest = await readJson(join(transactionPath, "transaction.json"));
  if (typeof manifest.caseDir !== "string" || typeof manifest.workspaceRoot !== "string") {
    throw new Error("Invalid pbench transaction.");
  }
  return { caseDir: manifest.caseDir, workspaceRoot: manifest.workspaceRoot };
}
