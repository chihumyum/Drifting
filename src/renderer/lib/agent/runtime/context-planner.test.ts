import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_CONTEXT_CHECKPOINT_FORMAT,
  AGENT_CONTEXT_CHECKPOINT_VERSION,
  AgentContextCompactionCircuitBreaker,
  classifyAgentContextSource,
  computeAgentContextBudget,
  createAgentContextSummaryCandidate,
  estimateAgentContextTextTokens,
  hashAgentContextSourceRows,
  planAgentContext,
  serializeAgentContextNoteBudgetPayload,
  serializeAgentContextSummaryBudgetPayload,
  type AgentContextSourceRow,
} from './context-planner';

function row(
  sourceId: string,
  ordinal: number,
  turnOrdinal: number | null,
  kind: AgentContextSourceRow['kind'],
  content: string,
  tool?: {
    callId: string;
    toolName: string;
    toolAccess: 'read' | 'write' | 'denied';
  },
): AgentContextSourceRow {
  return {
    sourceId,
    ordinal,
    turnOrdinal,
    kind,
    content,
    ...tool,
  };
}

function baseRows(options?: {
  oldNarrative?: string;
  thinking?: string;
}): AgentContextSourceRow[] {
  return [
    row('system', 0, null, 'system_policy', 'POLICY: use tools safely'),
    row('user-0', 1, 0, 'user', 'Keep every user byte.'),
    row(
      'assistant-0',
      2,
      0,
      'assistant_narrative',
      options?.oldNarrative ?? 'old answer',
    ),
    row('user-1', 3, 1, 'user', 'second turn'),
    row('assistant-1', 4, 1, 'assistant_narrative', 'recent answer one'),
    row('user-2', 5, 2, 'user', 'third turn'),
    row('thinking-2', 6, 2, 'thinking', options?.thinking ?? 'private thought'),
    row('assistant-2', 7, 2, 'assistant_narrative', 'recent answer two'),
  ];
}

function sourceSegment(
  result: Awaited<ReturnType<typeof planAgentContext>>,
  sourceId: string,
) {
  if (!result.ok) throw new Error(result.error.message);
  return result.plan.segments.find(
    (segment) =>
      segment.type === 'source' && segment.row.sourceId === sourceId,
  );
}

