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
