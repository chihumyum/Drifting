import {
  estimateAgentContextFixedInputTokens,
  type AgentContextProviderEnvelopeV2,
} from './context-message-adapter';
import type { AgentContextSourceKind, AgentContextTokenEstimator } from './context-planner';
import {
  AGENT_CONTEXT_USAGE_CATEGORY_KEYS,
  AGENT_CONTEXT_USAGE_SCHEMA_VERSION,
  type AgentContextUsageCategory,
  type AgentContextUsageCategoryKey,
  type AgentContextUsageSnapshot,
  type AgentModelToolDefinition,
} from './types';

const SOURCE_CATEGORY = {
  system_policy: 'system_prompt',
  user: 'user_messages',
  assistant_narrative: 'assistant_messages',
  thinking: 'thinking',
  tool_call: 'tool_calls',
  tool_result: 'tool_results',
  write_receipt: 'write_receipts',
  write_review: 'write_reviews',
  write_revert: 'write_reverts',
  freshness: 'freshness',
  task_plan: 'task_plan',
  task_constraints: 'task_constraints',
} as const satisfies Record<AgentContextSourceKind, AgentContextUsageCategoryKey>;

interface CreateAgentContextUsageSnapshotInput {
  iteration: number;
  envelope: AgentContextProviderEnvelopeV2;
  selectedTools: readonly AgentModelToolDefinition[];
  providerOverheadTokens: number;
  perToolOverheadTokens: number;
  estimateTokens?: AgentContextTokenEstimator;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Agent context usage snapshot: ${message}`);
}

function safeNonNegative(value: number, label: string): number {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be non-negative`);
  return value;
}

/**
 * Collapse one already-verified provider projection into a tiny, content-free
 * usage snapshot. This mirrors Claude Code's split between the cheap status
 * indicator and the deeper context view: hover/click never re-tokenizes the
 * transcript or stores a second copy of prose in the journal.
 */
