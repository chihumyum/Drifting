import { describe, expect, it } from 'vitest';
import {
  estimateAgentContextFixedInputTokens,
  planAgentModelContext,
} from './context-message-adapter';
import { createAgentContextSummaryCandidate } from './context-planner';
import { createAgentContextUsageSnapshot, isAgentContextUsageSnapshot } from './context-usage';
import type { AgentModelMessage, AgentModelToolDefinition } from './types';

const estimateTokens = (text: string): number => text.length;

const tools: AgentModelToolDefinition[] = [
  {
    name: 'read_node',
    description: 'Read one canonical project node.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        includeBody: { type: 'boolean' },
      },
      required: ['node'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_project',
    description: 'Search canonical project content.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

function longHistory(): AgentModelMessage[] {
  const messages: AgentModelMessage[] = [];
  for (let turn = 0; turn < 5; turn += 1) {
    const old = turn < 3;
    messages.push({
      role: 'user',
      content: `${old ? 'old' : 'recent'} user ${turn} ${old ? 'u'.repeat(2_600) : 'exact'}`,
    });
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `${old ? 'old' : 'recent'} answer ${turn} ${old ? 'a'.repeat(2_600) : 'exact'}`,
        },
        ...(turn === 0 ? [{ type: 'thinking' as const, text: 'discardable '.repeat(100) }] : []),
      ],
    });
  }
  return messages;
}

describe('Agent context usage telemetry', () => {
  it('derives a strict content-free breakdown from a real compacted provider envelope', async () => {
    const providerOverheadTokens = 111;
    const perToolOverheadTokens = 7;
    const fixedInputTokens = estimateAgentContextFixedInputTokens({
      tools,
      providerOverheadTokens,
      perToolOverheadTokens,
      estimateTokens,
    });
    const planned = await planAgentModelContext({
      systemPrompt: 'Keep canon exact and report tool evidence.',
      messages: longHistory(),
      resolveToolAccess: () => null,
      supplementalRows: [
        {
          sourceId: 'task-plan/current',
          turnOrdinal: null,
          kind: 'task_plan',
          content: '{"goal":"finish the manuscript","status":"in_progress"}',
        },
      ],
      planner: {
        contextWindowTokens: 20_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens,
        constraintLedger: [],
        estimateTokens,
        fullCompactor: async ({ eligibleRuns }) =>
          Promise.all(
            eligibleRuns.map((sourceRows, index) =>
              createAgentContextSummaryCandidate({
                summaryId: `summary-${index}`,
                sourceRows,
                content: `Verified old-turn summary ${index}.`,
              }),
            ),
          ),
      },
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const snapshot = createAgentContextUsageSnapshot({
      iteration: 3,
      envelope: planned.envelope,
      selectedTools: tools,
      providerOverheadTokens,
      perToolOverheadTokens,
      estimateTokens,
    });
    const categories = new Map(snapshot.categories.map((category) => [category.key, category]));
    const sourceCategoryTokens = snapshot.categories
      .filter(
        (category) => category.key !== 'tool_definitions' && category.key !== 'provider_overhead',
      )
      .reduce((total, category) => total + category.tokens, 0);
    const toolDefinitionTokens = snapshot.toolDefinitions.reduce(
      (total, tool) => total + tool.estimatedTokens,
      0,
    );

    expect(snapshot.contextWindowTokens).toBe(20_000);
    expect(sourceCategoryTokens).toBe(snapshot.projectedSourceTokens);
    expect(snapshot.categories.reduce((total, category) => total + category.tokens, 0)).toBe(
      snapshot.estimatedInputTokens,
    );
    expect(categories.get('tool_definitions')?.tokens).toBe(toolDefinitionTokens);
    expect(categories.get('provider_overhead')?.tokens).toBe(providerOverheadTokens);
    expect(toolDefinitionTokens + providerOverheadTokens).toBe(snapshot.fixedInputTokens);
    expect(snapshot.toolDefinitions.map((tool) => tool.name)).toEqual([
      'read_node',
      'search_project',
    ]);
    expect(snapshot.pinned.semanticTokens).toBeGreaterThan(0);
    expect(snapshot.pinned.recentTurnTokens).toBeGreaterThan(0);
    expect(snapshot.pinned.totalTokens).toBe(
      snapshot.pinned.semanticTokens + snapshot.pinned.recentTurnTokens,
    );
    expect(snapshot.compaction.stages).toEqual(
      expect.arrayContaining(['drop_discardable', 'full_compactor']),
    );
    expect(snapshot.compaction.fullCompactorSummaryTokens).toBeGreaterThan(0);
    expect(snapshot.compaction.savedTokens).toBeGreaterThan(0);
    expect(categories.get('compaction_summaries')?.tokens).toBe(
      snapshot.compaction.fullCompactorSummaryTokens,
    );
    expect(snapshot.coverage.representedSources + snapshot.coverage.discardedSources).toBe(
      snapshot.coverage.canonicalSources,
    );
    expect(
      snapshot.estimatedInputTokens +
        snapshot.reservedOutputTokens +
        snapshot.safetyMarginTokens +
        snapshot.freeTokens,
    ).toBe(snapshot.contextWindowTokens);
    expect(isAgentContextUsageSnapshot(snapshot)).toBe(true);

    const tamperedCategoryTotal = structuredClone(snapshot);
    tamperedCategoryTotal.categories.find((category) => category.key === 'system_prompt')!.tokens +=
      1;
    expect(isAgentContextUsageSnapshot(tamperedCategoryTotal)).toBe(false);

    const tamperedToolSplit = structuredClone(snapshot);
    tamperedToolSplit.toolDefinitions[0]!.estimatedTokens += 1;
    expect(isAgentContextUsageSnapshot(tamperedToolSplit)).toBe(false);

    const tamperedCoverage = structuredClone(snapshot);
    tamperedCoverage.coverage.discardedSources += 1;
    expect(isAgentContextUsageSnapshot(tamperedCoverage)).toBe(false);
  });
});
