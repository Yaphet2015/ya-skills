import { createFunctionRegistry } from "@ya-skills/core";
import { createDemoCommands } from "@ya-skills/functions-demo";
import { createPbenchCommands } from "@ya-skills/functions-pbench";

export function createCliFunctionRegistry() {
  return createFunctionRegistry([...createDemoCommands(), ...createPbenchCommands()]);
}
