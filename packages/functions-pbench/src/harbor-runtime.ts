import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import python from "./harbor-results.py" with { type: "text" };

export const HARBOR_VERSION = "0.25.0";
const pythonArgs = ["run", "--no-project", "--python", "3.12", "--with", `harbor==${HARBOR_VERSION}`, "--with", "tomli-w==1.2.0"];
const hostEnv = [
  "PATH", "HOME", "USER", "TMPDIR", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "UV_CACHE_DIR"
];

export type HarborTrial = {
  id: string;
  directory: string;
  agentVersion: string;
  model?: string | null;
  rewards: Record<string, number>;
  rewardValid: boolean;
  error: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};

export type Image = { tag: string; id: string };
export type HarborJob = {
  directory: string;
  task: string;
  agent: string;
  model?: string;
  attempts?: number;
  envNames?: string[];
  keepImages?: boolean;
  skill?: string;
};

export type HarborRuntime = {
  build(task: string, directory: string, archive: string): Promise<[Image, Image]>;
  configure(task: string, images: [Image, Image]): Promise<void>;
  restore(images: [Image, Image], archive: string): Promise<void>;
  run(job: HarborJob): Promise<HarborTrial[]>;
  regrade(task: string, source: string, directory: string): Promise<HarborTrial[]>;
};

const exec = promisify(execFile);

async function runProcess(program: string, args: string[], cwd?: string, envNames: string[] = []): Promise<string> {
  const env = Object.fromEntries(
    [...hostEnv, ...envNames].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])
  );
  try {
    const { stdout } = await exec(program, args, {
      cwd, env: { ...env, HARBOR_TELEMETRY: "off" }, maxBuffer: 16 * 1024 * 1024
    });
    return stdout.trim();
  } catch (error) {
    const message = (error as { stderr?: string; message: string }).stderr || (error as Error).message;
    const redacted = envNames.reduce((text, name) => env[name] ? text.split(env[name]).join("[redacted]") : text, message);
    throw new Error(redacted.trim());
  }
}

async function runHarbor(args: string[], directory: string, envNames?: string[]): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const output = await runProcess("uv", [...pythonArgs, "harbor", ...args], directory, envNames);
    await writeFile(join(directory, "harbor-cli.log"), output + "\n");
  } catch (error) {
    await writeFile(join(directory, "harbor-cli.log"), (error as Error).message + "\n");
    throw new Error(`Harbor command failed. See ${join(directory, "harbor-cli.log")}`, { cause: error });
  }
}

async function configure(task: string, images?: [Image, Image]): Promise<void> {
  const [agent, verifier] = images ?? [];
  await runProcess("uv", [...pythonArgs, "python", "-c", python, "configure", join(task, "task.toml"),
    agent?.tag ?? "", verifier?.tag ?? ""], task);
}

async function summarize(directory: string): Promise<HarborTrial[]> {
  const json = await runProcess("uv", [...pythonArgs, "python", "-c", python, "summarize", directory], directory);
  const trials = JSON.parse(json) as HarborTrial[];
  return trials;
}

async function run(job: HarborJob): Promise<HarborTrial[]> {
  const args = [
    "run", "-e", "docker", "-p", job.task, "-a", job.agent, "--jobs-dir", job.directory,
    "--job-name", "trials", "--n-attempts", String(job.attempts ?? 1), "--n-concurrent", "1", "--quiet"
  ];
  if (job.model) args.push("-m", job.model);
  if (job.keepImages) args.push("--no-delete");
  if (job.skill) args.push("--skill", job.skill);
  for (const name of job.envNames ?? []) args.push("--ae", name + "=${" + name + "}");
  await runHarbor(args, job.directory, job.envNames);
  const trials = await summarize(join(job.directory, "trials"));
  if (trials.length !== (job.attempts ?? 1)) {
    throw new Error(`Expected ${job.attempts ?? 1} Harbor trials, found ${trials.length} in ${job.directory}.`);
  }
  return trials;
}

async function build(task: string, directory: string, archive: string): Promise<[Image, Image]> {
  const buildId = randomUUID();
  const roles = ["agent", "verifier"] as const;
  await configure(task);
  const tags = roles.map((role) => `pbench-local:${buildId}-${role}`);
  // Tag each build so it can be identified after Harbor tears down the trial.
  await Promise.all(roles.map((role, index) => writeFile(
    join(task, role === "agent" ? "environment" : "tests", "docker-compose.yaml"),
    `services:\n  main:\n    image: ${tags[index]}\n    build: .\n`
  )));
  const [trial] = await run({ directory, task, agent: "nop", keepImages: true });
  const images: Image[] = [];
  for (const [index, role] of roles.entries()) {
    const tag = tags[index];
    let id: string;
    try {
      id = await runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", tag]);
    } catch (error) {
      throw new Error(`Harbor could not build the ${role} image (${trial.error ?? "image missing"}). See ${trial.directory}.`, { cause: error });
    }
    images.push({ id, tag });
  }
  await runProcess("docker", ["image", "save", "-o", archive, ...images.map(({ tag }) => tag)]);
  return [images[0], images[1]];
}

async function imageMatches(image: Image): Promise<boolean> {
  try {
    return await runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", image.tag]) === image.id;
  } catch {
    return false;
  }
}

async function restore(images: [Image, Image], archive: string): Promise<void> {
  if ((await Promise.all(images.map(imageMatches))).every(Boolean)) return;
  await runProcess("docker", ["image", "load", "-i", archive]);
  if (!(await Promise.all(images.map(imageMatches))).every(Boolean)) {
    throw new Error("Restored Docker images do not match the pbench snapshot.");
  }
}

async function regrade(task: string, source: string, directory: string): Promise<HarborTrial[]> {
  await runHarbor(["trial", "regrade", source, "-p", task, "-e", "docker", "-o", directory, "--trial-name", "regrade"], directory);
  return summarize(directory);
}

export const dockerHarborRuntime: HarborRuntime = { build, configure, restore, run, regrade };

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