export function createAgentContextUsageSnapshot(
  input: CreateAgentContextUsageSnapshotInput,
): AgentContextUsageSnapshot {
  invariant(Number.isSafeInteger(input.iteration) && input.iteration > 0, 'iteration is invalid');
  const checkpoint = input.envelope.plannerCheckpoint;
  const budget = checkpoint.budget;
  const buckets = new Map<AgentContextUsageCategoryKey, AgentContextUsageCategory>(
    AGENT_CONTEXT_USAGE_CATEGORY_KEYS.map((key) => [key, { key, tokens: 0, sourceCount: 0 }]),
  );
  const add = (key: AgentContextUsageCategoryKey, tokens: number, sourceCount: number): void => {
    safeNonNegative(tokens, `${key}.tokens`);
    safeNonNegative(sourceCount, `${key}.sourceCount`);
    const current = buckets.get(key)!;
    current.tokens += tokens;
    current.sourceCount += sourceCount;
  };

  let semanticPinnedTokens = 0;
  let recentPinnedTokens = 0;
  let pinnedSourceCount = 0;
  let summaryCount = 0;
  let deterministicSummaryTokens = 0;
  let fullCompactorSummaryTokens = 0;
  for (const segment of checkpoint.projection.segments) {
    if (segment.type === 'summary') {
      add('compaction_summaries', segment.estimatedTokens, segment.sourceIds.length);
      summaryCount += 1;
      if (segment.producer === 'deterministic') {
        deterministicSummaryTokens += segment.estimatedTokens;
      } else {
        fullCompactorSummaryTokens += segment.estimatedTokens;
      }
      continue;
    }
    add(SOURCE_CATEGORY[segment.row.kind], segment.estimatedTokens, 1);
    if (segment.pinReason === 'semantic') {
      semanticPinnedTokens += segment.estimatedTokens;
      pinnedSourceCount += 1;
    } else if (segment.pinReason === 'recent_turn') {
      recentPinnedTokens += segment.estimatedTokens;
      pinnedSourceCount += 1;
    }
  }

  const toolDefinitions = input.selectedTools.map((tool) => ({
    name: tool.name,
    estimatedTokens: estimateAgentContextFixedInputTokens({
      tools: [tool],
      providerOverheadTokens: 0,
      perToolOverheadTokens: input.perToolOverheadTokens,
      ...(input.estimateTokens ? { estimateTokens: input.estimateTokens } : {}),
    }),
  }));
  const toolDefinitionTokens = toolDefinitions.reduce(
    (total, tool) => total + tool.estimatedTokens,
    0,
  );
  add('tool_definitions', toolDefinitionTokens, toolDefinitions.length);
  add('provider_overhead', input.providerOverheadTokens, input.providerOverheadTokens > 0 ? 1 : 0);

  invariant(
    toolDefinitionTokens + input.providerOverheadTokens === budget.fixedInputTokens,
    'fixed-input breakdown does not match the verified planner budget',
  );
  const categories = AGENT_CONTEXT_USAGE_CATEGORY_KEYS.map((key) => ({ ...buckets.get(key)! }));
  const projectedSourceTokens = categories
    .filter(
      (category) => category.key !== 'tool_definitions' && category.key !== 'provider_overhead',
    )
    .reduce((total, category) => total + category.tokens, 0);
  invariant(
    projectedSourceTokens === budget.finalEstimatedTokens,
    'source category total does not match the final projection',
  );
  const fixedInputTokens = toolDefinitionTokens + input.providerOverheadTokens;
  const estimatedInputTokens = projectedSourceTokens + fixedInputTokens;
  const remainingSourceBudgetTokens = budget.usableInputBudgetTokens - projectedSourceTokens;
  const freeTokens =
    budget.contextWindowTokens -
    estimatedInputTokens -
    budget.reservedOutputTokens -
    budget.safetyMarginTokens;
  invariant(remainingSourceBudgetTokens >= 0, 'source projection exceeds its usable budget');
  invariant(freeTokens === remainingSourceBudgetTokens, 'free-space budget is inconsistent');
  invariant(
    budget.initialEstimatedTokens >= budget.finalEstimatedTokens,
    'final projection is larger than the initial projection',
  );

  return {
    schemaVersion: AGENT_CONTEXT_USAGE_SCHEMA_VERSION,
    iteration: input.iteration,
    contextWindowTokens: budget.contextWindowTokens,
    projectedSourceTokens,
    fixedInputTokens,
    estimatedInputTokens,
    reservedOutputTokens: budget.reservedOutputTokens,
    safetyMarginTokens: budget.safetyMarginTokens,
    usableSourceBudgetTokens: budget.usableInputBudgetTokens,
    remainingSourceBudgetTokens,
    freeTokens,
    categories,
    toolDefinitions,
    pinned: {
      semanticTokens: semanticPinnedTokens,
      recentTurnTokens: recentPinnedTokens,
      totalTokens: semanticPinnedTokens + recentPinnedTokens,
      sourceCount: pinnedSourceCount,
    },
    compaction: {
      initialSourceTokens: budget.initialEstimatedTokens,
      finalSourceTokens: budget.finalEstimatedTokens,
      savedTokens: budget.initialEstimatedTokens - budget.finalEstimatedTokens,
      stages: [...checkpoint.compaction.stages],
      summaryCount,
      deterministicSummaryTokens,
      fullCompactorSummaryTokens,
    },
    coverage: {
      canonicalSources: checkpoint.canonicalSources.sourceCount,
      representedSources: checkpoint.coverage.representedSourceIds.length,
      discardedSources: checkpoint.coverage.discardedSourceIds.length,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Strict recovery guard for the content-free journal payload. */
export function isAgentContextUsageSnapshot(value: unknown): value is AgentContextUsageSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== AGENT_CONTEXT_USAGE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.iteration) ||
    (value.iteration as number) <= 0
  ) {
    return false;
  }
  const pinned = value.pinned as Record<string, unknown>;
  const compaction = value.compaction as Record<string, unknown>;
  const coverage = value.coverage as Record<string, unknown>;
  const tokenFields = [
    'contextWindowTokens',
    'projectedSourceTokens',
    'fixedInputTokens',
    'estimatedInputTokens',
    'reservedOutputTokens',
    'safetyMarginTokens',
    'usableSourceBudgetTokens',
    'remainingSourceBudgetTokens',
    'freeTokens',
  ] as const;
  if (
    tokenFields.some((field) => !isNonNegativeSafeInteger(value[field])) ||
    (value.contextWindowTokens as number) <= 0 ||
    !Array.isArray(value.categories) ||
    value.categories.length !== AGENT_CONTEXT_USAGE_CATEGORY_KEYS.length ||
    !Array.isArray(value.toolDefinitions) ||
    !isRecord(value.pinned) ||
    !isRecord(value.compaction) ||
    !isRecord(value.coverage)
  ) {
    return false;
  }

  const expectedKeys = new Set<string>(AGENT_CONTEXT_USAGE_CATEGORY_KEYS);
  const seenKeys = new Set<string>();
  for (const category of value.categories) {
    if (
      !isRecord(category) ||
      typeof category.key !== 'string' ||
      !expectedKeys.has(category.key) ||
      seenKeys.has(category.key) ||
      !isNonNegativeSafeInteger(category.tokens) ||
      !isNonNegativeSafeInteger(category.sourceCount)
    ) {
      return false;
    }
    seenKeys.add(category.key);
  }
  const toolNames = new Set<string>();
  for (const tool of value.toolDefinitions) {
    if (
      !isRecord(tool) ||
      typeof tool.name !== 'string' ||
      tool.name.trim().length === 0 ||
      toolNames.has(tool.name) ||
      !isNonNegativeSafeInteger(tool.estimatedTokens)
    ) {
      return false;
    }
    toolNames.add(tool.name);
  }
  const pinnedFields = [
    'semanticTokens',
    'recentTurnTokens',
    'totalTokens',
    'sourceCount',
  ] as const;
  if (pinnedFields.some((field) => !isNonNegativeSafeInteger(pinned[field]))) return false;
  const compactionFields = [
    'initialSourceTokens',
    'finalSourceTokens',
    'savedTokens',
    'summaryCount',
    'deterministicSummaryTokens',
    'fullCompactorSummaryTokens',
  ] as const;
  if (
    compactionFields.some((field) => !isNonNegativeSafeInteger(compaction[field])) ||
    !Array.isArray(compaction.stages) ||
    compaction.stages.some(
      (stage) =>
        stage !== 'drop_discardable' &&
        stage !== 'deterministic_summaries' &&
        stage !== 'full_compactor',
    )
  ) {
    return false;
  }
  const coverageFields = ['canonicalSources', 'representedSources', 'discardedSources'] as const;
  if (coverageFields.some((field) => !isNonNegativeSafeInteger(coverage[field]))) return false;

  const snapshot = value as unknown as AgentContextUsageSnapshot;

  const categoryByKey = new Map(
    snapshot.categories.map((category) => [category.key, category] as const),
  );
  const categoryTokens = snapshot.categories.reduce(
    (total, category) => total + category.tokens,
    0,
  );
  const toolDefinitionTokens = snapshot.toolDefinitions.reduce(
    (total, tool) => total + tool.estimatedTokens,
    0,
  );
  const projectedCategoryTokens =
    categoryTokens -
    categoryByKey.get('tool_definitions')!.tokens -
    categoryByKey.get('provider_overhead')!.tokens;
  return (
    seenKeys.size === expectedKeys.size &&
    projectedCategoryTokens === snapshot.projectedSourceTokens &&
    categoryByKey.get('tool_definitions')!.tokens === toolDefinitionTokens &&
    categoryByKey.get('provider_overhead')!.tokens + toolDefinitionTokens ===
      snapshot.fixedInputTokens &&
    categoryTokens === snapshot.estimatedInputTokens &&
    snapshot.projectedSourceTokens + snapshot.fixedInputTokens === snapshot.estimatedInputTokens &&
    snapshot.usableSourceBudgetTokens - snapshot.projectedSourceTokens ===
      snapshot.remainingSourceBudgetTokens &&
    snapshot.remainingSourceBudgetTokens === snapshot.freeTokens &&
    snapshot.estimatedInputTokens +
      snapshot.reservedOutputTokens +
      snapshot.safetyMarginTokens +
      snapshot.freeTokens ===
      snapshot.contextWindowTokens &&
    snapshot.pinned.semanticTokens + snapshot.pinned.recentTurnTokens ===
      snapshot.pinned.totalTokens &&
    snapshot.compaction.initialSourceTokens - snapshot.compaction.finalSourceTokens ===
      snapshot.compaction.savedTokens &&
    snapshot.compaction.finalSourceTokens === snapshot.projectedSourceTokens &&
    snapshot.coverage.representedSources + snapshot.coverage.discardedSources ===
      snapshot.coverage.canonicalSources
  );
}

