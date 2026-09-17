#!/usr/bin/env bun
// Opt-in native AX form acceptance runner.
//
// The default invocation is a guard-only report. A native run requires both
// --allow-native and --test-desktop <label>; this makes an accidental run on
// the operator's desktop fail before the fixture or the SDK is started.
//
// The runner starts the checked-in fixture, observes one AX snapshot (complete
// or the fixture's equal-count incomplete projection), writes all three fields
// through Computer.setValue, observes the values back, and presses the submit
// button through the product's token click path. The fixture control file
// accepts only {"quit":true}; it cannot provide field values or input commands.
// AX observations are the primary form evidence; state.json is retained only
// as auxiliary fixture/lifecycle evidence.
//
// Native usage (only on a separately authorized test desktop):
//   bun scripts/probes/computer-use-ax-form.ts \
//     --allow-native --test-desktop isolated --out-dir /private/tmp/yk-ax-form

import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { AxElement, Observation, Target } from "@ya-skills/computer-runtime";

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_VALUES = {
  name: "Ada Lovelace",
  email: "ada@example.test",
  message: "AX form submission"
} as const;

export type FieldName = keyof typeof DEFAULT_VALUES;

export type AxFormRequest =
  | { kind: "guarded"; reason: string }
  | {
      kind: "native";
      allowNative: true;
      desktopLabel: string;
      outDir: string;
      fixtureSource: string;
      fixtureBinary?: string;
      timeoutMs: number;
    }
  | { kind: "invalid"; reason: string };

interface FixtureState {
  schemaVersion?: number;
  pid?: number;
  windowId?: number | string;
  initialFrontmostPid?: number;
  frontmostPid?: number;
  isKeyWindow?: boolean;
  isMainWindow?: boolean;
  isOnActiveSpace?: boolean;
  ignoresMouseEvents?: boolean;
  initialMouseX?: number;
  initialMouseY?: number;
  mouseX?: number;
  mouseY?: number;
  sampledPointerChanged?: boolean;
  firstResponderClass?: string;
  submitCount?: number;
  result?: string;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

interface FixtureProcess {
  child: ChildProcess;
  exited: Promise<number>;
  stderr: string;
}

type Runtime = typeof import("@ya-skills/computer-runtime");
type ComputerSession = import("@ya-skills/computer-runtime").ComputerSession;

export interface AxFormReport {
  schemaVersion: 1;
  probe: "computer-use-ax-form";
  mode: "guarded" | "native";
  status: "skipped" | "passed" | "failed";
  driverStarted: boolean;
  fixtureStarted: boolean;
  nativeActionsAttempted: boolean;
  /** The submit facade currently does not expose the SDK route. */
  inputIsolation: "not_attempted" | "unverified";
  desktopInputSent: "not_attempted" | "unknown";
  reason?: string;
  testDesktop?: string;
  outDir?: string;
  target?: { pid: number; windowId: string };
  initialState?: Record<string, unknown>;
  observations?: {
    initial?: string;
    afterWrites?: string;
    final?: string;
  };
  setValue?: Array<{
    field: FieldName;
    route: "accessibility";
    effect: "confirmed";
    delivery?: unknown;
  }>;
  submit?: {
    outcome: "delivered";
    route: "unavailable";
    postcondition: "submitted";
  };
  finalState?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
  cleanup?: {
    sessionClosed: boolean;
    fixtureQuitRequested: boolean;
    fixtureExitCode?: number | null;
    forcedTermination?: boolean;
    stderr?: string;
  };
}

function usage(): string {
  return [
    "AX form acceptance runner (guarded by default)",
    "  no flags                         print a no-native guard report",
    "  --allow-native                   enable the native flow",
    "  --test-desktop LABEL             required acknowledgement of a reserved test desktop",
    "  --out-dir DIR                    new artifact directory (must not exist)",
    "  --fixture-source FILE             AppKit fixture source (default: checked-in fixture)",
    "  --fixture-binary FILE             use a precompiled fixture instead of swiftc",
    `  --timeout-ms N                   per-step budget, 1..${MAX_TIMEOUT_MS}ms`,
    "  --help                           show this text",
    "",
    "The native flow must run in a separately authorized test desktop. It never",
    "uses activate, type, key, scroll, coordinates, or a fixture-side value command."
  ].join("\n");
}

function parsePositiveInt(value: string, flag: string): number | string {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return `${flag} expects a positive integer, got: ${value}`;
  }
  return number;
}

