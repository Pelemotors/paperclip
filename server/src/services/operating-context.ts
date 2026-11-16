import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { OperatingContext, OperatingContextAgent, OperatingContextRun, OperatingContextTask, ProviderOperationalObservation } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { costEvents, financeEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { agentService } from "./agents.js";
import { costService } from "./costs.js";

const OBSERVATION_CACHE_MS = 30_000;
const OBSERVATION_TIMEOUT_MS = 20_000;
const activeTaskStatuses = ["backlog", "todo", "in_progress", "in_review"] as const;

type ContextOptions = {
  from?: Date;
  to?: Date;
  workerId?: string;
  taskId?: string;
  profile?: string;
};

const observationCache = new Map<string, { expiresAt: number; value: Promise<ProviderOperationalObservation> }>();

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeObservation(value: ProviderOperationalObservation): ProviderOperationalObservation {
  return {
    provider: asString(value.provider) ?? "unknown",
    profile: asString(value.profile) ?? "unknown",
    accountBindingKey: asString(value.accountBindingKey) ?? "unknown",
    configuredModel: asString(value.configuredModel),
    lastObservedModel: asString(value.lastObservedModel),
    modelEvidenceRunId: asString(value.modelEvidenceRunId),
    executionMode: ["subscription", "local", "api", "unknown"].includes(value.executionMode) ? value.executionMode : "unknown",
    authStatus: ["ready", "missing", "expired", "unknown", "not_required"].includes(value.authStatus) ? value.authStatus : "unknown",
    executionAllowedByPreflight: typeof value.executionAllowedByPreflight === "boolean" ? value.executionAllowedByPreflight : null,
    blockingReasons: Array.isArray(value.blockingReasons) ? value.blockingReasons.filter(item => typeof item === "string").slice(0, 8) : [],
    windows: Array.isArray(value.windows) ? value.windows.slice(0, 12).map(window => ({
      label: asString(window.label) ?? "unknown",
      usedPercent: typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null,
      resetsAt: asString(window.resetsAt),
      valueLabel: asString(window.valueLabel),
      detail: asString(window.detail),
    })) : [],
    extraUsageEnabled: typeof value.extraUsageEnabled === "boolean" ? value.extraUsageEnabled : null,
    paidCreditsBlocked: value.paidCreditsBlocked === true,
    capturedAt: asString(value.capturedAt),
    source: asString(value.source) ?? "adapter",
    stale: value.stale === true,
    error: value.error && typeof value.error === "object"
      ? { code: asString(value.error.code) ?? "provider_unavailable", message: (asString(value.error.message) ?? "Provider observation unavailable").slice(0, 300) }
      : null,
  };
}

function unavailableObservation(agent: { adapterType: string; adapterConfig: Record<string, unknown> }, reason = "Adapter does not expose an operational observation") {
  return {
    provider: agent.adapterType,
    profile: typeof agent.adapterConfig.profile === "string" ? agent.adapterConfig.profile : "unknown",
    accountBindingKey: `${agent.adapterType}:unavailable`,
    configuredModel: null,
    lastObservedModel: null,
    modelEvidenceRunId: null,
    executionMode: "unknown" as const,
    authStatus: "unknown" as const,
    executionAllowedByPreflight: null,
    blockingReasons: [reason],
    windows: [],
    extraUsageEnabled: null,
    paidCreditsBlocked: false,
    capturedAt: new Date().toISOString(),
    source: "adapter",
    stale: false,
    error: { code: "unavailable", message: reason },
  } satisfies ProviderOperationalObservation;
}

async function observeAgent(agent: { companyId: string; id: string; adapterType: string; adapterConfig: Record<string, unknown> }, signal?: AbortSignal) {
  const adapter = findActiveServerAdapter(agent.adapterType);
  if (!adapter?.inspectOperationalStatus) return unavailableObservation(agent);
  const profile = typeof agent.adapterConfig.profile === "string" ? agent.adapterConfig.profile : "unknown";
  const cacheKey = `${agent.companyId}:${agent.adapterType}:${profile}`;
  const cached = observationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return safeObservation(await cached.value);
  const value = Promise.resolve().then(() => adapter.inspectOperationalStatus!({
    companyId: agent.companyId,
    agentId: agent.id,
    adapterConfig: agent.adapterConfig,
    signal: signal ?? AbortSignal.timeout(OBSERVATION_TIMEOUT_MS),
  })).then(safeObservation).catch(error => unavailableObservation(agent, error instanceof Error ? error.message.slice(0, 300) : "Provider observation failed"));
  observationCache.set(cacheKey, { expiresAt: Date.now() + OBSERVATION_CACHE_MS, value });
  return value;
}

function latestRunForAgent(runs: OperatingContextRun[], agentId: string) {
  return runs.find(run => run.agentId === agentId) ?? null;
}

function runView(row: typeof heartbeatRuns.$inferSelect): OperatingContextRun {
  const result = row.resultJson && typeof row.resultJson === "object" ? row.resultJson : {};
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    provider: asString(result.provider),
    model: asString(result.model),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: row.error ? row.error.slice(0, 300) : null,
  };
}

