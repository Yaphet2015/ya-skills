import type { FunctionCommand } from "@ya-skills/core";
import { parseRequest } from "./args.js";
import { runDoctor } from "./runtime.js";

// Commands own validation and orchestration only; driver lifecycle lives in
// runtime.ts, observation in observe.ts, actions in act.ts. run() returns a
// JSON string on success (printed by the CLI); errors propagate as Error and
// the CLI maps them to exit 1.

export function createComputerUseCommands(): FunctionCommand[] {
  const domain = "computer-use";
  return [
    {
      domain,
      action: "doctor",
      description: "Check platform, runtime files, driver load, and read-only permission status.",
      run: async () => {
        const report = await runDoctor();
        const json = JSON.stringify(report, null, 2);
        if (!report.ok) {
          throw new Error(`doctor found problems:\n${json}`);
        }
        return json;
      }
    },
    {
      domain,
      action: "apps",
      description: "List running apps (pid, name) with optional --name substring filter.",
      run: (args) => {
        parseRequest("apps", args);
        return "apps: not implemented yet";
      }
    },
    {
      domain,
      action: "windows",
      description: "List windows for a --pid (windowId as decimal string, title).",
      run: (args) => {
        parseRequest("windows", args);
        return "windows: not implemented yet";
      }
    },
    {
      domain,
      action: "perceive",
      description: "Read AX elements (and optional screenshot) of a window for the next decision.",
      run: (args) => {
        parseRequest("perceive", args);
        return "perceive: not implemented yet";
      }
    },
    {
      domain,
      action: "act",
      description: "Perform one background action (click/type/key/scroll), then re-perceive.",
      run: (args) => {
        parseRequest("act", args);
        return "act: not implemented yet";
      }
    }
  ];
}
