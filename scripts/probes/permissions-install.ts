// Read-only native and packaged-install acceptance probe.
//
// Native work includes permission checks, Finder discovery, and one read-only
// observation through each probe-owned persistent session. Each session is
// closed and its host/worker cleanup is checked. No input or activation API
// is called. This is an evidence tool, not product code.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectTargetLease,
  type Target
} from "@ya-skills/computer-runtime";
import {
  openSession,
  sendControl,
  sendRequest,
  sessionPaths
} from "@ya-skills/computer-session";

const probeDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(probeDir, "../..");
const bun = process.execPath;
const releaseDir = join(repoDir, "dist/release/ya-skills");
const packagedYk = join(releaseDir, "yk");
const sourceCli = join(repoDir, "packages/cli/src/cli.ts");
const packagedCatalog = join(releaseDir, "skills");
const sourceSdk = join(repoDir, "packages/computer-runtime/node_modules/@trycua/cua-driver/dist/index.js");
const packagedSdk = join(releaseDir, "runtime/computer-use/node_modules/@trycua/cua-driver/dist/index.js");
const packagedNative = join(
  releaseDir,
  "runtime/computer-use/node_modules/@trycua/cua-driver-darwin-arm64/cua_driver_node_runtime.node"
);
const packagedDylib = join(
  releaseDir,
  "runtime/computer-use/node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib"
);
const evidenceDir = join(repoDir, "docs/verification/evidence/2026-09-16-permissions-install");

type CommandResult = {
  argv: string[];
  cwd: string;
  path: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  stdout: string;
  stderr: string;
  loaderPaths: string[];
  processIdentity: ProcessIdentity | null;
  processChain: ProcessIdentity[];
  responsiblePid: number | null;
  envShape: { path: string; nodePath: string; nodeOptions: string; bunOptions: string };
};

type ProcessIdentity = {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  comm: string;
};

function readProcessIdentity(pid: number): ProcessIdentity | null {
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,uid=,comm="], {
    encoding: "utf8"
  });
  if (ps.status !== 0) return null;
  const line = (ps.stdout ?? "").trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    uid: Number(match[4]),
    comm: match[5]
  };
}

function readResponsiblePid(pid: number): number | null {
  const code = [
    "import ctypes, sys",
    "lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
    "fn = lib.responsibility_get_pid_responsible_for_pid",
    "fn.argtypes = [ctypes.c_int]",
    "fn.restype = ctypes.c_int",
    "print(fn(int(sys.argv[1])))"
  ].join("; ");
  const result = spawnSync("/usr/bin/python3", ["-c", code, String(pid)], {
    encoding: "utf8",
    timeout: 1_000
  });
  if (result.status !== 0) return null;
  const value = Number((result.stdout ?? "").trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readProcessChain(pid: number | undefined): ProcessIdentity[] {
  const chain: ProcessIdentity[] = [];
  const seen = new Set<number>();
  let current = pid;
  for (let depth = 0; current !== undefined && depth < 5 && !seen.has(current); depth++) {
    const identity = readProcessIdentity(current);
    if (identity === null) break;
    chain.push(identity);
    seen.add(current);
    current = identity.ppid > 1 ? identity.ppid : undefined;
  }
  return chain;
}

function commandEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    PATH: "/usr/bin:/bin",
    NODE_PATH: "",
    NODE_OPTIONS: "",
    BUN_OPTIONS: "",
    YA_SKILLS_CATALOG_DIR: packagedCatalog,
    DYLD_PRINT_LIBRARIES: "1",
    DYLD_PRINT_LIBRARIES_POST_LAUNCH: "1",
    ...overrides
  });
  return env;
}