export function operatingContextService(db: Db) {
  const agents = agentService(db);
  const costs = costService(db);

  async function get(companyId: string, options: ContextOptions = {}): Promise<OperatingContext> {
    const [agentRows, taskRows, runRows] = await Promise.all([
      agents.list(companyId),
      db.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.status, [...activeTaskStatuses, "blocked"]))).orderBy(desc(issues.updatedAt)).limit(100),
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt})`)).limit(200),
    ]);
    const runs = runRows.map(runView);
    const eligibleAgents = agentRows.filter(agent => agent.status !== "terminated" && (!options.workerId || agent.id === options.workerId));
    const uniqueProfiles = new Map<string, typeof eligibleAgents[number]>();
    for (const agent of eligibleAgents) {
      const key = `${agent.adapterType}:${typeof agent.adapterConfig?.profile === "string" ? agent.adapterConfig.profile : "unknown"}`;
      if (!uniqueProfiles.has(key)) uniqueProfiles.set(key, agent);
    }
    const observations = new Map<string, ProviderOperationalObservation>();
    await Promise.all([...uniqueProfiles.entries()].map(async ([key, agent]) => {
      observations.set(key, await observeAgent({ companyId: agent.companyId, id: agent.id, adapterType: agent.adapterType, adapterConfig: agent.adapterConfig ?? {} }));
    }));

    const contextAgents: OperatingContextAgent[] = eligibleAgents.filter(agent => {
      if (!options.profile) return true;
      return agent.adapterConfig?.profile === options.profile;
    }).map(agent => {
      const profile = typeof agent.adapterConfig?.profile === "string" ? agent.adapterConfig.profile : null;
      const observation = observations.get(`${agent.adapterType}:${profile ?? "unknown"}`) ?? null;
      const latest = latestRunForAgent(runs, agent.id);
      const lastObservedModel = latest?.model ?? observation?.lastObservedModel ?? null;
      const permissions = agent.permissions && typeof agent.permissions === "object" ? agent.permissions as Record<string, unknown> : {};
      const adapterPermissions = permissions.adapterPermissions && typeof permissions.adapterPermissions === "object" ? permissions.adapterPermissions as Record<string, unknown> : {};
      const guardedPermissions = adapterPermissions.samama_guarded_local && typeof adapterPermissions.samama_guarded_local === "object" ? adapterPermissions.samama_guarded_local as Record<string, unknown> : {};
      const grantRows = Array.isArray(guardedPermissions.grants) ? guardedPermissions.grants.filter((grant): grant is Record<string, unknown> => Boolean(grant) && typeof grant === "object") : [];
      const activeGrants = grantRows
        ? grantRows.filter(grant => grant.status === "active" && (!grant.expiresAt || (typeof grant.expiresAt === "string" && Date.parse(grant.expiresAt) > Date.now()))).map(grant => ({ capability: String(grant.capability ?? "unknown"), expiresAt: typeof grant.expiresAt === "string" ? grant.expiresAt : null }))
        : [];
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        title: agent.title ?? null,
        status: agent.status,
        adapterType: agent.adapterType,
        profile,
        configuredModel: observation?.configuredModel ?? null,
        lastObservedModel,
        modelEvidenceRunId: latest?.model ? latest.id : observation?.modelEvidenceRunId ?? null,
        executionMode: observation?.executionMode ?? "unknown",
        authStatus: observation?.authStatus ?? "unknown",
        executionAllowedByPreflight: observation?.executionAllowedByPreflight ?? null,
        blockingReasons: observation?.blockingReasons ?? [],
        permissions: {
          canCreateAgents: agent.permissions?.canCreateAgents === true,
          canAssignTasks: agent.permissions?.canAssignTasks === true,
          activeGrants,
        },
        observation,
      };
    });

    const rangeConditions = [eq(costEvents.companyId, companyId)];
    if (options.from) rangeConditions.push(gte(costEvents.occurredAt, options.from));
    if (options.to) rangeConditions.push(lte(costEvents.occurredAt, options.to));
    if (options.workerId) rangeConditions.push(eq(costEvents.agentId, options.workerId));
    if (options.taskId) rangeConditions.push(eq(costEvents.issueId, options.taskId));
    if (options.profile) {
      const providers = options.profile === "claude" ? ["anthropic"] : options.profile === "codex" ? ["openai"] : ["ollama", "qwen-local"];
      rangeConditions.push(inArray(costEvents.provider, providers));
    }
    const financeConditions = [eq(financeEvents.companyId, companyId)];
    if (options.from) financeConditions.push(gte(financeEvents.occurredAt, options.from));
    if (options.to) financeConditions.push(lte(financeEvents.occurredAt, options.to));
    if (options.workerId) financeConditions.push(eq(financeEvents.agentId, options.workerId));
    if (options.taskId) financeConditions.push(eq(financeEvents.issueId, options.taskId));
    const [usage, invoice] = await Promise.all([
      db.select({
        eventCount: sql<number>`count(*)::int`,
        runCount: sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`,
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
        cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
        estimatedCents: sql<number>`coalesce(sum(${costEvents.costCents}) filter (where ${costEvents.costStatus} = 'estimated'), 0)::double precision`,
        estimatedCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'estimated')::int`,
        incrementalCents: sql<number>`coalesce(sum(${costEvents.costCents}) filter (where ${costEvents.billingType} in ('api', 'metered_api', 'subscription_overage', 'credits')), 0)::double precision`,
        incrementalCount: sql<number>`count(*) filter (where ${costEvents.billingType} in ('api', 'metered_api', 'subscription_overage', 'credits'))::int`,
        unknownCount: sql<number>`count(*) filter (where ${costEvents.billingType} = 'unknown' or ${costEvents.costStatus} = 'unpriced')::int`,
      }).from(costEvents).where(and(...rangeConditions)),
      db.select({
        cents: sql<number>`coalesce(sum(${financeEvents.amountCents}), 0)::double precision`,
        count: sql<number>`count(*) filter (where ${financeEvents.externalInvoiceId} is not null)::int`,
      }).from(financeEvents).where(and(...financeConditions)),
    ]);
    const usageRow = usage[0] ?? { eventCount: 0, runCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCents: 0, estimatedCount: 0, incrementalCents: 0, incrementalCount: 0, unknownCount: 0 };
    const financeRow = invoice[0] ?? { cents: 0, count: 0 };

    const taskView = (row: typeof issues.$inferSelect): OperatingContextTask => ({
      id: row.id,
      identifier: row.identifier ?? null,
      title: row.title,
      status: row.status,
      assigneeAgentId: row.assigneeAgentId,
      updatedAt: row.updatedAt.toISOString(),
    });
    const active = taskRows.filter(row => activeTaskStatuses.includes(row.status as typeof activeTaskStatuses[number])).map(taskView);
    const blocked = taskRows.filter(row => row.status === "blocked").map(taskView);
    const snapshotId = randomUUID();
    return {
      snapshotId,
      capturedAt: new Date().toISOString(),
      companyId,
      source: "Paperclip native DB + approved adapter observations",
      agents: contextAgents,
      tasks: { active, blocked },
      lastRuns: runs.slice(0, 40),
      usage: {
        measured: {
          eventCount: Number(usageRow.eventCount),
          runCount: Number(usageRow.runCount),
          inputTokens: Number(usageRow.inputTokens),
          cachedInputTokens: Number(usageRow.cachedInputTokens),
          outputTokens: Number(usageRow.outputTokens),
        },
        estimatedListCostUsd: Number(usageRow.estimatedCount) > 0 ? Number(usageRow.estimatedCents) / 100 : null,
        recordedIncrementalCostUsd: Number(usageRow.eventCount) > 0 ? Number(usageRow.incrementalCents) / 100 : null,
        invoiceVerifiedBillingUsd: Number(financeRow.count) > 0 ? Number(financeRow.cents) / 100 : null,
        invoiceVerifiedEventCount: Number(financeRow.count),
        unknownCostEventCount: Number(usageRow.unknownCount),
        source: "Paperclip cost_events and finance_events; provider quota is account-wide",
      },
      limitations: [
        "Provider quota may include work done outside Paperclip and is not attributed to individual workers.",
        "Invoice-verified billing is unavailable unless a finance event carries an external invoice reference.",
        "Preflight permission is an observation, not a guarantee that a future task will complete.",
      ],
    };
  }

  return { get };
}
