import { expect, test } from "bun:test";
import { createFunctionRegistry } from "@ya-skills/core";
import { createDemoCommands } from "@ya-skills/functions-demo";
import { createPbenchCommands } from "@ya-skills/functions-pbench";

test("dispatches an underlying function by domain and action", async () => {
  const registry = createFunctionRegistry(createDemoCommands());

  const output = await registry.run("demo", "echo", ["hello", "skills"]);

  expect(output).toBe("hello skills");
});

test("keeps a yk domain in its own package", () => {
  const commands = createDemoCommands();

  expect(commands.map((command) => `${command.domain} ${command.action}`)).toEqual(["demo echo"]);
});

test("fails loudly for unknown underlying functions", async () => {
  const registry = createFunctionRegistry(createDemoCommands());

  await expect(registry.run("missing", "echo", [])).rejects.toThrow(
    "Unknown function command: missing echo"
  );
});

test("keeps pbench authoring commands in their own function package", () => {
  const commands = createPbenchCommands();

  expect(commands.map((command) => `${command.domain} ${command.action}`)).toEqual([
    "pbench capture",
    "pbench validate",
    "pbench export-replay",
    "pbench run",
    "pbench start",
    "pbench finish",
    "pbench finalize",
    "pbench workspace-init",
    "pbench project-link"
  ]);
});
