import { v7 as uuidv7 } from 'uuid';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { AiUsageTable } from '../schema/drizzle';

// Local AI-usage accounting: one row per LLM call that EXECUTED on this client
// (Shadow BYOK / direct-provider). Hosted calls run on the server and are metered
// there — they are NOT recorded here. `record` is fire-and-forget at the call sites
// (must never break an AI run); `summary` aggregates for the usage panel.

export interface AiUsageEntry {
  projectId?: string | null;
  feature: string; // 'shadow:review' | 'shadow:arc' | …
  provider?: string | null;
  model?: string | null;
  credentialsMode?: string | null; // 'hosted' | 'byok'
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

export interface AiUsageFeatureSummary {
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface AiUsageSummary {
  total: { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number };
  byFeature: AiUsageFeatureSummary[];
}

export interface AiUsageQuery {
  projectId?: string | null; // omit = all projects
  featurePrefix?: string; // e.g. 'shadow:' → LIKE 'shadow:%'
  since?: string; // ISO; omit = all time
}

const ZERO = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

export function createAiUsageRepository() {
  const record = async (e: AiUsageEntry): Promise<void> => {
    await getDb()
      .insert(AiUsageTable)
      .values({
        id: uuidv7(),
        projectId: e.projectId ?? null,
        feature: e.feature,
        provider: e.provider ?? null,
        model: e.model ?? null,
        credentialsMode: e.credentialsMode ?? null,
        inputTokens: e.inputTokens ?? 0,
        outputTokens: e.outputTokens ?? 0,
        cachedTokens: e.cachedTokens ?? 0,
        createdAt: new Date().toISOString(),
      });
  };

  const summary = async (q: AiUsageQuery = {}): Promise<AiUsageSummary> => {
    const conds = [];
    if (q.projectId) conds.push(eq(AiUsageTable.projectId, q.projectId));
    if (q.since) conds.push(gte(AiUsageTable.createdAt, q.since));
    if (q.featurePrefix) conds.push(sql`${AiUsageTable.feature} LIKE ${q.featurePrefix + '%'}`);
    const rows = await getDb()
      .select({
        feature: AiUsageTable.feature,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${AiUsageTable.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${AiUsageTable.outputTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${AiUsageTable.cachedTokens}), 0)`,
      })
      .from(AiUsageTable)
      .where(conds.length ? and(...conds) : undefined)
      .groupBy(AiUsageTable.feature);

    const byFeature: AiUsageFeatureSummary[] = rows.map((r) => ({
      feature: r.feature,
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cachedTokens: Number(r.cachedTokens),
    }));
    const total = byFeature.reduce(
      (a, f) => ({
        calls: a.calls + f.calls,
        inputTokens: a.inputTokens + f.inputTokens,
        outputTokens: a.outputTokens + f.outputTokens,
        cachedTokens: a.cachedTokens + f.cachedTokens,
      }),
      { ...ZERO },
    );
    return { total, byFeature };
  };

  return { record, summary };
}
