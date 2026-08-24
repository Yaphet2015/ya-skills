export type JsonObject = Record<string, unknown>;

export type NormalizedSession = {
  meta: JsonObject;
  userMessages: string[];
  assistantMessages: string[];
  toolCalls: JsonObject[];
  errorRecords: JsonObject[];
  approvalSandboxRecords: JsonObject[];
  touchedFiles: string[];
  timeline: string[];
};

export type SessionSource = {
  id: string;
  sourceKind: string;
  locate(options: { cwd: string; sessionId?: string; home: string }): Promise<string>;
  extract(rawText: string): NormalizedSession;
};

export type AgentRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type AgentRunSummary = {
  lastMessage: string | null;
  tokenUsage: JsonObject | null;
  cost?: number | null;
};

export type AgentRunner = {
  id: string;
  defaultIsolation: "none" | "workspace-write";
  launch(options: {
    worktree: string;
    prompt: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }): AgentRunResult;
  parseSummary(stdout: string): AgentRunSummary;
  versionProbe(env: NodeJS.ProcessEnv): string | null;
};
