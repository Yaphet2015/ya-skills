import { expect, test } from "bun:test";
import { createFunctionRegistry } from "../src/functions.js";

test("dispatches an underlying function by domain and action", async () => {
  const registry = createFunctionRegistry();

  const output = await registry.run("demo", "echo", ["hello", "skills"]);

  expect(output).toBe("hello skills");
});

test("fails loudly for unknown underlying functions", async () => {
  const registry = createFunctionRegistry();

  await expect(registry.run("missing", "echo", [])).rejects.toThrow(
    "Unknown function command: missing echo"
  );
});