describe('provider-neutral Agent context planner', () => {
  it('computes the output reserve and ten-percent safety margin exactly', () => {
    expect(
      computeAgentContextBudget({
        contextWindowTokens: 20_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens: 0,
      }),
    ).toEqual({
      contextWindowTokens: 20_000,
      requestedOutputTokens: 1_000,
      reservedOutputTokens: 4_096,
      safetyMarginTokens: 2_000,
      fixedInputTokens: 0,
      usableInputBudgetTokens: 13_904,
    });
    expect(
      computeAgentContextBudget({
        contextWindowTokens: 20_000,
        requestedOutputTokens: 8_000,
        fixedInputTokens: 0,
      }).usableInputBudgetTokens,
    ).toBe(10_000);
    expect(
      computeAgentContextBudget({
        contextWindowTokens: 20_000,
        requestedOutputTokens: 1_000,
        fixedInputTokens: 1_250,
      }),
    ).toEqual({
      contextWindowTokens: 20_000,
      requestedOutputTokens: 1_000,
      reservedOutputTokens: 4_096,
      safetyMarginTokens: 2_000,
      fixedInputTokens: 1_250,
      usableInputBudgetTokens: 12_654,
    });
  });

  it('derives safety classes, drops thinking, and keeps the latest two turns byte-exact', async () => {
    const exactUser = '  USER\\nbytes\\u0000stay  ';
    const rows = baseRows();
    rows[5] = row('user-2', 5, 2, 'user', exactUser);

    expect(classifyAgentContextSource(rows[0])).toBe('pinned');
    expect(classifyAgentContextSource(rows[2])).toBe('compressible');
    expect(classifyAgentContextSource(rows[6])).toBe('discardable');

    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.plan.segments.some(
        (segment) =>
          segment.type === 'source' && segment.row.sourceId === 'thinking-2',
      ),
    ).toBe(false);
    expect(sourceSegment(result, 'user-2')).toMatchObject({
      type: 'source',
      row: { content: exactUser },
      pinReason: 'semantic',
    });
    expect(sourceSegment(result, 'assistant-1')).toMatchObject({
      type: 'source',
      pinReason: 'recent_turn',
    });
    expect(sourceSegment(result, 'assistant-2')).toMatchObject({
      type: 'source',
      pinReason: 'recent_turn',
    });
    expect(sourceSegment(result, 'assistant-0')).toMatchObject({
      type: 'source',
      pinReason: null,
    });
    expect(result.plan.checkpoint.coverage.discardedSourceIds).toEqual([
      'thinking-2',
    ]);
  });

  it('fails closed before compaction when exact pinned context exceeds the budget', async () => {
    const compactor = vi.fn();
    const rows = baseRows();
    rows[1] = row('user-0', 1, 0, 'user', 'p'.repeat(24_000));

    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      fullCompactor: compactor,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PINNED_CONTEXT_EXCEEDS_BUDGET' },
      diagnostics: { fullCompactionCount: 0 },
    });
    expect(compactor).not.toHaveBeenCalled();
  });

  it('uses verified deterministic summaries before considering a full compactor', async () => {
    const rows = baseRows({ oldNarrative: 'old '.repeat(7_000) });
    const old = rows.filter((item) => item.sourceId === 'assistant-0');
    const deterministic = await createAgentContextSummaryCandidate({
      summaryId: 'summary-old',
      sourceRows: old,
      content: 'Old assistant response summarized.',
    });
    const fullCompactor = vi.fn();

    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      deterministicSummaries: [deterministic],
      fullCompactor,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fullCompactor).not.toHaveBeenCalled();
    expect(result.plan.checkpoint.compaction).toMatchObject({
      stages: ['drop_discardable', 'deterministic_summaries'],
      fullCompactionCount: 0,
    });
    expect(
      result.plan.segments.find(
        (segment) =>
          segment.type === 'summary' &&
          segment.summaryId === 'summary-old',
      ),
    ).toMatchObject({
      producer: 'deterministic',
      sourceIds: ['assistant-0'],
    });
  });

  it('charges every one of 3000 summary source ids instead of budgeting only summary prose', async () => {
    const oldRows = Array.from({ length: 3_000 }, (_, index) =>
      row(
        `model/message/0/assistant/${index}/assistant_narrative_with_deliberately_long_identity`,
        index + 2,
        0,
        'assistant_narrative',
        'historical payload '.repeat(10),
      ),
    );
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user-0', 1, 0, 'user', 'first turn'),
      ...oldRows,
      row('user-1', 3_002, 1, 'user', 'second turn'),
      row('assistant-1', 3_003, 1, 'assistant_narrative', 'recent one'),
      row('user-2', 3_004, 2, 'user', 'third turn'),
      row('assistant-2', 3_005, 2, 'assistant_narrative', 'recent two'),
    ];
    const summary = await createAgentContextSummaryCandidate({
      summaryId: 'summary-3000-sources',
      sourceRows: oldRows,
      content: 'Compact old history.',
    });
    const expectedSummaryTokens =
      estimateAgentContextTextTokens(
        serializeAgentContextSummaryBudgetPayload(summary),
      ) + 8;

    const roomy = await planAgentContext({
      contextWindowTokens: 100_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      deterministicSummaries: [summary],
    });
    expect(roomy.ok).toBe(true);
    if (!roomy.ok) return;
    const summarySegment = roomy.plan.segments.find(
      (segment) =>
        segment.type === 'summary' &&
        segment.summaryId === 'summary-3000-sources',
    );
    expect(summarySegment?.estimatedTokens).toBe(expectedSummaryTokens);
    expect(expectedSummaryTokens).toBeGreaterThan(20_000);

    const constrained = await planAgentContext({
      contextWindowTokens: 20_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      deterministicSummaries: [summary],
    });
    expect(constrained).toMatchObject({
      ok: false,
      error: { code: 'CONTEXT_BUDGET_EXCEEDED' },
    });
    if (!constrained.ok) {
      expect(constrained.diagnostics.estimatedInputTokens).toBeGreaterThan(
        expectedSummaryTokens,
      );
    }
  });

  it('charges supplemental note provenance as well as its visible content', async () => {
    const freshness = row(
      `freshness/${'source-identity-'.repeat(400)}`,
      2,
      null,
      'freshness',
      'r1',
    );
    const result = await planAgentContext({
      contextWindowTokens: 20_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: [
        row('system', 0, null, 'system_policy', 'policy'),
        row('user', 1, 0, 'user', 'inspect'),
        freshness,
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected =
      estimateAgentContextTextTokens(
        serializeAgentContextNoteBudgetPayload({
          noteKind: 'freshness',
          sourceId: freshness.sourceId,
          turnOrdinal: null,
          content: freshness.content,
        }),
      ) + 6;
    expect(sourceSegment(result, freshness.sourceId)?.estimatedTokens).toBe(
      expected,
    );
    expect(expected).toBeGreaterThan(
      estimateAgentContextTextTokens(freshness.content) + 1_000,
    );
  });

  it('runs a full compactor at most once and accepts only a positive verified projection', async () => {
    const rows = baseRows({ oldNarrative: 'history '.repeat(6_000) });
    let calls = 0;
    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      fullCompactor: async ({ eligibleRuns }) => {
        calls += 1;
        expect(eligibleRuns).toHaveLength(1);
        return [
          await createAgentContextSummaryCandidate({
            summaryId: 'full-summary',
            sourceRows: eligibleRuns[0],
            content: 'Verified compact history.',
          }),
        ];
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(1);
    expect(result.plan.estimatedInputTokens).toBeLessThanOrEqual(
      result.plan.usableInputBudgetTokens,
    );
    expect(result.plan.checkpoint.compaction).toMatchObject({
      stages: ['drop_discardable', 'full_compactor'],
      fullCompactionCount: 1,
    });
  });

  it('keeps write calls/results, reviews, reverts, and freshness byte-exact', async () => {
    const tool = {
      callId: 'write-1',
      toolName: 'rename_node',
      toolAccess: 'write' as const,
    };
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user', 1, 0, 'user', 'rename it'),
      row('write-call', 2, 0, 'tool_call', '{"name":"before"}', tool),
      row('write-result', 3, 0, 'tool_result', '{"name":"after"}', tool),
      row('review', 4, 0, 'write_review', 'accepted:write-1'),
      row('revert', 5, 0, 'write_revert', 'not-reverted:write-1'),
      row('fresh', 6, null, 'freshness', 'revision:42'),
    ];
    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const item of rows) {
      expect(sourceSegment(result, item.sourceId)).toMatchObject({
        type: 'source',
        row: { content: item.content },
        pinReason: 'semantic',
      });
    }
  });

  it('treats a canonical denied tool pair as compressible context', async () => {
    const denied = {
      callId: 'denied-1',
      toolName: 'missing_tool',
      toolAccess: 'denied' as const,
    };
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user', 1, 0, 'user', 'try it'),
      row('denied-call', 2, 0, 'tool_call', '{"type":"tool_call"}', denied),
      row(
        'denied-result',
        3,
        0,
        'tool_result',
        '{"ok":false,"errorCode":"UNKNOWN_TOOL"}',
        denied,
      ),
    ];

    expect(classifyAgentContextSource(rows[2])).toBe('compressible');
    expect(classifyAgentContextSource(rows[3])).toBe('compressible');
    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a summary that splits a read call/result pair and opens the circuit', async () => {
    const readTool = {
      callId: 'read-1',
      toolName: 'read_node',
      toolAccess: 'read' as const,
    };
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user-0', 1, 0, 'user', 'read'),
      row('read-call', 2, 0, 'tool_call', '{"id":"node"}', readTool),
      row('read-result', 3, 0, 'tool_result', 'result '.repeat(8_000), readTool),
      row('user-1', 4, 1, 'user', 'next'),
      row('assistant-1', 5, 1, 'assistant_narrative', 'recent one'),
      row('user-2', 6, 2, 'user', 'latest'),
      row('assistant-2', 7, 2, 'assistant_narrative', 'recent two'),
    ];
    const circuit = new AgentContextCompactionCircuitBreaker();
    let calls = 0;
    const compactor = async () => {
      calls += 1;
      return [
        await createAgentContextSummaryCandidate({
          summaryId: 'partial-read',
          sourceRows: [rows[3]],
          content: 'read result only',
        }),
      ];
    };

    const first = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      fullCompactor: compactor,
      compactionCircuit: circuit,
    });
    const second = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      fullCompactor: compactor,
      compactionCircuit: circuit,
    });

    expect(first).toMatchObject({
      ok: false,
      error: { code: 'INVALID_SUMMARY' },
      diagnostics: {
        fullCompactionCount: 1,
        circuitState: { state: 'open' },
      },
    });
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'COMPACTION_CIRCUIT_OPEN' },
      diagnostics: { fullCompactionCount: 0 },
    });
    expect(calls).toBe(1);
  });

  it('opens the circuit on compactor timeout without retrying', async () => {
    const rows = baseRows({ oldNarrative: 'history '.repeat(6_000) });
    const circuit = new AgentContextCompactionCircuitBreaker();
    let calls = 0;

    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      compactionTimeoutMs: 5,
      compactionCircuit: circuit,
      fullCompactor: async () => {
        calls += 1;
        return await new Promise(() => {});
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'COMPACTOR_TIMEOUT' },
      diagnostics: {
        fullCompactionCount: 1,
        circuitState: { state: 'open' },
      },
    });
    expect(calls).toBe(1);
  });

  it('opens the circuit when a compactor returns no token gain', async () => {
    const rows = baseRows({ oldNarrative: 'history '.repeat(6_000) });
    const circuit = new AgentContextCompactionCircuitBreaker();

    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      compactionCircuit: circuit,
      fullCompactor: async ({ eligibleRuns }) => [
        await createAgentContextSummaryCandidate({
          summaryId: 'larger-summary',
          sourceRows: eligibleRuns[0],
          content: 'larger '.repeat(9_000),
        }),
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'COMPACTOR_NO_GAIN' },
      diagnostics: { circuitState: { state: 'open' } },
    });
  });

  it('rejects a full compactor that tries to replace a protected recent row', async () => {
    const rows = baseRows({ oldNarrative: 'history '.repeat(6_000) });
    const circuit = new AgentContextCompactionCircuitBreaker();

    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      compactionCircuit: circuit,
      fullCompactor: async () => [
        await createAgentContextSummaryCandidate({
          summaryId: 'rewrite-recent',
          sourceRows: [rows[7]],
          content: 'rewritten recent answer',
        }),
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_SUMMARY' },
      diagnostics: {
        fullCompactionCount: 1,
        circuitState: { state: 'open' },
      },
    });
  });

  it('fails closed on dangling canonical tool topology before any compactor runs', async () => {
    const compactor = vi.fn();
    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: [
        row('system', 0, null, 'system_policy', 'policy'),
        row('user', 1, 0, 'user', 'read'),
        row('call', 2, 0, 'tool_call', '{}', {
          callId: 'orphan',
          toolName: 'read_node',
          toolAccess: 'read',
        }),
      ],
      fullCompactor: compactor,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_CONTEXT' },
    });
    expect(compactor).not.toHaveBeenCalled();
  });

  it('does not mutate canonical rows and emits a deterministic V2 envelope', async () => {
    const rows = baseRows();
    const before = JSON.stringify(rows);
    const first = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
    });
    const second = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
    });

    expect(JSON.stringify(rows)).toBe(before);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.plan.checkpoint).toMatchObject({
      schemaVersion: AGENT_CONTEXT_CHECKPOINT_VERSION,
      format: AGENT_CONTEXT_CHECKPOINT_FORMAT,
    });
    expect(first.plan.checkpoint.canonicalSources.sourceOrderHash).toBe(
      await hashAgentContextSourceRows(rows),
    );
    expect(first.plan.checkpoint.projection.contextHash).toBe(
      second.plan.checkpoint.projection.contextHash,
    );
    expect(first.plan.checkpoint.pinned.sourceHash).toBe(
      second.plan.checkpoint.pinned.sourceHash,
    );
  });
});
