// The e2e worker: loads ONE external suite file, builds the CaseContext over
// a lazy shared session, and streams control events on fd3. The parent owns
// events.jsonl; stdout/stderr are logs, never protocol.

import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createComputerSession,
  saveScreenshot,
  type ComputerSession,
  type Target
} from "@ya-skills/computer-runtime";
import { exitCodeFor, runSuite, validateSuite } from "./suite.js";
import type { CaseContext, WorkerEvent } from "./types.js";

export interface WorkerConfig {
  file: string; // absolute path to the external suite file
  runId: string;
  artifactsDir: string; // absolute, inside the run directory
  params: Record<string, string>;
}

function emit(event: WorkerEvent): void {
  try {
    writeSync(3, `${JSON.stringify(event)}\n`);
  } catch {
    // fd3 exists only under the supervisor; standalone runs just log.
  }
}

export async function workerMain(config: WorkerConfig): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  let exitCode = 1;
  if (!isAbsolute(config.file)) {
    emit({ type: "suite_collected", payload: { file: config.file, loadError: "worker config file path must be absolute" } });
    return 1;
  }

  mkdirSync(config.artifactsDir, { recursive: true, mode: 0o700 });
  const runDir = dirname(config.artifactsDir);
  const relFromRun = (abs: string): string => relative(runDir, abs);

  const session: ComputerSession = createComputerSession({
    signal: controller.signal,
    onRuntime: (info) => emit({ type: "runtime", payload: { sdkVersion: info.driverVersion } }),
    onAction: (event) => {
      if (event.phase === "started") {
        emit({ type: "action_started", payload: { kind: event.kind } });
      } else {
        emit({
          type: "action_finished",
          payload: { kind: event.kind, outcome: event.outcome ?? "unknown" }
        });
      }
    }
  });

  const run = async (): Promise<number> => {
    // Load + validate BEFORE any hook runs.
    let suite;
    try {
      const mod = (await import(pathToFileURL(config.file).href)) as { default: unknown };
      suite = validateSuite(mod.default);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "suite_collected", payload: { file: config.file, loadError: message } });
      return 1;
    }

    const context: CaseContext = {
      computer: session.computer,
      signal: controller.signal,
      params: config.params,
      artifactsDir: config.artifactsDir,
      step: () => {
        throw new Error("ctx.step is wired by the runner");
      },
      skip: () => {
        throw new Error("ctx.skip is wired by the runner");
      },
      setApplication: (info) => emit({ type: "application", payload: { ...info } }),
      capture: async (target: Target, name: string) => {
        const snap = await session.computer.snapshot(target, { screenshot: true });
        const elementsFile = join(config.artifactsDir, `${Date.now()}-${name}.elements.json`);
        writeFileSync(elementsFile, JSON.stringify(snap.elements, null, 2), { mode: 0o600 });
        const paths: { elementsPath: string; screenshotPath?: string } = {
          elementsPath: relFromRun(elementsFile)
        };
        emit({ type: "artifact", payload: { path: paths.elementsPath } });
        if (snap.imageBase64) {
          const shot = saveScreenshot(config.artifactsDir, snap.imageBase64);
          paths.screenshotPath = relFromRun(shot);
          emit({ type: "artifact", payload: { path: paths.screenshotPath } });
        }
        return paths;
      }
    };

    const result = await runSuite(suite, context, (event) => {
      // The worker adds the file to every payload and normalizes case ids.
      const p = event.payload as Record<string, unknown>;
      if (event.type === "case_started" || event.type === "case_finished") {
        emit({ type: event.type, payload: { file: config.file, id: p.caseId, ...p } });
      } else {
        emit({ type: event.type, payload: { file: config.file, ...p } });
      }
    });
    return exitCodeFor(result);
  };

  try {
    exitCode = await run();
  } catch (error) {
    console.error(`[worker] suite crashed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  try {
    await session.close();
  } catch (error) {
    // Cleanup failures must not turn a passing run into a silent pass.
    console.error(`[worker] session cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  return exitCode;
}

export function runWorkerFromConfig(configPath: string): Promise<number> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as WorkerConfig;
  return workerMain(config);
}
