import type { FunctionCommand } from "@ya-skills/core";

export function createDemoCommands(): FunctionCommand[] {
  return [
    {
      domain: "demo",
      action: "echo",
      description: "Print the provided arguments.",
      run: (args) => args.join(" ")
    }
  ];
}
