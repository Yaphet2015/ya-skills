import { join } from "node:path";
import {
  createAutoLeases,
  createComputerSession,
  createObservationStore,
  defaultArtifactsDir,
  type ComputerSession,
  type MutationLeases
} from "@ya-skills/computer-runtime";
import { sessionRoot } from "@ya-skills/computer-session";

export type CreateSession = (options: { deadlineAt?: number; artifactsDir?: string }) => ComputerSession;
export type TimedCreateSession = (options: { deadlineAt: number; artifactsDir?: string }) => ComputerSession;

/** Build the one-shot session used by observe, act, and batch commands. */
export function createDefaultSessionFactory(factoryOptions: { leases?: MutationLeases } = {}): CreateSession {
  return (sessionOptions) => {
    const artifactsDir = sessionOptions.artifactsDir ?? defaultArtifactsDir();
    return createComputerSession({
      ...sessionOptions,
      artifactsDir,
      observationStore: createObservationStore(join(artifactsDir, "observations")),
      leases: factoryOptions.leases ?? createAutoLeases(sessionRoot(), "single-step")
    });
  };
}