async function runCommand(
  path: string,
  args: string[],
  cwd: string,
  overrides: Record<string, string | undefined> = {}
): Promise<CommandResult> {
  const env = commandEnvironment(overrides);
  const child = spawn(path, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
    if (stdout.length > 512_000) stdout = stdout.slice(0, 512_000);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
    if (stderr.length > 512_000) stderr = stderr.slice(0, 512_000);
  });
  const processIdentity = child.pid === undefined ? null : readProcessIdentity(child.pid);
  const processChain = readProcessChain(child.pid);
  const responsiblePid = child.pid === undefined ? null : readResponsiblePid(child.pid);
  let timedOut = false;
  let spawnError: string | null = null;
  const [exitCode, signal] = await new Promise<[number | null, string | null]>((resolveExit) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null, closeSignal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolveExit([code, closeSignal]);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, 30_000);
    child.once("close", (code, closeSignal) => finish(code, closeSignal));
    child.once("error", (error) => {
      spawnError = String(error);
      stderr += String(error) + "\n";
      finish(null, null);
    });
  });
  const loaderPaths = `${stdout}\n${stderr}`
    .split("\n")
    .filter((line) => /dyld\[.*\].*(cua|ubjs|uniffi|node_runtime|driver_sdk|runtime\/computer-use)/i.test(line))
    .map((line) => line.trim());
  return {
    argv: [path, ...args],
    cwd,
    path,
    exitCode,
    signal,
    timedOut,
    spawnError,
    stdout,
    stderr,
    loaderPaths,
    processIdentity,
    processChain,
    responsiblePid,
    envShape: {
      path: env.PATH ?? "",
      nodePath: env.NODE_PATH ?? "",
      nodeOptions: env.NODE_OPTIONS ?? "",
      bunOptions: env.BUN_OPTIONS ?? ""
    }
  };
}

