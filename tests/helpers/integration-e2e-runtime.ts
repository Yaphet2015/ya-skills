import { join } from "node:path";
import type { CaseContext } from "../../packages/functions-computer-e2e/src/types.js";
import {
  createE2ELaneRuntimeFixture,
  type E2ELaneRuntimeFixture
} from "./e2e-lane-runtime.js";

/**
 * Reuse the production-runtime-backed fake driver fixture for integration
 * regressions. This is intentionally a thin context adapter: the tests still
 * enter through runSuite and ComputerSession rather than a proxy Computer.
 */
export { createE2ELaneRuntimeFixture, type E2ELaneRuntimeFixture };

export function integrationContextFor(fixture: E2ELaneRuntimeFixture): CaseContext {
  return {
    computer: fixture.session.computer,
    signal: new AbortController().signal,
    params: {},
    artifactsDir: join(fixture.root, "artifacts"),
    step: async <T>(_name: string, work: () => Promise<T>): Promise<T> => work(),
    skip: (reason: string): never => {
      throw new Error(`unexpected skip: ${reason}`);
    },
    setApplication: () => undefined,
    capture: async () => ({ elementsPath: "integration-e2e-elements.json" })
  };
}
