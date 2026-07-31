import {
  AGENT_CONTEXT_USAGE_CATEGORY_KEYS,
  AGENT_CONTEXT_USAGE_SCHEMA_VERSION,
  type AgentContextUsageSnapshot,
} from './types';

export function contextUsageSnapshot(iteration = 1): AgentContextUsageSnapshot {
  return {
    schemaVersion: AGENT_CONTEXT_USAGE_SCHEMA_VERSION,
    iteration,
    contextWindowTokens: 100,
    projectedSourceTokens: 10,
    fixedInputTokens: 5,
    estimatedInputTokens: 15,
    reservedOutputTokens: 20,
    safetyMarginTokens: 10,
    usableSourceBudgetTokens: 65,
    remainingSourceBudgetTokens: 55,
    freeTokens: 55,
    categories: AGENT_CONTEXT_USAGE_CATEGORY_KEYS.map((key) => ({
      key,
      tokens: key === 'system_prompt' ? 10 : key === 'tool_definitions' ? 5 : 0,
      sourceCount: key === 'system_prompt' || key === 'tool_definitions' ? 1 : 0,
    })),
    toolDefinitions: [{ name: 'read_node', estimatedTokens: 5 }],
    pinned: {
      semanticTokens: 10,
      recentTurnTokens: 0,
      totalTokens: 10,
      sourceCount: 1,
    },
    compaction: {
      initialSourceTokens: 10,
      finalSourceTokens: 10,
      savedTokens: 0,
      stages: [],
      summaryCount: 0,
      deterministicSummaryTokens: 0,
      fullCompactorSummaryTokens: 0,
    },
    coverage: {
      canonicalSources: 1,
      representedSources: 1,
      discardedSources: 0,
    },
  };
}