/**
 * Upgrade the original content-free usage payload after new display buckets
 * are added. Context snapshots are durable journal events: changing the
 * category list without a schema migration makes every existing long-running
 * conversation fail strict recovery before its next turn can start.
 */
export function normalizeAgentContextUsageSnapshot(
  value: unknown,
): AgentContextUsageSnapshot | null {
  if (isAgentContextUsageSnapshot(value)) return value;
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.categories)) {
    return null;
  }

  const categories = new Map<string, unknown>();
  for (const category of value.categories) {
    if (!isRecord(category) || typeof category.key !== 'string' || categories.has(category.key)) {
      return null;
    }
    categories.set(category.key, category);
  }
  const allowedLegacyKeys = new Set<string>(AGENT_CONTEXT_USAGE_CATEGORY_KEYS);
  if ([...categories.keys()].some((key) => !allowedLegacyKeys.has(key))) return null;
  if (
    AGENT_CONTEXT_USAGE_CATEGORY_KEYS.some(
      (key) => key !== 'write_receipts' && !categories.has(key),
    )
  ) {
    return null;
  }

  const upgraded = {
    ...value,
    schemaVersion: AGENT_CONTEXT_USAGE_SCHEMA_VERSION,
    categories: AGENT_CONTEXT_USAGE_CATEGORY_KEYS.map(
      (key) => categories.get(key) ?? { key, tokens: 0, sourceCount: 0 },
    ),
  };
  return isAgentContextUsageSnapshot(upgraded) ? upgraded : null;
}