function takeValue(argv: string[], index: number, flag: string): { value?: string; next: number; error?: string } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return { next: index, error: `${flag} expects a value` };
  }
  return { value, next: index + 1 };
}

/** Pure argument guard used by the default desktop-free test suite. */
export function parseAxFormArgs(argv: string[]): AxFormRequest {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "guarded", reason: usage() };

  let allowNative = false;
  let desktopLabel: string | undefined;
  let outDir: string | undefined;
  let fixtureSource = resolve(import.meta.dir, "fixtures/computer-use-ax-form.swift");
  let fixtureBinary: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let nativeOptionSeen = false;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--allow-native") {
      if (allowNative) return { kind: "invalid", reason: "--allow-native was given twice" };
      allowNative = true;
      nativeOptionSeen = true;
      continue;
    }
    if (flag === "--test-desktop") {
      const taken = takeValue(argv, index, flag);
      if (taken.error) return { kind: "invalid", reason: taken.error };
      if (desktopLabel !== undefined) return { kind: "invalid", reason: "--test-desktop was given twice" };
      desktopLabel = taken.value!.trim();
      if (desktopLabel === "") return { kind: "invalid", reason: "--test-desktop requires a non-empty label" };
      nativeOptionSeen = true;
      index = taken.next;
      continue;
    }
    if (flag === "--out-dir") {
      const taken = takeValue(argv, index, flag);
      if (taken.error) return { kind: "invalid", reason: taken.error };
      if (outDir !== undefined) return { kind: "invalid", reason: "--out-dir was given twice" };
      outDir = resolve(taken.value!);
      nativeOptionSeen = true;
      index = taken.next;
      continue;
    }
    if (flag === "--fixture-source") {
      const taken = takeValue(argv, index, flag);
      if (taken.error) return { kind: "invalid", reason: taken.error };
      if (fixtureSource !== resolve(import.meta.dir, "fixtures/computer-use-ax-form.swift")) {
        return { kind: "invalid", reason: "--fixture-source was given twice" };
      }
      fixtureSource = resolve(taken.value!);
      nativeOptionSeen = true;
      index = taken.next;
      continue;
    }
    if (flag === "--fixture-binary") {
      const taken = takeValue(argv, index, flag);
      if (taken.error) return { kind: "invalid", reason: taken.error };
      if (fixtureBinary !== undefined) return { kind: "invalid", reason: "--fixture-binary was given twice" };
      fixtureBinary = resolve(taken.value!);
      nativeOptionSeen = true;
      index = taken.next;
      continue;
    }
    if (flag === "--timeout-ms") {
      const taken = takeValue(argv, index, flag);
      if (taken.error) return { kind: "invalid", reason: taken.error };
      const parsed = parsePositiveInt(taken.value!, flag);
      if (typeof parsed === "string") return { kind: "invalid", reason: parsed };
      if (parsed > MAX_TIMEOUT_MS) return { kind: "invalid", reason: `--timeout-ms must be <= ${MAX_TIMEOUT_MS}` };
      timeoutMs = parsed;
      nativeOptionSeen = true;
      index = taken.next;
      continue;
    }
    return { kind: "invalid", reason: `unknown flag: ${flag}` };
  }

  if (!allowNative) {
    if (nativeOptionSeen) {
      return { kind: "invalid", reason: "native options require --allow-native; no fixture or SDK was started" };
    }
    return { kind: "guarded", reason: "native AX form flow is opt-in; pass --allow-native --test-desktop LABEL" };
  }
  if (desktopLabel === undefined) {
    return { kind: "invalid", reason: "--allow-native requires --test-desktop LABEL" };
  }
  return {
    kind: "native",
    allowNative: true,
    desktopLabel,
    outDir: outDir ?? join(tmpdir(), `yk-ax-form-${Date.now()}-${process.pid}`),
    fixtureSource,
    ...(fixtureBinary !== undefined ? { fixtureBinary } : {}),
    timeoutMs
  };
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function json(value: unknown): string {
  return JSON.stringify(value, replacer, 2) + "\n";
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, json(value), { mode: 0o600 });
  await chmod(path, 0o600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalize(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function asState(value: unknown): FixtureState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fixture state is not a JSON object");
  }
  return value as FixtureState;
}