function codeSignSummary(path: string): { path: string; realpath: string | null; output: string; exitCode: number | null } {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", path], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /^(Executable|Identifier|Format|CodeDirectory|Authority|TeamIdentifier|Signature|Runtime Version|CandidateCDHash|CDHash)=?/.test(line))
    .join("\n");
  return {
    path,
    realpath: tryRealpath(path),
    output,
    exitCode: result.status
  };
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function statSummary(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { path, exists: false };
  const stat = lstatSync(path);
  return {
    path,
    exists: true,
    kind: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    mode: (stat.mode & 0o777).toString(8),
    bytes: stat.size,
    realpath: tryRealpath(path)
  };
}

function parseJsonLines(output: string): unknown[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

function parseJsonObject(output: string): Record<string, unknown> | null {
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const value = JSON.parse(output.slice(first, last + 1)) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function installSummary(result: CommandResult, paths: string[]): Record<string, unknown> {
  return {
    command: result,
    targets: paths.map((path) => ({ path, exists: existsSync(path), skill: existsSync(join(path, "computer-use")) }))
  };
}

function compactCommand(result: CommandResult): Record<string, unknown> {
  // Keep this report about the probe's own child. Do not copy the child's
  // complete stderr/stdout: native loader logs are already retained in the
  // bounded loaderPaths field, and desktop content never belongs in evidence.
  return {
    argv: result.argv,
    cwd: result.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    loaderPaths: result.loaderPaths,
    processIdentity: result.processIdentity,
    processChain: result.processChain,
    responsiblePid: result.responsiblePid,
    envShape: result.envShape
  };
}

function processEvidence(pid: number | null): Record<string, unknown> {
  if (pid === null) return { pid: null, alive: false };
  const identity = readProcessIdentity(pid);
  const responsiblePid = identity === null ? null : readResponsiblePid(pid);
  const executable = identity?.comm;
  return {
    pid,
    alive: identity !== null,
    identity,
    processChain: identity === null ? [] : readProcessChain(pid),
    responsiblePid,
    responsibleIdentity: responsiblePid === null ? null : readProcessIdentity(responsiblePid),
    codeSigning: executable === undefined ? null : codeSignSummary(executable)
  };
}

function hasValidResponsibleProcess(value: Record<string, unknown>): boolean {
  const responsiblePid = value.responsiblePid;
  const identity = value.responsibleIdentity;
  if (typeof responsiblePid !== "number" || !Number.isSafeInteger(responsiblePid) || responsiblePid <= 0) return false;
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) return false;
  const row = identity as { pid?: unknown; comm?: unknown };
  return row.pid === responsiblePid && typeof row.comm === "string" && row.comm.length > 0;
}

function pidIsAlive(pid: number): boolean {
  return readProcessIdentity(pid) !== null;
}

async function waitForPidGone(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pidIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !pidIsAlive(pid);
}

function summarizeObservation(reply: unknown): Record<string, unknown> {
  if (typeof reply !== "object" || reply === null) return { replyType: typeof reply };
  const value = reply as {
    status?: unknown;
    error?: unknown;
    result?: unknown;
  };
  const summary: Record<string, unknown> = {
    status: value.status,
    ...(value.error !== undefined ? { error: value.error } : {})
  };
  if (typeof value.result !== "object" || value.result === null) return summary;
  const result = value.result as {
    ax?: { status?: unknown; total?: unknown; returned?: unknown; complete?: unknown };
    image?: { status?: unknown; frameValid?: unknown };
  };
  // Deliberately omit title, labels, values, element tokens and image bytes.
  // Finder content is outside this probe's permission question.
  if (result.ax !== undefined) {
    summary.ax = {
      status: result.ax.status,
      total: result.ax.total,
      returned: result.ax.returned,
      complete: result.ax.complete
    };
  }
  if (result.image !== undefined) {
    summary.image = {
      status: result.image.status,
      frameValid: result.image.frameValid
    };
  }
  return summary;
}

function parseFinderPid(output: string): number | null {
  for (const value of parseJsonLines(output)) {
    if (typeof value !== "object" || value === null) continue;
    const apps = (value as { apps?: unknown }).apps;
    if (!Array.isArray(apps)) continue;
    for (const app of apps) {
      if (typeof app !== "object" || app === null) continue;
      const row = app as { pid?: unknown; name?: unknown };
      if (row.name === "Finder" && typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0) {
        return row.pid;
      }
    }
  }
  return null;
}

function parseWindowId(output: string): bigint | null {
  const rows: { windowId: string; title: string }[] = [];
  for (const value of parseJsonLines(output)) {
    if (typeof value !== "object" || value === null) continue;
    const windows = (value as { windows?: unknown }).windows;
    if (!Array.isArray(windows)) continue;
    for (const window of windows) {
      if (typeof window !== "object" || window === null) continue;
      const row = window as { windowId?: unknown; title?: unknown };
      if (typeof row.windowId === "string" && /^\d+$/.test(row.windowId)) {
        rows.push({ windowId: row.windowId, title: typeof row.title === "string" ? row.title : "" });
      }
    }
  }
  // A titled Finder window is the least ambiguous existing target. If none
  // exists, use the first reported window; the target is still read-only.
  const selected = rows.find((row) => row.title.length > 0) ?? rows[0];
  if (selected === undefined) return null;
  return BigInt(selected.windowId);
}

function sessionInfoFromPayload(value: Record<string, unknown> | null): Record<string, unknown> | null {
  const session = value?.session;
  if (typeof session !== "object" || session === null || Array.isArray(session)) return null;
  return session as Record<string, unknown>;
}

type PersistentSessionMode = "source" | "compiled";

async function verifyPersistentSession(
  mode: PersistentSessionMode,
  target: Target,
  tempRoot: string,
  hostileCwd: string
): Promise<Record<string, unknown>> {
  const label = `persistent-${mode}`;
  let sessionRoot = join(tempRoot, label, "sessions");
  mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
  let sessionId: string | null = null;
  let socketPath: string | null = null;
  let metadataPath: string | null = null;
  let configPath: string | null = null;
  let hostPid: number | null = null;
  let driverPids: number[] = [];
  let openCommand: Record<string, unknown> | null = null;
  let openedInfo: Record<string, unknown> | null = null;
  let leaseBeforeClose: Record<string, unknown> | null = null;
  let diagnostics: Record<string, unknown> | null = null;
  let observation: Record<string, unknown> | null = null;
  let statusBeforeClose: Record<string, unknown> | null = null;
  let closeReply: Record<string, unknown> | null = null;
  let error: string | null = null;
  let cleanupSafe = false;
  const startedAt = new Date().toISOString();

  try {
    if (mode === "source") {
      const opened = await openSession({ target, root: sessionRoot, idleTimeoutMs: 60_000 });
      sessionId = opened.info.id;
      socketPath = opened.socketPath;
      metadataPath = sessionPaths(sessionRoot, sessionId).metadata;
      configPath = opened.configPath;
      hostPid = opened.hostPid;
      openedInfo = opened.info as unknown as Record<string, unknown>;
    } else {
      // Bun's homedir() follows the logged-in account on this macOS runner;
      // HOME is not a reliable override for the compiled process. Resolve
      // the exact default root used by the product before reading its lease.
      sessionRoot = join(homedir(), "Library", "Caches", "ya-skills", "computer-use", "sessions");
      const opened = await runCommand(
        packagedYk,
        [
          "computer-use",
          "session",
          "open",
          "--pid",
          String(target.pid),
          "--window",
          target.windowId.toString(),
          "--idle-timeout-ms",
          "60000"
        ],
        hostileCwd,
        {}
      );
      openCommand = compactCommand(opened);
      const payload = parseJsonObject(opened.stdout);
      openedInfo = sessionInfoFromPayload(payload);
      const id = openedInfo?.id;
      if (typeof id !== "string") throw new Error("compiled session open returned no session id");
      sessionId = id;
      hostPid = typeof openedInfo.hostPid === "number" ? openedInfo.hostPid : null;
      socketPath = sessionPaths(sessionRoot, sessionId).socket;
      metadataPath = sessionPaths(sessionRoot, sessionId).metadata;
    }

    if (sessionId === null || socketPath === null || hostPid === null) {
      throw new Error("persistent session did not return a usable host identity");
    }
    const paths = sessionPaths(sessionRoot, sessionId);
    const lease = inspectTargetLease(sessionRoot, target);
    leaseBeforeClose = lease === null ? null : (lease as unknown as Record<string, unknown>);
    driverPids = Array.isArray(lease?.workerPids)
      ? lease.workerPids.filter((pid): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0)
      : [];
    const hostBefore = processEvidence(hostPid);
    const driversBefore = driverPids.map((pid) => processEvidence(pid));

    const control = await sendControl(
      socketPath,
      { kind: "diagnostics", schemaVersion: 1, sessionId } as never,
      5_000
    );
    const rawDiagnostics = (control as unknown as { diagnostics?: unknown }).diagnostics;
    diagnostics = typeof rawDiagnostics === "object" && rawDiagnostics !== null
      ? rawDiagnostics as Record<string, unknown>
      : null;

    const reply = await sendRequest(
      socketPath,
      {
        schemaVersion: 1,
        sessionId,
        generation: String(openedInfo?.generation ?? ""),
        requestId: `permissions-observe-${mode}-${Date.now()}`,
        operation: { kind: "observe", options: { mode: "ax" } }
      },
      30_000
    );
    observation = summarizeObservation(reply);

    const statusReply = await sendControl(socketPath, { kind: "status", schemaVersion: 1, sessionId }, 5_000);
    statusBeforeClose = statusReply.info === undefined ? null : statusReply.info as unknown as Record<string, unknown>;

    const closed = await sendControl(socketPath, { kind: "close", schemaVersion: 1, sessionId }, 15_000);
    closeReply = closed as unknown as Record<string, unknown>;
    const cleanup = (closed as unknown as { cleanup?: unknown }).cleanup;
    const hostGone = await waitForPidGone(hostPid);
    const driverGone = await Promise.all(driverPids.map((pid) => waitForPidGone(pid)));
    const leaseAfterClose = inspectTargetLease(sessionRoot, target);
    cleanupSafe =
      closed.info?.state === "closed" &&
      typeof cleanup === "object" && cleanup !== null &&
      (cleanup as { driverTerminated?: unknown }).driverTerminated === true &&
      (cleanup as { leaseReleased?: unknown }).leaseReleased === true &&
      hostGone &&
      driverGone.every(Boolean) &&
      !existsSync(paths.socket) &&
      leaseAfterClose === null;

    const ownershipObserved =
      lease?.pid === hostPid &&
      driverPids.length === 1 &&
      driversBefore.length === driverPids.length &&
      hostBefore.alive === true &&
      driversBefore.every((driver) => driver.alive === true) &&
      hasValidResponsibleProcess(hostBefore) &&
      driversBefore.every((driver) => hasValidResponsibleProcess(driver));
    const readonlyAxStatus = typeof observation?.ax === "object" && observation.ax !== null
      ? (observation.ax as { status?: unknown }).status
      : "unknown";

    const result = {
      status: cleanupSafe && ownershipObserved ? "passed" : "failed",
      ownershipStatus: ownershipObserved ? "passed_current_session" : "blocked",
      responsibilityStatus: ownershipObserved ? "observed_current_session" : "blocked",
      lifecycleStatus: cleanupSafe ? "passed" : "failed",
      readonlyAxStatus,
      mode,
      startedAt,
      target: { pid: target.pid, windowId: target.windowId.toString() },
      openCommand,
      opened: { info: openedInfo, hostPid, socketPath, metadataPath, configPath },
      ownershipBeforeClose: {
        lease: leaseBeforeClose,
        host: hostBefore,
        drivers: driversBefore,
        diagnostics
      },
      readonlyNative: {
        operation: "session observe --mode ax",
        inputFlags: [],
        activationCalls: [],
        observation,
        statusBeforeClose
      },
      close: {
        reply: closeReply,
        hostGone,
        driverGone,
        socketExists: existsSync(paths.socket),
        leaseAfterClose,
        metadata: existsSync(paths.metadata) ? parseJsonObject(readFileText(paths.metadata)) : null,
        cleanupSafe
      }
    };
    return result;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (sessionId !== null && socketPath !== null) {
      try {
        const closed = await sendControl(socketPath, { kind: "close", schemaVersion: 1, sessionId }, 15_000);
        closeReply = closed as unknown as Record<string, unknown>;
      } catch {
        // Preserve the session root below when close cannot be proven.
      }
    }
    return {
      status: "blocked",
      ownershipStatus: "blocked",
      responsibilityStatus: "blocked",
      lifecycleStatus: "blocked",
      readonlyAxStatus: "unknown",
      mode,
      startedAt,
      target: { pid: target.pid, windowId: target.windowId.toString() },
      openCommand,
      opened: { info: openedInfo, hostPid, socketPath, metadataPath, configPath },
      ownershipBeforeClose: { lease: leaseBeforeClose, hostPid, driverPids },
      readonlyNative: { operation: "session observe --mode ax", inputFlags: [], activationCalls: [], observation },
      close: { reply: closeReply, cleanupSafe },
      error
    };
  } finally {
    if (configPath !== null) {
      try {
        rmSync(dirname(configPath), { recursive: true, force: true });
      } catch {
        // Keep evidence even if the private config directory cannot be removed.
      }
    }
  }
}

function readFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const tempRoot = mkdtempSync(join(tmpdir(), "yk-permissions-install-"));
  const hostileCwd = join(tempRoot, "hostile-cwd");
  const linkBin = join(tempRoot, "bin");
  const linkYk = join(linkBin, "yk-link");
  mkdirSync(hostileCwd, { recursive: true, mode: 0o700 });
  mkdirSync(linkBin, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(hostileCwd, "package.json"),
    JSON.stringify({
      name: "hostile-cwd",
      version: "1.0.0",
      scripts: { preinstall: "touch SENTINEL_RAN", prepare: "touch SENTINEL_RAN" },
      dependencies: { "@trycua/cua-driver": "0.0.0-fake" }
    })
  );
  symlinkSync(packagedYk, linkYk);

  let preserveTempRoot = false;
  try {
    const shared = { repoDir, bun, releaseDir, packagedYk, sourceCli, packagedCatalog };
    writeFileSync(join(evidenceDir, "environment.json"), JSON.stringify({
      timestamp: new Date().toISOString(),
      ...shared,
      platform: process.platform,
      arch: process.arch,
      probePid: process.pid,
      probeExecPath: process.execPath,
      probeExecRealpath: tryRealpath(process.execPath),
      probeResponsiblePid: readResponsiblePid(process.pid),
      bunVersion: Bun.version,
      cwd: process.cwd(),
      home: homedir(),
      artifacts: [
        statSummary(packagedYk),
        statSummary(packagedSdk),
        statSummary(packagedNative),
        statSummary(packagedDylib),
        statSummary(sourceSdk),
        statSummary(linkYk)
      ],
      pathChecks: {
        sanitizedPath: "/usr/bin:/bin",
        bunOnSanitizedPath: spawnSync("sh", ["-c", "command -v bun >/dev/null 2>&1"], { env: commandEnvironment(), stdio: "ignore" }).status === 0,
        nodeOnSanitizedPath: spawnSync("sh", ["-c", "command -v node >/dev/null 2>&1"], { env: commandEnvironment(), stdio: "ignore" }).status === 0,
        npmOnSanitizedPath: spawnSync("sh", ["-c", "command -v npm >/dev/null 2>&1"], { env: commandEnvironment(), stdio: "ignore" }).status === 0
      },
      codeSigning: [codeSignSummary(packagedYk), codeSignSummary(bun), codeSignSummary(packagedNative), codeSignSummary(packagedDylib)]
    }, null, 2));

    const sourceDoctor = await runCommand(bun, [sourceCli, "computer-use", "doctor"], repoDir);
    const sourceApps = await runCommand(bun, [sourceCli, "computer-use", "apps", "--name", "Finder"], repoDir);
    const finderPid = parseFinderPid(sourceApps.stdout);
    const sourceWindows = finderPid === null
      ? null
      : await runCommand(bun, [sourceCli, "computer-use", "windows", "--pid", String(finderPid)], repoDir);
    const target = finderPid === null || sourceWindows === null
      ? null
      : (() => {
          const windowId = parseWindowId(sourceWindows.stdout);
          return windowId === null ? null : { pid: finderPid, windowId };
        })();
    const compiledDoctor = await runCommand(packagedYk, ["computer-use", "doctor"], hostileCwd);
    const compiledApps = await runCommand(packagedYk, ["computer-use", "apps", "--name", "Finder"], hostileCwd);
    const symlinkDoctor = await runCommand(linkYk, ["computer-use", "doctor"], hostileCwd);
    const symlinkApps = await runCommand(linkYk, ["computer-use", "apps", "--name", "Finder"], hostileCwd);
    const nativeOutputMentionsFakeDependency = [compiledApps, symlinkApps]
      .some((result) => (String(result.stdout) + "\n" + String(result.stderr)).includes("0.0.0-fake"));
    writeFileSync(join(evidenceDir, "native-readonly.json"), JSON.stringify({
      policy: {
        allowedCommands: ["computer-use doctor", "computer-use apps --name Finder"],
        inputFlags: [],
        activationCalls: [],
        persistentSession: false,
        note: "A true doctor permission result proves the current process can use the existing authorization. It does not prove that a separately spawned session host has the same responsible-process attribution."
      },
      source: { doctor: sourceDoctor, apps: sourceApps },
      compiled: { doctor: compiledDoctor, apps: compiledApps },
      symlink: { path: linkYk, realpath: tryRealpath(linkYk), doctor: symlinkDoctor, apps: symlinkApps },
      parsedApps: {
        source: parseJsonLines(sourceApps.stdout),
        compiled: parseJsonLines(compiledApps.stdout),
        symlink: parseJsonLines(symlinkApps.stdout)
      },
      hostileCwd: {
        cwd: hostileCwd,
        sentinelPath: join(hostileCwd, "SENTINEL_RAN"),
        projectScriptRan: existsSync(join(hostileCwd, "SENTINEL_RAN")),
        outputMentionsFakeDependency: nativeOutputMentionsFakeDependency
      }
    }, null, 2));

    const sourceInstallRoot = join(tempRoot, "source-install");
    const compiledInstallRoot = join(tempRoot, "compiled-install");
    for (const dir of [sourceInstallRoot, compiledInstallRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const sourceInstall = await runCommand(bun, [sourceCli, "install", "computer-use"], sourceInstallRoot);
    const compiledInstall = await runCommand(packagedYk, ["install", "computer-use"], compiledInstallRoot);
    const symlinkInstall = await runCommand(linkYk, ["install", "computer-use"], hostileCwd);
    const projectScriptRan = existsSync(join(hostileCwd, "SENTINEL_RAN"));
    const outputMentionsFakeDependency = [compiledApps, symlinkApps, symlinkInstall]
      .some((result) => (String(result.stdout) + "\n" + String(result.stderr)).includes("0.0.0-fake"));
    const installEvidence = {
      catalog: packagedCatalog,
      source: installSummary(sourceInstall, [join(sourceInstallRoot, ".agents", "skills")]),
      compiled: installSummary(compiledInstall, [join(compiledInstallRoot, ".agents", "skills")]),
      symlink: installSummary(symlinkInstall, [join(hostileCwd, ".agents", "skills")]),
      projectScriptRan,
      outputMentionsFakeDependency
    };
    writeFileSync(join(evidenceDir, "install-matrix.json"), JSON.stringify(installEvidence, null, 2));

    const persistentSessions = target === null
      ? []
      : [
          await verifyPersistentSession("source", target, tempRoot, hostileCwd),
          await verifyPersistentSession("compiled", target, tempRoot, hostileCwd)
        ];
    const persistentRequiresPreserve = persistentSessions.some((run) => {
      const opened = run.opened;
      const host = typeof opened === "object" && opened !== null
        ? (opened as { hostPid?: unknown }).hostPid
        : null;
      const ownership = run.ownershipBeforeClose;
      const lease = typeof ownership === "object" && ownership !== null
        ? (ownership as { lease?: unknown }).lease
        : null;
      const close = run.close;
      const closeRecord = typeof close === "object" && close !== null
        ? close as { cleanupSafe?: unknown; leaseAfterClose?: unknown }
        : null;
      const hostAlive = typeof host === "number" && pidIsAlive(host);
      const leaseAfterClose = closeRecord?.leaseAfterClose;
      return closeRecord?.cleanupSafe !== true &&
        (hostAlive || (leaseAfterClose !== null && leaseAfterClose !== undefined) || (closeRecord === null && lease !== null));
    });
    preserveTempRoot = persistentRequiresPreserve;
    writeFileSync(join(evidenceDir, "persistent-session.json"), JSON.stringify({
      policy: {
        allowedCommands: [
          "computer-use doctor",
          "computer-use apps --name Finder",
          "computer-use windows --pid FINDER_PID",
          "session open",
          "session diagnostics",
          "session observe --mode ax",
          "session status",
          "session close"
        ],
        inputFlags: [],
        activationCalls: [],
        nativeMutationCalls: [],
        note: "The persistent host check uses an existing Finder window and one AX-only observation. It records only the probe-owned host/worker PIDs and bounded parent/responsible-process identities; it does not enumerate unrelated processes or copy Finder element content."
      },
      targetDiscovery: {
        finderPid,
        target: target === null ? null : { pid: target.pid, windowId: target.windowId.toString() },
        windows: sourceWindows === null ? null : compactCommand(sourceWindows)
      },
      sessions: persistentSessions,
      cleanup: { preserveTempRoot, tempRoot }
    }, null, 2));

    const persistentLifecyclePassed =
      persistentSessions.length === 2 && persistentSessions.every((run) => run.lifecycleStatus === "passed");
    const persistentOwnershipObserved =
      persistentSessions.length === 2 && persistentSessions.every((run) => run.ownershipStatus === "passed_current_session");
    const persistentResponsibilityObserved =
      persistentSessions.length === 2 && persistentSessions.every((run) => run.responsibilityStatus === "observed_current_session");
    const persistentAxStatuses = persistentSessions.map((run) => run.readonlyAxStatus ?? "unknown");

    const status = {
      sourceDoctorOk: parseJsonObject(sourceDoctor.stdout),
      compiledDoctorOk: parseJsonObject(compiledDoctor.stdout),
      symlinkDoctorOk: parseJsonObject(symlinkDoctor.stdout),
      sourceAppsExit: sourceApps.exitCode,
      compiledAppsExit: compiledApps.exitCode,
      symlinkAppsExit: symlinkApps.exitCode,
      sourceInstallExit: sourceInstall.exitCode,
      compiledInstallExit: compiledInstall.exitCode,
      symlinkInstallExit: symlinkInstall.exitCode,
      projectScriptRan,
      outputMentionsFakeDependency,
      sourceLoaderPaths: sourceDoctor.loaderPaths,
      compiledLoaderPaths: compiledDoctor.loaderPaths,
      symlinkLoaderPaths: symlinkDoctor.loaderPaths,
      symlinkRealpath: tryRealpath(linkYk),
      packagedSidecar: tryRealpath(packagedSdk),
      persistentSession: {
        target: target === null ? null : { pid: target.pid, windowId: target.windowId.toString() },
        source: persistentSessions.find((run) => run.mode === "source") ?? null,
        compiled: persistentSessions.find((run) => run.mode === "compiled") ?? null,
        status: target !== null && persistentSessions.length === 2 && persistentSessions.every((run) => run.status === "passed")
          ? "passed"
          : "blocked",
        ownershipStatus: persistentOwnershipObserved ? "passed_current_session" : "blocked",
        responsibilityStatus: persistentResponsibilityObserved ? "observed_current_session" : "blocked",
        lifecycleStatus: persistentLifecyclePassed ? "passed" : "blocked",
        readonlyAxStatus: persistentAxStatuses
      },
      processAttribution: {
        directDoctorProcesses: [
          { process: sourceDoctor.processChain, responsiblePid: sourceDoctor.responsiblePid },
          { process: compiledDoctor.processChain, responsiblePid: compiledDoctor.responsiblePid },
          { process: symlinkDoctor.processChain, responsiblePid: symlinkDoctor.responsiblePid }
        ],
        responsibleProcesses: Array.from(new Set(
          [sourceDoctor, compiledDoctor, symlinkDoctor]
            .map((result) => result.responsiblePid)
            .filter((pid): pid is number => pid !== null)
        )).map((pid) => ({ pid, identity: readProcessIdentity(pid) })),
        status: "bounded ps PID/PPID chain plus libSystem responsible-PID lookup",
        tccConclusion: "doctor permissions describe the process that made the check. Persistent host/driver attribution is separately observed under persistentSession. Neither result is a TCC database, revocation, or fresh-machine proof."
      }
    };
    writeFileSync(join(evidenceDir, "status.json"), JSON.stringify(status, null, 2));
    console.log(JSON.stringify(status));
  } finally {
    if (!preserveTempRoot) rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
