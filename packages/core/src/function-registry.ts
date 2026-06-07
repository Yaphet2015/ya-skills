import type { FunctionCommand, FunctionRegistry } from "./types.js";

export function createFunctionRegistry(commands: FunctionCommand[]): FunctionRegistry {
  const byCommand = new Map(commands.map((command) => [`${command.domain} ${command.action}`, command]));

  return {
    list() {
      return commands;
    },
    async run(domain, action, args) {
      const command = byCommand.get(`${domain} ${action}`);
      if (!command) {
        throw new Error(`Unknown function command: ${domain} ${action}`);
      }
      return command.run(args);
    }
  };
}
