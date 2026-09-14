// The three public commands. run wires process signals into the supervisor
// (130/143 preserved), history/report only read files, and none of them load
// the SDK on help/parse-error paths.

import type { FunctionCommand } from "@ya-skills/core";
import { parseE2EArgs } from "./args.js";
import { formatReport, readHistory, readRun } from "./history.js";
import { supervise } from "./supervisor.js";

export function createComputerE2ECommands(): FunctionCommand[] {
  const domain = "computer-e2e";
  return [
    {
      domain,
      action: "run",
      description:
        "Run explicit .e2e.ts suites sequentially: yk computer-e2e run <file...> [--param k=v]... [--out-dir DIR] [--timeout-ms N] [--require-version V].",
      run: async (args: string[]) => {
        const request = parseE2EArgs("run", args);
        const controller = new AbortController();
        let interrupt: "SIGINT" | "SIGTERM" | null = null;
        const onInt = () => {
          if (!interrupt) {
            interrupt = "SIGINT";
            controller.abort();
          }
        };
        const onTerm = () => {
          if (!interrupt) {
            interrupt = "SIGTERM";
            controller.abort();
          }
        };
        process.once("SIGINT", onInt);
        process.once("SIGTERM", onTerm);
        let summary;
        try {
          summary = await supervise({
            files: request.files,
            params: request.params,
            outDir: request.outDir,
            timeoutMs: request.timeoutMs,
            ...(request.requireVersion !== undefined ? { requireVersion: request.requireVersion } : {}),
            stopSignal: controller.signal
          });
        } finally {
          process.removeListener("SIGINT", onInt);
          process.removeListener("SIGTERM", onTerm);
        }
        process.exitCode = interrupt ? (interrupt === "SIGINT" ? 130 : 143) : summary.exitCode;
        return JSON.stringify(summary, null, 2);
      }
    },
    {
      domain,
      action: "history",
      description: "List recorded runs as JSON: yk computer-e2e history [--out-dir DIR] [--limit N].",
      run: async (args: string[]) => {
        const request = parseE2EArgs("history", args);
        return JSON.stringify(await readHistory(request.outDir, request.limit), null, 2);
      }
    },
    {
      domain,
      action: "report",
      description: "Render one run's Markdown report: yk computer-e2e report <run-dir>.",
      run: async (args: string[]) => {
        const request = parseE2EArgs("report", args);
        return formatReport(readRun(request.runDir));
      }
    }
  ];
}
