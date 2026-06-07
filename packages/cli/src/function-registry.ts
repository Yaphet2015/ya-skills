import { createFunctionRegistry } from "@ya-skills/core";
import { createDemoCommands } from "@ya-skills/functions-demo";

export function createCliFunctionRegistry() {
  return createFunctionRegistry([...createDemoCommands()]);
}