async function readState(path: string): Promise<FixtureState> {
  return asState(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function stateSummary(state: FixtureState): Record<string, unknown> {
  return {
    schemaVersion: state.schemaVersion,
    pid: state.pid,
    windowId: state.windowId === undefined ? undefined : String(state.windowId),
    initialFrontmostPid: state.initialFrontmostPid,
    frontmostPid: state.frontmostPid,
    isKeyWindow: state.isKeyWindow,
    isMainWindow: state.isMainWindow,
    isOnActiveSpace: state.isOnActiveSpace,
    ignoresMouseEvents: state.ignoresMouseEvents,
    initialMouseX: state.initialMouseX,
    initialMouseY: state.initialMouseY,
    mouseX: state.mouseX,
    mouseY: state.mouseY,
    sampledPointerChanged: state.sampledPointerChanged,
    firstResponderClass: state.firstResponderClass,
    submitCount: state.submitCount,
    result: state.result,
    fields: state.fields
  };
}

function validateStateForIsolation(state: FixtureState): void {
  if (!Number.isSafeInteger(state.pid) || state.pid! <= 0) throw new Error("fixture state has no valid pid");
  if (state.windowId === undefined || !/^\d+$/.test(String(state.windowId))) {
    throw new Error("fixture state has no valid window id");
  }
  if (state.isKeyWindow !== false || state.isMainWindow !== false) {
    throw new Error("fixture became key or main; refusing native form actions");
  }
  if (state.ignoresMouseEvents !== true) {
    throw new Error("fixture does not have ignoresMouseEvents=true; refusing native form actions");
  }
  if (
    !Number.isSafeInteger(state.initialFrontmostPid) ||
    !Number.isSafeInteger(state.frontmostPid) ||
    state.initialFrontmostPid !== state.frontmostPid
  ) {
    throw new Error("fixture changed the frontmost application before form actions");
  }
}

async function waitForState(
  path: string,
  timeoutMs: number,
  fixture?: FixtureProcess,
  predicate: (state: FixtureState) => boolean = () => true
): Promise<FixtureState> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "state.json is not ready";
  for (;;) {
    try {
      const state = await readState(path);
      if (predicate(state)) return state;
      lastError = "state predicate is not satisfied";
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (fixture?.child.exitCode !== null && fixture?.child.exitCode !== undefined) {
      throw new Error(`fixture exited before state was ready (code ${fixture.child.exitCode})`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for fixture state: ${lastError}`);
    await sleep(25);
  }
}

function runExternal(command: string, args: string[], timeoutMs: number): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (value: { exitCode: number | null; timedOut: boolean }): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ ...value, stderr });
    };
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192 - stderr.length);
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      }
    });
    child.once("exit", (code) => finish({ exitCode: code ?? 1, timedOut: false }));
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: null, timedOut: true });
    }, Math.max(1, timeoutMs));
  });
}

async function compileFixture(request: Extract<AxFormRequest, { kind: "native" }>): Promise<string> {
  if (request.fixtureBinary !== undefined) {
    const info = await stat(request.fixtureBinary);
    if (!info.isFile()) throw new Error(`fixture binary is not a file: ${request.fixtureBinary}`);
    return request.fixtureBinary;
  }
  const binary = join(request.outDir, "computer-use-ax-form-fixture");
  const cache = join(request.outDir, "swift-module-cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const result = await runExternal("swiftc", [
    "-module-cache-path",
    cache,
    "-warnings-as-errors",
    request.fixtureSource,
    "-o",
    binary
  ], request.timeoutMs);
  if (result.timedOut) throw new Error(`swift fixture compilation timed out after ${request.timeoutMs}ms`);
  if (result.exitCode !== 0) {
    throw new Error(`swift fixture compilation failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return binary;
}

function startFixture(binary: string, outDir: string): FixtureProcess {
  const child = spawn(binary, [outDir], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<number>((resolvePromise) => {
    child.once("error", () => resolvePromise(127));
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
  const fixture: FixtureProcess = { child, exited, stderr: "" };
  child.stderr?.on("data", (chunk: Buffer | string) => {
    if (fixture.stderr.length < 8_192) {
      fixture.stderr += String(chunk).slice(0, 8_192 - fixture.stderr.length);
    }
  });
  return fixture;
}

async function stopFixture(fixture: FixtureProcess, outDir: string, timeoutMs: number): Promise<{
  quitRequested: boolean;
  exitCode: number | null;
  forced: boolean;
}> {
  let quitRequested = false;
  try {
    await writeFile(join(outDir, "control.json"), json({ quit: true }), { mode: 0o600 });
    quitRequested = true;
  } catch {
    // The fixture may have failed before its output directory was usable.
  }
  let forced = false;
  let exitCode: number | null = null;
  const completed = await Promise.race([
    fixture.exited.then((code) => code),
    sleep(Math.max(1, timeoutMs)).then(() => null)
  ]);
  if (completed === null) {
    forced = true;
    fixture.child.kill("SIGTERM");
    const terminated = await Promise.race([
      fixture.exited.then((code) => code),
      sleep(Math.min(2_000, Math.max(1, timeoutMs))).then(() => null)
    ]);
    if (terminated === null) {
      fixture.child.kill("SIGKILL");
      exitCode = await fixture.exited;
    } else {
      exitCode = terminated;
    }
  } else {
    exitCode = completed;
  }
  return { quitRequested, exitCode, forced };
}

function targetFromState(state: FixtureState): Target {
  return { pid: state.pid!, windowId: BigInt(String(state.windowId)) };
}

function findUnique(elements: AxElement[], label: string, role: string): AxElement {
  const matches = elements.filter((element) => normalize(element.label) === label && element.role === role);
  if (matches.length !== 1) throw new Error(`expected exactly one ${role} labelled ${label}, found ${matches.length}`);
  const element = matches[0]!;
  if (element.elementToken === undefined || element.elementToken.trim() === "") {
    throw new Error(`${role} labelled ${label} has no AX element token`);
  }
  return element;
}

/**
 * The checked-in fixture can expose an indexed AX projection with
 * `elementsComplete=false` while returning every indexed element. That
 * projection is useful for this fixture's positive value checks, but it is
 * not a claim that the whole AX tree is complete.
 */
export function assertFixtureAxObservation(observation: Observation): void {
  const ax = observation.ax;
  if (ax.status === "usable" && ax.reason === undefined) return;
  if (ax.status === "truncated" && ax.reason === "elements_incomplete" && ax.total === ax.returned) return;
  const reason = ax.reason === undefined ? "no reason" : `reason=${ax.reason}`;
  throw new Error(`AX observation is not acceptable for the fixture: status=${ax.status}, ${reason}, total=${ax.total}, returned=${ax.returned}`);
}

export function readAxFormValues(observation: Observation): Record<FieldName, string> {
  assertFixtureAxObservation(observation);
  return {
    name: findUnique(observation.ax.elements, "Name", "AXTextField").value ?? "",
    email: findUnique(observation.ax.elements, "Email", "AXTextField").value ?? "",
    message: findUnique(observation.ax.elements, "Message", "AXTextField").value ?? ""
  };
}

/** The SDK reports this selectable read-only fixture control as AXStaticText. */
export function readAxFormResult(observation: Observation): string {
  assertFixtureAxObservation(observation);
  return findUnique(observation.ax.elements, "AX form result", "AXStaticText").value ?? "";
}


function ensureExpectedFields(values: Record<FieldName, string>): void {
  for (const field of Object.keys(DEFAULT_VALUES) as FieldName[]) {
    if (values[field] !== DEFAULT_VALUES[field]) {
      throw new Error(`AX value mismatch for ${field}: expected ${JSON.stringify(DEFAULT_VALUES[field])}, got ${JSON.stringify(values[field])}`);
    }
  }
}

async function waitForAx(
  computer: ComputerSession["computer"],
  target: Target,
  timeoutMs: number,
  predicate: (observation: Observation) => boolean
): Promise<Observation> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "AX predicate is not satisfied";
  for (;;) {
    const observation = await computer.observe(target, { mode: "ax" });
    // Reject a degraded or explicitly truncated observation immediately. The
    // only accepted partial view is the fixture-specific equal-count
    // `elements_incomplete` projection above.
    assertFixtureAxObservation(observation);
    try {
      if (predicate(observation)) return observation;
      lastError = "AX predicate is not satisfied";
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for AX state: ${lastError}`);
    await sleep(50);
  }
}

async function createOwnedDirectory(path: string): Promise<void> {
  // The runner never changes permissions or contents of a caller-owned path.
  // The final component must be created exclusively for this run.
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

function actionEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.map((event) => ({ ...event }));
}

export async function runAxForm(request: Extract<AxFormRequest, { kind: "native" }>): Promise<AxFormReport> {
  const report: AxFormReport = {
    schemaVersion: 1,
    probe: "computer-use-ax-form",
    mode: "native",
    status: "failed",
    driverStarted: false,
    fixtureStarted: false,
    nativeActionsAttempted: false,
    inputIsolation: "not_attempted",
    desktopInputSent: "not_attempted",
    testDesktop: request.desktopLabel,
    outDir: request.outDir,
    observations: {},
    setValue: [],
    actions: []
  };
  const observations = report.observations!;
  let fixture: FixtureProcess | undefined;
  let session: ComputerSession | undefined;
  let sessionClosed = false;
  let ownedOutDir = false;
  let fixtureCleanup: { quitRequested: boolean; exitCode: number | null; forced: boolean } | undefined;
  const events: Array<Record<string, unknown>> = [];

  try {
    await createOwnedDirectory(request.outDir);
    ownedOutDir = true;
    const binary = await compileFixture(request);
    fixture = startFixture(binary, request.outDir);
    report.fixtureStarted = true;
    const statePath = join(request.outDir, "state.json");
    const initialState = await waitForState(statePath, request.timeoutMs, fixture);
    validateStateForIsolation(initialState);
    report.initialState = stateSummary(initialState);
    await saveJson(join(request.outDir, "state-before.json"), initialState);
    const target = targetFromState(initialState);
    report.target = { pid: target.pid, windowId: target.windowId.toString() };

    const runtime: Runtime = await import("@ya-skills/computer-runtime");
    const artifactsDir = request.outDir;
    const observationStore = runtime.createObservationStore(join(artifactsDir, "observations"));
    session = runtime.createComputerSession({
      artifactsDir,
      observationStore,
      onAction: (event) => events.push({ ...event })
    });

    report.driverStarted = true;
    const initialObservation = await session.computer.observe(target, { mode: "ax" });
    // Persist the exact projection before validating it. A degraded or
    // incomplete first read must remain available as failure evidence.
    observations.initial = "observation-initial.json";
    await saveJson(join(request.outDir, observations.initial), initialObservation);
    readAxFormValues(initialObservation);

    const tokens = {
      name: findUnique(initialObservation.ax.elements, "Name", "AXTextField").elementToken!,
      email: findUnique(initialObservation.ax.elements, "Email", "AXTextField").elementToken!,
      message: findUnique(initialObservation.ax.elements, "Message", "AXTextField").elementToken!
    } satisfies Record<FieldName, string>;

    // Set the conservative isolation status before the first mutation can
    // cross the product/native boundary. If a later failure is unknown, the
    // report cannot incorrectly say that no native action was attempted.
    report.nativeActionsAttempted = true;
    report.inputIsolation = "unverified";
    report.desktopInputSent = "unknown";
    for (const field of Object.keys(DEFAULT_VALUES) as FieldName[]) {
      const result = await session.computer.setValue(target, tokens[field], DEFAULT_VALUES[field]);
      if (result.route !== "accessibility" || result.effect !== "confirmed") {
        throw new Error(`setValue returned an unconfirmed result for ${field}`);
      }
      report.setValue!.push({ field, route: result.route, effect: result.effect, ...(result.delivery ? { delivery: result.delivery } : {}) });
      const writeState = await waitForState(statePath, request.timeoutMs, fixture);
      validateStateForIsolation(writeState);
    }
    // All three writes have an explicit AX route proof. The remaining submit
    // action is the path whose route is not exposed by Computer.click. Keep
    // the conservative unknown state through the rest of the native flow.

    const afterWrites = await waitForAx(session.computer, target, request.timeoutMs, (observation) => {
      try {
        ensureExpectedFields(readAxFormValues(observation));
        return true;
      } catch {
        return false;
      }
    });
    observations.afterWrites = "observation-after-writes.json";
    await saveJson(join(request.outDir, observations.afterWrites), afterWrites);
    ensureExpectedFields(readAxFormValues(afterWrites));
    const afterWriteState = await waitForState(statePath, request.timeoutMs, fixture);
    validateStateForIsolation(afterWriteState);
    await saveJson(join(request.outDir, "state-after-writes.json"), afterWriteState);

    // `Computer.click` performs an exact fresh AX lookup internally. The
    // current facade returns only delivery outcome, so submit route is kept as
    // unavailable in the report; this runner never calls a coordinate or
    // keyboard fallback and does not claim a pre-dispatch AX-only guarantee.
    report.inputIsolation = "unverified";
    report.desktopInputSent = "unknown";
    await session.computer.click(
      target,
      (element) => element.role === "AXButton" && normalize(element.label) === "Submit AX form",
      "AX submit button"
    );

    const finalObservation = await waitForAx(session.computer, target, request.timeoutMs, (observation) => {
      try {
        ensureExpectedFields(readAxFormValues(observation));
        return readAxFormResult(observation) === "submitted";
      } catch {
        return false;
      }
    });
    observations.final = "observation-final.json";
    await saveJson(join(request.outDir, observations.final), finalObservation);
    ensureExpectedFields(readAxFormValues(finalObservation));
    const resultValue = readAxFormResult(finalObservation);
    if (resultValue !== "submitted") throw new Error(`unexpected AX submit result: ${resultValue || "(empty)"}`);

    const finalState = await waitForState(
      statePath,
      request.timeoutMs,
      fixture,
      (state) => state.result === "submitted" && state.submitCount === 1
    );
    validateStateForIsolation(finalState);
    report.finalState = stateSummary(finalState);
    await saveJson(join(request.outDir, "state-final.json"), finalState);
    report.submit = { outcome: "delivered", route: "unavailable", postcondition: "submitted" };
    report.status = "passed";
  } catch (error) {
    report.reason = errorMessage(error);
  } finally {
    if (session !== undefined) {
      try {
        await session.close();
        sessionClosed = true;
      } catch (error) {
        report.reason ??= `session cleanup failed: ${errorMessage(error)}`;
      }
    }
    if (fixture !== undefined) {
      fixtureCleanup = await stopFixture(fixture, request.outDir, Math.min(5_000, request.timeoutMs)).catch(() => ({
        quitRequested: false,
        exitCode: fixture!.child.exitCode,
        forced: true
      }));
    }
    report.actions = actionEvents(events);
    report.cleanup = {
      sessionClosed,
      fixtureQuitRequested: fixtureCleanup?.quitRequested ?? false,
      fixtureExitCode: fixtureCleanup?.exitCode,
      forcedTermination: fixtureCleanup?.forced,
      ...(fixture?.stderr ? { stderr: fixture.stderr.slice(0, 8_192) } : {})
    };
    if (report.status === "passed" && (report.cleanup.sessionClosed !== true || report.cleanup.forcedTermination === true)) {
      report.status = "failed";
      report.reason ??= "native cleanup was not clean";
    }
    // If exclusive directory creation failed, this path is not ours. Never
    // overwrite a previous run's report or change its permissions.
    if (ownedOutDir) {
      try {
        await saveJson(join(request.outDir, "report.json"), report);
      } catch (error) {
        report.status = "failed";
        report.reason ??= `could not save report: ${errorMessage(error)}`;
      }
    }
  }
  return report;
}

function guardedReport(reason: string): AxFormReport {
  return {
    schemaVersion: 1,
    probe: "computer-use-ax-form",
    mode: "guarded",
    status: "skipped",
    driverStarted: false,
    fixtureStarted: false,
    nativeActionsAttempted: false,
    inputIsolation: "not_attempted",
    desktopInputSent: "not_attempted",
    reason
  };
}

async function main(): Promise<void> {
  const request = parseAxFormArgs(process.argv.slice(2));
  if (request.kind === "guarded") {
    console.log(json(guardedReport(request.reason)));
    return;
  }
  if (request.kind === "invalid") {
    console.error(request.reason);
    console.error(`\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  const report = await runAxForm(request);
  console.log(json(report));
  if (report.status !== "passed") process.exitCode = 1;
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
