// The three public commands. run wires process signals into the supervisor
// (130/143 preserved), history/report only read files, and none of them load
// the SDK on help/parse-error paths.

import type { FunctionCommand } from "@ya-skills/core";
import { E2E_HISTORY_USAGE, E2E_REPORT_USAGE, E2E_RUN_USAGE, parseE2EArgs } from "./args.js";
import { formatReport, readHistory, readRun } from "./history.js";
import { supervise } from "./supervisor.js";

export function createComputerE2ECommands(): FunctionCommand[] {
  const domain = "computer-e2e";
  return [
    {
      domain,
      action: "run",
      description:
        "Run explicit .e2e.ts suites sequentially; each suite runs in a self-spawned worker with events.jsonl as the single source of truth.",
      usage: [E2E_RUN_USAGE],
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
      description: "List recorded runs as JSON, newest first.",
      usage: [E2E_HISTORY_USAGE],
      run: async (args: string[]) => {
        const request = parseE2EArgs("history", args);
        return JSON.stringify(await readHistory(request.outDir, request.limit), null, 2);
      }
    },
    {
      domain,
      action: "report",
      description: "Render one run's Markdown report from its recorded events.",
      usage: [E2E_REPORT_USAGE],
      run: async (args: string[]) => {
        const request = parseE2EArgs("report", args);
        return formatReport(readRun(request.runDir));
      }
    }
  ];
}
