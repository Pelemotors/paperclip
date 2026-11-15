import type { QuotaWindow } from "./quota.js";

export interface ProviderOperationalObservation {
  provider: string;
  profile: string;
  accountBindingKey: string;
  configuredModel: string | null;
  lastObservedModel: string | null;
  modelEvidenceRunId: string | null;
  executionMode: "subscription" | "local" | "api" | "unknown";
  authStatus: "ready" | "missing" | "expired" | "unknown" | "not_required";
  executionAllowedByPreflight: boolean | null;
  blockingReasons: string[];
  windows: QuotaWindow[];
  extraUsageEnabled: boolean | null;
  paidCreditsAllowed: boolean;
  capturedAt: string | null;
  source: string;
  stale: boolean;
  error: { code: string; message: string } | null;
}

export interface OperatingContextAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  adapterType: string;
  profile: string | null;
  configuredModel: string | null;
  lastObservedModel: string | null;
  modelEvidenceRunId: string | null;
  executionMode: ProviderOperationalObservation["executionMode"];
  authStatus: ProviderOperationalObservation["authStatus"];
  executionAllowedByPreflight: boolean | null;
  blockingReasons: string[];
  permissions: {
    canCreateAgents: boolean;
    canAssignTasks: boolean;
    activeGrants: Array<{ capability: string; expiresAt: string | null }>;
  };
  observation: ProviderOperationalObservation | null;
}

export interface OperatingContextUsage {
  measured: {
    eventCount: number;
    runCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  estimatedListCostUsd: number | null;
  recordedIncrementalCostUsd: number | null;
  invoiceVerifiedBillingUsd: number | null;
  invoiceVerifiedEventCount: number;
  unknownCostEventCount: number;
  source: string;
}

export interface OperatingContextTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  updatedAt: string;
}

export interface OperatingContextRun {
  id: string;
  agentId: string;
  status: string;
  provider: string | null;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface OperatingContext {
  snapshotId: string;
  capturedAt: string;
  companyId: string;
  source: string;
  agents: OperatingContextAgent[];
  tasks: {
    active: OperatingContextTask[];
    blocked: OperatingContextTask[];
  };
  lastRuns: OperatingContextRun[];
  usage: OperatingContextUsage;
  limitations: string[];
}
