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
  serializeAgentContextSummaryProviderPayload,
  type AgentContextFullCompactionRequest,
  type AgentContextSourceRow,
} from './context-planner';
import {
  WORKSPACE_COMPLETE_READ_MODEL_MARKER,
  WORKSPACE_NOOP_WRITE_MODEL_MARKER,
} from './drifting-workspace-tool-contract';

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

function baseRows(options?: { oldNarrative?: string; thinking?: string }): AgentContextSourceRow[] {
  return [
    row('system', 0, null, 'system_policy', 'POLICY: use tools safely'),
    row('user-0', 1, 0, 'user', 'Keep every user byte.'),
    row('assistant-0', 2, 0, 'assistant_narrative', options?.oldNarrative ?? 'old answer'),
    row('user-1', 3, 1, 'user', 'second turn'),
    row('assistant-1', 4, 1, 'assistant_narrative', 'recent answer one'),
    row('user-2', 5, 2, 'user', 'third turn'),
    row('thinking-2', 6, 2, 'thinking', options?.thinking ?? 'private thought'),
    row('assistant-2', 7, 2, 'assistant_narrative', 'recent answer two'),
  ];
}

function sourceSegment(result: Awaited<ReturnType<typeof planAgentContext>>, sourceId: string) {
  if (!result.ok) throw new Error(result.error.message);
  return result.plan.segments.find(
    (segment) => segment.type === 'source' && segment.row.sourceId === sourceId,
  );
}

describe('provider-neutral Agent context planner', () => {
  it('makes a newer authored read override historical write continuity', () => {
    const serialized = serializeAgentContextNoteBudgetPayload({
      noteKind: 'write_receipt',
      sourceId: 'receipt-1',
      turnOrdinal: 1,
      content: '已提交章节「08」摘要。',
    });

    expect(serialized).toContain('[当前作品任务状态]');
    expect(serialized).toContain('同一对象以最近看到的内容为准');
    expect(serialized).not.toMatch(/快照|写入|receipt|sourceId/u);
  });

  it('projects authored read progress as current manuscript state only', () => {
    const serialized = serializeAgentContextNoteBudgetPayload({
      noteKind: 'read_progress',
      sourceId: 'read-progress:private-effect-id',
      turnOrdinal: 3,
      content:
        '章节「11」正文已在本轮完整通读，之后的修改已经计入当前稿件。当前摘要：米拉确认泰勒面临的危险。',
    });

    expect(serialized).toContain('[当前阅读进度]');
    expect(serialized).toContain('章节「11」正文已在本轮完整通读');
    expect(serialized).not.toMatch(/private-|effect|sourceId|path|offset|tool|revision|JSON/iu);
  });

  it('projects verified summaries as one domain state without provenance or history mechanics', () => {
    const serialized = serializeAgentContextSummaryProviderPayload({
      summaryId: 'private-summary-id',
      sourceIds: ['private-source-id'],
      sourceHash: 'sha256:private-source-hash',
      content: JSON.stringify({
        schemaVersion: 1,
        synopsis:
          'Earlier Agent activity was compacted deterministically. 第七章需继续收紧。',
        evidence: [
          {
            sourceId: 'old-read',
            kind: 'task_progress',
            claim: '章节「07」正文 当前版本参考：\n对象：章节「07」正文\n摘要：旧城重逢。',
            quote: '旧城重逢',
          },
        ],
        decisions: ['保留酒馆对峙。'],
        unresolved: ['第八章摘要待更新。'],
        nextActions: ['收紧第八章。'],
      }),
    });

    expect(serialized).toContain('第七章需继续收紧');
    expect(serialized).toContain('章节「07」正文 当前版本参考');
    expect(serialized).toContain('保留酒馆对峙');
    expect(serialized).not.toMatch(
      /private-|sourceHash|summaryId|compacted|JSON|review|token|path/iu,
    );
  });

  it('projects durable long-task notes without task ids, revisions, or tool names', () => {
    const serialized = serializeAgentContextNoteBudgetPayload({
      noteKind: 'task_plan',
      sourceId: 'long-task:private-id:plan',
      turnOrdinal: null,
      content: JSON.stringify({
        schemaVersion: 3,
        task: {
          taskId: 'private-task-id',
          objective: '润色整本小说',
          status: 'active',
          revision: 17,
        },
        progress: { total: 8, completed: 3 },
        stepWindow: {
          steps: [
            {
              stepId: 'private-step-id',
              title: '收紧第四章',
              status: 'in_progress',
              target: { name: '第四章' },
            },
          ],
        },
        continuation: { readTool: 'read_task_plan' },
      }),
    });

    expect(serialized).toContain('目标：润色整本小说');
    expect(serialized).toContain('进度：3/8');
    expect(serialized).toContain('收紧第四章（第四章）：进行中');
    expect(serialized).not.toMatch(/private-|taskId|stepId|revision|read_task_plan|JSON/iu);
  });

  it('does not under-count CJK manuscript text with the provider-neutral estimator', () => {
    const chinese = '雨夜里，柳青点亮了一盏灯。';
    const hanCount = [...chinese].filter((character) => /\p{Script=Han}/u.test(character)).length;

    expect(estimateAgentContextTextTokens(chinese)).toBeGreaterThanOrEqual(hanCount);
    expect(estimateAgentContextTextTokens('plain ascii prose')).toBeLessThan(
      'plain ascii prose'.length,
    );
    expect(estimateAgentContextTextTokens('🙂')).toBeGreaterThanOrEqual(2);
  });

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
        (segment) => segment.type === 'source' && segment.row.sourceId === 'thinking-2',
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
    expect(result.plan.checkpoint.coverage.discardedSourceIds).toEqual(['thinking-2']);
  });

  it('compacts older tool batches inside one oversized current turn', async () => {
    const rows: AgentContextSourceRow[] = [
      row('system', 0, null, 'system_policy', 'POLICY'),
      row('user-0', 1, 0, 'user', 'Inspect a large project.'),
    ];
    for (let index = 0; index < 3; index += 1) {
      rows.push(
        row(`call-${index}`, rows.length, 0, 'tool_call', `{"path":"/${index}"}`, {
          callId: `call-${index}`,
          toolName: 'read_node',
          toolAccess: 'read',
        }),
        row(
          `result-${index}`,
          rows.length + 1,
          0,
          'tool_result',
          `{"ok":true,"content":"${'x'.repeat(160_000)}"}`,
          {
            callId: `call-${index}`,
            toolName: 'read_node',
            toolAccess: 'read',
          },
        ),
      );
    }
    const fullCompactor = vi.fn(
      async ({ eligibleRuns }: AgentContextFullCompactionRequest) =>
        await Promise.all(
          eligibleRuns.map((sourceRows, index) =>
            createAgentContextSummaryCandidate({
              summaryId: `same-turn-${index}`,
              sourceRows,
              content: 'Earlier reads were completed; re-read current state when needed.',
            }),
          ),
        ),
    );

    const result = await planAgentContext({
      contextWindowTokens: 100_000,
      requestedOutputTokens: 4_096,
      fixedInputTokens: 0,
      sourceRows: rows,
      fullCompactor,
    });

    expect(result.ok).toBe(true);
    expect(fullCompactor).toHaveBeenCalledOnce();
    expect(
      fullCompactor.mock.calls[0]![0].eligibleRuns.flat().map((source) => source.sourceId),
    ).toEqual(['call-0', 'result-0', 'call-1', 'result-1']);
    expect(sourceSegment(result, 'call-2')).toMatchObject({ pinReason: 'recent_turn' });
    expect(sourceSegment(result, 'result-2')).toMatchObject({ pinReason: 'recent_turn' });
  });

  it('reserves room for accumulated summaries when a small window has many recent reads', async () => {
    const oldNarrative = row('assistant-old', 2, 0, 'assistant_narrative', '旧'.repeat(12_000));
    const rows: AgentContextSourceRow[] = [
      row('system', 0, null, 'system_policy', 'POLICY'),
      row('user-old', 1, 0, 'user', 'Earlier request'),
      oldNarrative,
      row('user-middle', 3, 1, 'user', 'Continue'),
      row('assistant-middle', 4, 1, 'assistant_narrative', 'Middle turn result'),
      row('user-current', 5, 2, 'user', 'Inspect the opening chapters'),
    ];
    for (let index = 0; index < 6; index += 1) {
      rows.push(
        row(`recent-call-${index}`, rows.length, 2, 'tool_call', `{"path":"/${index}"}`, {
          callId: `recent-${index}`,
          toolName: 'read_file',
          toolAccess: 'read',
        }),
        row(`recent-result-${index}`, rows.length + 1, 2, 'tool_result', '章'.repeat(8_000), {
          callId: `recent-${index}`,
          toolName: 'read_file',
          toolAccess: 'read',
        }),
      );
    }
    const deterministic = await createAgentContextSummaryCandidate({
      summaryId: 'existing-large-summary',
      sourceRows: [oldNarrative],
      content: '摘要'.repeat(2_500),
    });
    const fullCompactor = vi.fn(
      async ({ eligibleRuns }: AgentContextFullCompactionRequest) =>
        await Promise.all(
          eligibleRuns.map((sourceRows, index) =>
            createAgentContextSummaryCandidate({
              summaryId: `recent-summary-${index}`,
              sourceRows,
              content: 'Earlier exact reads were completed.',
            }),
          ),
        ),
    );

    const result = await planAgentContext({
      contextWindowTokens: 60_000,
      requestedOutputTokens: 8_192,
      fixedInputTokens: 2_200,
      sourceRows: rows,
      deterministicSummaries: [deterministic],
      fullCompactor,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fullCompactor).toHaveBeenCalledOnce();
    expect(result.plan.estimatedInputTokens).toBeLessThanOrEqual(
      result.plan.usableInputBudgetTokens,
    );
    expect(result.plan.checkpoint.compaction.stages).toEqual([
      'deterministic_summaries',
      'full_compactor',
    ]);
    expect(sourceSegment(result, 'recent-result-5')).toMatchObject({
      pinReason: 'recent_turn',
    });
    expect(sourceSegment(result, 'recent-result-0')).toBeUndefined();
  });

  it('hierarchically compacts prior verified summaries when no exact old rows remain eligible', async () => {
    const oldRows = [0, 1, 2].map((index) =>
      row(`old-${index}`, index + 2, 0, 'assistant_narrative', '旧'.repeat(6_000)),
    );
    const rows = [
      row('system', 0, null, 'system_policy', 'POLICY'),
      row('user-0', 1, 0, 'user', '整理整本书'),
      ...oldRows,
      row('user-1', 5, 1, 'user', '继续'),
      row('recent-1', 6, 1, 'assistant_narrative', '近'.repeat(2_500)),
      row('user-2', 7, 2, 'user', '继续完成'),
      row('recent-2', 8, 2, 'assistant_narrative', '新'.repeat(2_500)),
    ];
    const deterministicSummaries = await Promise.all(
      oldRows.map((source, index) =>
        createAgentContextSummaryCandidate({
          summaryId: `prior-summary-${index}`,
          sourceRows: [source],
          content: '摘要'.repeat(1_500),
        }),
      ),
    );
    const fullCompactor = vi.fn(async (request: AgentContextFullCompactionRequest) => {
      expect(request.eligibleRuns).toEqual([]);
      const units = request.eligibleProjectionRuns?.flat() ?? [];
      expect(units).toHaveLength(3);
      expect(
        units.flatMap((unit) => unit.projectionRows.map((projected) => projected.type)),
      ).toEqual(['summary', 'summary', 'summary']);
      return [
        await createAgentContextSummaryCandidate({
          summaryId: 'rolled-up-summary',
          sourceRows: units.flatMap((unit) => unit.sourceRows),
          content: '此前整理进度已合并；从最近步骤继续。',
        }),
      ];
    });

    const result = await planAgentContext({
      contextWindowTokens: 20_000,
      requestedOutputTokens: 4_096,
      fixedInputTokens: 0,
      sourceRows: rows,
      deterministicSummaries,
      fullCompactor,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fullCompactor).toHaveBeenCalledOnce();
    expect(result.plan.segments.filter((segment) => segment.type === 'summary')).toEqual([
      expect.objectContaining({
        summaryId: 'rolled-up-summary',
        sourceIds: oldRows.map((source) => source.sourceId),
      }),
    ]);
    expect(sourceSegment(result, 'recent-1')).toMatchObject({ pinReason: 'recent_turn' });
    expect(sourceSegment(result, 'recent-2')).toMatchObject({ pinReason: 'recent_turn' });
  });

  it('hierarchically compacts verified summaries that each contain a complete read-tool pair', async () => {
    const oldPairs = Array.from({ length: 3 }, (_, index) => {
      const tool = {
        callId: `read-${index}`,
        toolName: 'read_file',
        toolAccess: 'read' as const,
      };
      return [
        row(`old-call-${index}`, index * 2 + 2, 0, 'tool_call', '{"path":"/old"}', tool),
        row(`old-result-${index}`, index * 2 + 3, 0, 'tool_result', '旧'.repeat(6_000), tool),
      ] as const;
    });
    const rows = [
      row('system', 0, null, 'system_policy', 'POLICY'),
      row('user-0', 1, 0, 'user', '整理整本书'),
      ...oldPairs.flat(),
      row('user-1', 8, 1, 'user', '继续'),
      row('recent-1', 9, 1, 'assistant_narrative', '近'.repeat(2_000)),
      row('user-2', 10, 2, 'user', '继续完成'),
      row('recent-2', 11, 2, 'assistant_narrative', '新'.repeat(2_000)),
    ];
    const deterministicSummaries = await Promise.all(
      oldPairs.map((sourceRows, index) =>
        createAgentContextSummaryCandidate({
          summaryId: `prior-tool-summary-${index}`,
          sourceRows,
          content: '摘要'.repeat(2_500),
        }),
      ),
    );
    const fullCompactor = vi.fn(async (request: AgentContextFullCompactionRequest) => {
      expect(request.eligibleRuns).toEqual([]);
      const units = request.eligibleProjectionRuns?.flat() ?? [];
      expect(units).toHaveLength(3);
      expect(units.map((unit) => unit.projectionRows[0]?.type)).toEqual([
        'summary',
        'summary',
        'summary',
      ]);
      return [
        await createAgentContextSummaryCandidate({
          summaryId: 'rolled-up-tool-summary',
          sourceRows: units.flatMap((unit) => unit.sourceRows),
          content: '此前读取结果已合并；继续当前任务。',
        }),
      ];
    });

    const result = await planAgentContext({
      contextWindowTokens: 16_000,
      requestedOutputTokens: 4_096,
      fixedInputTokens: 0,
      sourceRows: rows,
      deterministicSummaries,
      fullCompactor,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fullCompactor).toHaveBeenCalledOnce();
    expect(result.plan.segments.filter((segment) => segment.type === 'summary')).toEqual([
      expect.objectContaining({
        summaryId: 'rolled-up-tool-summary',
        sourceIds: oldPairs.flat().map((source) => source.sourceId),
      }),
    ]);
  });

  it('drops raw writes immediately when exact pinned domain evidence covers the whole pair', async () => {
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user-0', 1, 0, 'user', 'old request'),
      row(
        'write-call',
        2,
        0,
        'tool_call',
        '{"callId":"call-write","name":"rename_node","arguments":{}}',
        {
          callId: 'call-write',
          toolName: 'rename_node',
          toolAccess: 'write',
        },
      ),
      row(
        'write-result',
        3,
        0,
        'tool_result',
        '{"callId":"call-write","name":"rename_node","result":{"ok":true}}',
        {
          callId: 'call-write',
          toolName: 'rename_node',
          toolAccess: 'write',
        },
      ),
      row('user-1', 4, 1, 'user', 'recent one'),
      row('assistant-1', 5, 1, 'assistant_narrative', 'one'),
      row('user-2', 6, 2, 'user', 'recent two'),
      row('assistant-2', 7, 2, 'assistant_narrative', 'two'),
      row('review-evidence', 8, 0, 'write_review', '{"reviewStatus":"accepted_effect"}'),
    ];
    const base = {
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
    };

    const defaultPlan = await planAgentContext(base);
    const mismatchedPlan = await planAgentContext({
      ...base,
      durableWriteEvidence: [
        {
          evidenceSourceId: 'review-evidence',
          turnOrdinal: 0,
          callId: 'wrong-call',
          toolName: 'rename_node',
        },
      ],
    });
    const coveredPlan = await planAgentContext({
      ...base,
      durableWriteEvidence: [
        {
          evidenceSourceId: 'review-evidence',
          turnOrdinal: 0,
          callId: 'call-write',
          toolName: 'rename_node',
        },
      ],
    });

    expect(sourceSegment(defaultPlan, 'write-call')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
    expect(sourceSegment(mismatchedPlan, 'write-call')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
    expect(sourceSegment(coveredPlan, 'write-call')).toBeUndefined();
    expect(sourceSegment(coveredPlan, 'write-result')).toBeUndefined();
    if (!coveredPlan.ok) return;
    expect(coveredPlan.plan.checkpoint.compaction.stages).toContain('drop_discardable');
    expect(sourceSegment(coveredPlan, 'review-evidence')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
  });

  it('drops same-turn pre-write prose after recovery while retaining the successful delta', async () => {
    const call = (
      callId: string,
      ordinal: number,
      path: string,
      replacements: unknown,
    ) =>
      row(
        `${callId}-call`,
        ordinal,
        0,
        'tool_call',
        JSON.stringify({
          type: 'tool_call',
          callId,
          name: 'edit_file',
          arguments: { path, replacements },
          rawArguments: JSON.stringify({ path, replacements }),
        }),
        { callId, toolName: 'edit_file', toolAccess: 'write' },
      );
    const result = (callId: string, ordinal: number, ok: boolean) =>
      row(
        `${callId}-result`,
        ordinal,
        0,
        'tool_result',
        JSON.stringify({ callId, name: 'edit_file', ok, content: ok ? 'updated' : 'stale' }),
        { callId, toolName: 'edit_file', toolAccess: 'write' },
      );
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user', 1, 0, 'user', '润色第三章'),
      row(
        'stale-read-call',
        2,
        0,
        'tool_call',
        JSON.stringify({
          type: 'tool_call',
          callId: 'stale-read',
          name: 'read_file',
          arguments: { path: '/chapters/03/' },
          rawArguments: '{"path":"/chapters/03/"}',
        }),
        { callId: 'stale-read', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'stale-read-result',
        3,
        0,
        'tool_result',
        JSON.stringify({ callId: 'stale-read', name: 'read_file', ok: true, content: '旧正文' }),
        { callId: 'stale-read', toolName: 'read_file', toolAccess: 'read' },
      ),
      call('failed-same-target', 4, '/chapters/03/prose.md', [
        { oldText: '旧'.repeat(2_000), newText: '新'.repeat(2_000) },
      ]),
      result('failed-same-target', 5, false),
      call('failed-other-target', 6, '/chapters/04/prose.md', [
        { oldText: '甲', newText: '乙' },
      ]),
      result('failed-other-target', 7, false),
      call('recovered', 8, '/chapters/03/prose.md', [{ oldText: '旧', newText: '新' }]),
      result('recovered', 9, true),
      row('review-evidence', 10, 0, 'write_review', '章节「03」正文的改动已写入。'),
    ];

    const planned = await planAgentContext({
      contextWindowTokens: 32_768,
      requestedOutputTokens: 4_096,
      fixedInputTokens: 0,
      sourceRows: rows,
      durableWriteEvidence: [
        {
          evidenceSourceId: 'review-evidence',
          turnOrdinal: 0,
          callId: 'recovered',
          toolName: 'edit_file',
        },
      ],
    });

    expect(sourceSegment(planned, 'failed-same-target-call')).toBeUndefined();
    expect(sourceSegment(planned, 'failed-same-target-result')).toBeUndefined();
    expect(sourceSegment(planned, 'stale-read-call')).toBeUndefined();
    expect(sourceSegment(planned, 'stale-read-result')).toBeUndefined();
    expect(sourceSegment(planned, 'recovered-call')).toMatchObject({
      classification: 'compressible',
      pinReason: 'recent_turn',
    });
    expect(sourceSegment(planned, 'recovered-result')).toMatchObject({
      classification: 'compressible',
      pinReason: 'recent_turn',
    });
    expect(sourceSegment(planned, 'failed-other-target-call')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
  });

  it('keeps one complete same-turn working copy across focused authored edits', async () => {
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user', 1, 0, 'user', '通读并润色第五章'),
      row(
        'read-call',
        2,
        0,
        'tool_call',
        JSON.stringify({ name: 'read_file', arguments: { path: '第五章' } }),
        { callId: 'read', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'read-result',
        3,
        0,
        'tool_result',
        JSON.stringify({
          callId: 'read',
          name: 'read_file',
          ok: true,
          content: '章节「05」正文\n完整正文'.repeat(1_000),
        }),
        { callId: 'read', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'write-call',
        4,
        0,
        'tool_call',
        JSON.stringify({
          name: 'edit_file',
          arguments: {
            path: '第五章',
            replacements: [{ oldText: '旧句', newText: '当前新句' }],
          },
        }),
        { callId: 'write', toolName: 'edit_file', toolAccess: 'write' },
      ),
      row(
        'write-result',
        5,
        0,
        'tool_result',
        JSON.stringify({
          callId: 'write',
          name: 'edit_file',
          ok: true,
          content:
            `章节「05」正文已修改。${WORKSPACE_COMPLETE_READ_MODEL_MARKER}，之后的修改已计入当前稿件。` +
            '当前修改后的正文片段：「当前新句」。',
        }),
        { callId: 'write', toolName: 'edit_file', toolAccess: 'write' },
      ),
      row('review', 6, 0, 'write_review', '章节「05」正文已有可靠完成证据。'),
      row(
        'read-progress',
        7,
        0,
        'read_progress',
        '章节「05」正文已在本轮完整通读，当前修改后片段：「当前新句」。',
      ),
    ];

    const planned = await planAgentContext({
      contextWindowTokens: 60_000,
      requestedOutputTokens: 5_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      durableWriteEvidence: [
        {
          evidenceSourceId: 'review',
          turnOrdinal: 0,
          callId: 'write',
          toolName: 'edit_file',
        },
      ],
    });

    expect(sourceSegment(planned, 'read-call')).toBeDefined();
    expect(sourceSegment(planned, 'read-result')).toBeDefined();
    expect(sourceSegment(planned, 'read-progress')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
  });

  it('drops a successful side-effect-free write while retaining an unresolved write', async () => {
    const toolRow = (
      sourceId: string,
      ordinal: number,
      callId: string,
      kind: 'tool_call' | 'tool_result',
      content: Record<string, unknown>,
    ) =>
      row(sourceId, ordinal, 0, kind, JSON.stringify(content), {
        callId,
        toolName: 'edit_file',
        toolAccess: 'write',
      });
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user', 1, 0, 'user', '检查第十二章，没必要改的地方就别动'),
      toolRow('noop-call', 2, 'noop', 'tool_call', {
        type: 'tool_call',
        callId: 'noop',
        name: 'edit_file',
        arguments: {
          path: '第十二章',
          replacements: [{ oldText: '已完成段落'.repeat(2_000), newText: '已完成段落'.repeat(2_000) }],
        },
      }),
      toolRow('noop-result', 3, 'noop', 'tool_result', {
        callId: 'noop',
        name: 'edit_file',
        ok: true,
        content: `章节「第十二章」正文${WORKSPACE_NOOP_WRITE_MODEL_MARKER}。直接继续剩余任务。`,
      }),
      toolRow('unresolved-call', 4, 'unresolved', 'tool_call', {
        type: 'tool_call',
        callId: 'unresolved',
        name: 'edit_file',
        arguments: {
          path: '第十一章',
          replacements: [{ oldText: '待改', newText: '新稿' }],
        },
      }),
      toolRow('unresolved-result', 5, 'unresolved', 'tool_result', {
        callId: 'unresolved',
        name: 'edit_file',
        ok: false,
        content: 'write failed',
      }),
    ];

    const planned = await planAgentContext({
      contextWindowTokens: 32_768,
      requestedOutputTokens: 4_096,
      fixedInputTokens: 0,
      sourceRows: rows,
    });

    expect(sourceSegment(planned, 'noop-call')).toBeUndefined();
    expect(sourceSegment(planned, 'noop-result')).toBeUndefined();
    expect(sourceSegment(planned, 'unresolved-call')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
    expect(sourceSegment(planned, 'unresolved-result')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
  });

  it('drops an older complete read when a newer complete read covers the same authored object', async () => {
    const readPair = (prefix: string, ordinal: number, content: string) => [
      row(
        `${prefix}-call`,
        ordinal,
        0,
        'tool_call',
        JSON.stringify({
          type: 'tool_call',
          callId: prefix,
          name: 'read_file',
          arguments: { path: '第七章' },
          rawArguments: '{"path":"第七章"}',
        }),
        { callId: prefix, toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        `${prefix}-result`,
        ordinal + 1,
        0,
        'tool_result',
        JSON.stringify({ callId: prefix, name: 'read_file', ok: true, content }),
        { callId: prefix, toolName: 'read_file', toolAccess: 'read' },
      ),
    ] as const;
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user', 1, 0, 'user', '整理第七章'),
      ...readPair('read-old', 2, '章节「07」正文\n旧正文'),
      ...readPair('read-current', 4, '章节「07」正文\n当前正文'),
    ];

    const planned = await planAgentContext({
      contextWindowTokens: 16_000,
      requestedOutputTokens: 4_096,
      fixedInputTokens: 0,
      sourceRows: rows,
      constraintLedger: [],
    });

    expect(sourceSegment(planned, 'read-old-call')).toBeUndefined();
    expect(sourceSegment(planned, 'read-old-result')).toBeUndefined();
    expect(sourceSegment(planned, 'read-current-call')).toMatchObject({
      classification: 'compressible',
      pinReason: 'recent_turn',
    });
    expect(sourceSegment(planned, 'read-current-result')).toMatchObject({
      classification: 'compressible',
      pinReason: 'recent_turn',
    });
  });

  it('retires a cached summary when a later read makes one covered source discardable', async () => {
    const assistantOld = row(
      'assistant-old',
      2,
      0,
      'assistant_narrative',
      '旧'.repeat(7_000),
    );
    const oldRead = [
      row(
        'read-old-call',
        6,
        2,
        'tool_call',
        JSON.stringify({
          callId: 'read-old',
          name: 'read_file',
          arguments: { path: '第三章' },
        }),
        { callId: 'read-old', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'read-old-result',
        7,
        2,
        'tool_result',
        JSON.stringify({ callId: 'read-old', name: 'read_file', ok: true, content: '旧正文' }),
        { callId: 'read-old', toolName: 'read_file', toolAccess: 'read' },
      ),
    ] as const;
    const currentRead = [
      row(
        'read-current-call',
        8,
        2,
        'tool_call',
        JSON.stringify({
          callId: 'read-current',
          name: 'read_file',
          arguments: { path: '第三章' },
        }),
        { callId: 'read-current', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'read-current-result',
        9,
        2,
        'tool_result',
        JSON.stringify({
          callId: 'read-current',
          name: 'read_file',
          ok: true,
          content: '章节「03」正文\n' + '新'.repeat(1_000),
        }),
        { callId: 'read-current', toolName: 'read_file', toolAccess: 'read' },
      ),
    ] as const;
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user-old', 1, 0, 'user', '旧请求'),
      assistantOld,
      row('user-middle', 3, 1, 'user', '继续'),
      row('assistant-middle', 4, 1, 'assistant_narrative', '继续中'),
      row('user-current', 5, 2, 'user', '整理第三章'),
      ...oldRead,
      ...currentRead,
    ];
    const obsolete = await createAgentContextSummaryCandidate({
      summaryId: 'obsolete-read-summary',
      sourceRows: oldRead,
      content: '旧读取已完成。',
    });
    const useful = await createAgentContextSummaryCandidate({
      summaryId: 'useful-history-summary',
      sourceRows: [assistantOld],
      content: '此前对话没有未完成事项。',
    });

    const planned = await planAgentContext({
      contextWindowTokens: 12_000,
      requestedOutputTokens: 4_096,
      fixedInputTokens: 0,
      sourceRows: rows,
      constraintLedger: [],
      deterministicSummaries: [obsolete, useful],
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(
      planned.plan.segments.some(
        (segment) => segment.type === 'summary' && segment.summaryId === obsolete.summaryId,
      ),
    ).toBe(false);
    expect(
      planned.plan.segments.some(
        (segment) => segment.type === 'summary' && segment.summaryId === useful.summaryId,
      ),
    ).toBe(true);
    expect(sourceSegment(planned, 'read-old-result')).toBeUndefined();
    expect(sourceSegment(planned, 'read-current-result')).toMatchObject({
      pinReason: 'recent_turn',
    });
  });

  it('keeps a bounded multi-chapter authored working set exact when it fits the window', async () => {
    const rows: AgentContextSourceRow[] = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user', 1, 0, 'user', '整理第七章到第十章'),
    ];
    for (let chapter = 7; chapter <= 10; chapter += 1) {
      const callId = `read-${chapter}`;
      rows.push(
        row(
          `${callId}-call`,
          rows.length,
          0,
          'tool_call',
          JSON.stringify({
            type: 'tool_call',
            callId,
            name: 'read_file',
            arguments: { path: `第${chapter}章` },
          }),
          { callId, toolName: 'read_file', toolAccess: 'read' },
        ),
        row(
          `${callId}-result`,
          rows.length + 1,
          0,
          'tool_result',
          JSON.stringify({
            callId,
            name: 'read_file',
            ok: true,
            content: `章节「${chapter}」正文\n${'章'.repeat(6_000)}`,
          }),
          { callId, toolName: 'read_file', toolAccess: 'read' },
        ),
      );
    }

    const planned = await planAgentContext({
      contextWindowTokens: 60_000,
      requestedOutputTokens: 8_192,
      fixedInputTokens: 2_000,
      sourceRows: rows,
      constraintLedger: [],
    });

    expect(planned.ok).toBe(true);
    for (let chapter = 7; chapter <= 10; chapter += 1) {
      expect(sourceSegment(planned, `read-${chapter}-result`)).toMatchObject({
        pinReason: 'recent_turn',
      });
    }
  });

  it('lets a pinned canonical task snapshot replace accumulated long-task metadata results', async () => {
    const taskPairs = Array.from({ length: 24 }, (_, index) => {
      const callId = `task-step-${index}`;
      return [
        row(
          `task-call-${index}`,
          2 + index * 2,
          0,
          'tool_call',
          `{"callId":"${callId}","name":"update_task_step","arguments":{"step":${index}}}`,
          {
            callId,
            toolName: 'update_task_step',
            toolAccess: 'write',
          },
        ),
        row(
          `task-result-${index}`,
          3 + index * 2,
          0,
          'tool_result',
          `{"callId":"${callId}","plan":"${'x'.repeat(4_000)}"}`,
          {
            callId,
            toolName: 'update_task_step',
            toolAccess: 'write',
          },
        ),
      ] as const;
    }).flat();
    const taskPlanOrdinal = 2 + taskPairs.length + 6;
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user-0', 1, 0, 'user', 'run the whole-book task'),
      ...taskPairs,
      row('assistant-0', 2 + taskPairs.length, 0, 'assistant_narrative', 'slice complete'),
      row('user-1', 3 + taskPairs.length, 1, 'user', 'continue'),
      row('assistant-1', 4 + taskPairs.length, 1, 'assistant_narrative', 'continuing'),
      row('user-2', 5 + taskPairs.length, 2, 'user', 'continue again'),
      row('assistant-2', 6 + taskPairs.length, 2, 'assistant_narrative', 'continuing again'),
      row(
        'task-plan',
        taskPlanOrdinal,
        null,
        'task_plan',
        '{"taskId":"whole-book","revision":24,"nextStep":25}',
      ),
    ];
    const summary = await createAgentContextSummaryCandidate({
      summaryId: 'task-command-archive',
      sourceRows: taskPairs,
      content:
        'Twenty-four durable task-step commands are represented by the pinned canonical task plan.',
    });
    const base = {
      contextWindowTokens: 12_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      constraintLedger: [],
      deterministicSummaries: [summary],
    };
    const defaultPlan = await planAgentContext(base);
    const coveredPlan = await planAgentContext({
      ...base,
      durableWriteEvidence: taskPairs
        .filter((taskRow) => taskRow.kind === 'tool_call')
        .map((taskRow) => ({
          evidenceSourceId: 'task-plan',
          turnOrdinal: taskRow.turnOrdinal!,
          callId: taskRow.callId!,
          toolName: taskRow.toolName!,
        })),
    });

    expect(defaultPlan).toMatchObject({
      ok: false,
      error: { code: 'PINNED_CONTEXT_EXCEEDS_BUDGET' },
    });
    expect(coveredPlan.ok).toBe(true);
    if (!coveredPlan.ok) return;
    expect(coveredPlan.plan.checkpoint.compaction.stages).toEqual(['drop_discardable']);
    expect(
      coveredPlan.plan.segments.find(
        (segment) => segment.type === 'summary' && segment.summaryId === 'task-command-archive',
      ),
    ).toBeUndefined();
    expect(sourceSegment(coveredPlan, 'task-plan')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
  });

  it('compacts old ordinary user rows only under an exact verified constraint ledger', async () => {
    const rows = baseRows();
    const verified = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      constraintLedger: [],
    });
    const legacy = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
    });

    expect(verified.ok).toBe(true);
    expect(legacy.ok).toBe(true);
    if (!verified.ok || !legacy.ok) return;
    expect(sourceSegment(verified, 'user-0')).toMatchObject({
      classification: 'compressible',
      pinReason: null,
    });
    expect(sourceSegment(legacy, 'user-0')).toMatchObject({
      classification: 'pinned',
      pinReason: 'semantic',
    });
    expect(verified.plan.checkpoint.constraintLedger).toMatchObject({
      mode: 'verified',
      entries: [],
      ledgerHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(legacy.plan.checkpoint.constraintLedger).toMatchObject({
      mode: 'legacy_all_user',
      entries: expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'user-0',
          kind: 'legacy_user',
        }),
      ]),
    });
  });

  it('pins ledger-bound author constraints and rejects a stale source hash', async () => {
    const rows = baseRows();
    const constraint = rows[1]!;
    const ledger = [
      {
        constraintId: 'author-rule-1',
        sourceId: constraint.sourceId,
        sourceHash: await hashAgentContextSourceRows([constraint]),
        kind: 'author_instruction' as const,
      },
    ];
    const valid = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      constraintLedger: ledger,
    });
    const stale = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      constraintLedger: [
        {
          ...ledger[0],
          sourceHash: `sha256:${'0'.repeat(64)}`,
        },
      ],
    });

    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(sourceSegment(valid, constraint.sourceId)).toMatchObject({
        classification: 'pinned',
        pinReason: 'semantic',
        row: { content: constraint.content },
      });
      expect(valid.plan.checkpoint.constraintLedger.entries).toEqual(ledger);
      expect(valid.plan.checkpoint.constraintLedger.retentionWitness).toEqual({
        status: 'exact',
        sourceIds: [constraint.sourceId],
        sourceHash: await hashAgentContextSourceRows([constraint]),
      });
    }
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'INVALID_CONTEXT' },
    });
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
        (segment) => segment.type === 'summary' && segment.summaryId === 'summary-old',
      ),
    ).toMatchObject({
      producer: 'deterministic',
      sourceIds: ['assistant-0'],
    });
  });

  it('budgets the provider wire summary while retaining all 3000 internal source ids', async () => {
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
      estimateAgentContextTextTokens(serializeAgentContextSummaryBudgetPayload(summary)) + 8;

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
      (segment) => segment.type === 'summary' && segment.summaryId === 'summary-3000-sources',
    );
    expect(summarySegment?.estimatedTokens).toBe(expectedSummaryTokens);
    expect(expectedSummaryTokens).toBeLessThan(200);
    expect(summarySegment?.type).toBe('summary');
    if (summarySegment?.type === 'summary') {
      expect(summarySegment.sourceIds).toHaveLength(3_000);
    }

    const constrained = await planAgentContext({
      contextWindowTokens: 20_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      deterministicSummaries: [summary],
    });
    expect(constrained.ok).toBe(true);
  });

  it('charges the exact provider-facing domain note without private provenance', async () => {
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
    expect(sourceSegment(result, freshness.sourceId)?.estimatedTokens).toBe(expected);
    expect(expected).toBeLessThan(200);
    expect(
      serializeAgentContextNoteBudgetPayload({
        noteKind: 'freshness',
        sourceId: freshness.sourceId,
        turnOrdinal: null,
        content: freshness.content,
      }),
    ).not.toContain('source-identity');
  });

  it('accepts a positive verified full-compactor projection', async () => {
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

  it('continues bounded full-compactor passes while each pass makes positive progress', async () => {
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user-0', 1, 0, 'user', 'clean the book'),
      row('assistant-0', 2, 0, 'assistant_narrative', 'old alpha '.repeat(5_000)),
      row('assistant-1', 3, 0, 'assistant_narrative', 'old beta '.repeat(5_000)),
      row('user-1', 4, 1, 'user', 'continue'),
      row('assistant-2', 5, 1, 'assistant_narrative', 'recent'),
    ];
    let calls = 0;
    const result = await planAgentContext({
      contextWindowTokens: 8_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      fullCompactor: async ({ eligibleProjectionRuns, eligibleRuns }) => {
        calls += 1;
        const sourceRows =
          eligibleProjectionRuns?.flatMap((run) => run.flatMap((unit) => unit.sourceRows)) ??
          eligibleRuns.flat();
        const target = sourceRows.find(
          (candidate) => candidate.sourceId === (calls === 1 ? 'assistant-0' : 'assistant-1'),
        );
        return target
          ? [
              await createAgentContextSummaryCandidate({
                summaryId: `progressive-${calls}`,
                sourceRows: [target],
                content: `compact ${calls}`,
              }),
            ]
          : [];
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(2);
    expect(result.plan.checkpoint.compaction.fullCompactionCount).toBe(2);
    expect(result.plan.estimatedInputTokens).toBeLessThanOrEqual(
      result.plan.usableInputBudgetTokens,
    );
  });

  it('releases the oldest soft recent pin when verified older summaries cannot shrink further', async () => {
    const oldNarrative = row('assistant-old', 2, 0, 'assistant_narrative', '旧正文'.repeat(8_000));
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user-old', 1, 0, 'user', '整理前半本'),
      oldNarrative,
      row('user-1', 3, 1, 'user', '继续检查'),
      row('assistant-1', 4, 1, 'assistant_narrative', '近期一'.repeat(1_000)),
      row('user-2', 5, 2, 'user', '继续收尾'),
      row('assistant-2', 6, 2, 'assistant_narrative', '近期二'.repeat(1_000)),
    ];
    const prior = await createAgentContextSummaryCandidate({
      summaryId: 'already-minimal-prior',
      sourceRows: [oldNarrative],
      content: '既有证据摘要'.repeat(1_000),
    });
    let calls = 0;

    const result = await planAgentContext({
      contextWindowTokens: 12_000,
      requestedOutputTokens: 2_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      constraintLedger: [],
      deterministicSummaries: [prior],
      fullCompactor: async (request) => {
        calls += 1;
        const units = request.eligibleProjectionRuns?.[0] ?? [];
        const sourceRows = units.flatMap((unit) => unit.sourceRows);
        return sourceRows.length === 0
          ? []
          : [
              await createAgentContextSummaryCandidate({
                summaryId: `soft-recent-${calls}`,
                sourceRows,
                content:
                  calls === 1 ? '不会产生收益的摘要'.repeat(2_000) : '旧进度与最早近期消息已合并。',
              }),
            ];
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(2);
    expect(result.plan.checkpoint.compaction.fullCompactionCount).toBe(2);
    expect(sourceSegment(result, 'user-1')).toBeUndefined();
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
      row('denied-result', 3, 0, 'tool_result', '{"ok":false,"errorCode":"UNKNOWN_TOOL"}', denied),
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

  it('never offers half of a parallel read pair across a pinned write to the full compactor', async () => {
    const write = {
      callId: 'write-1',
      toolName: 'edit_node',
      toolAccess: 'write' as const,
    };
    const read = {
      callId: 'read-1',
      toolName: 'read_node',
      toolAccess: 'read' as const,
    };
    const rows = [
      row('system', 0, null, 'system_policy', 'policy'),
      row('user-0', 1, 0, 'user', 'clean the manuscript'),
      row('old-narrative', 2, 0, 'assistant_narrative', 'history '.repeat(6_000)),
      row('write-call', 3, 0, 'tool_call', '{"path":"chapter"}', write),
      row('read-call', 4, 0, 'tool_call', '{"path":"chapter"}', read),
      row('write-result', 5, 0, 'tool_result', '{"updated":true}', write),
      row('read-result', 6, 0, 'tool_result', 'chapter '.repeat(6_000), read),
      row('user-1', 7, 1, 'user', 'continue'),
      row('assistant-1', 8, 1, 'assistant_narrative', 'recent one'),
      row('user-2', 9, 2, 'user', 'keep going'),
      row('assistant-2', 10, 2, 'assistant_narrative', 'recent two'),
    ];
    let offered: readonly (readonly AgentContextSourceRow[])[] = [];

    await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      fullCompactor: async (request) => {
        offered = request.eligibleRuns;
        return [];
      },
    });

    const offeredIds = offered.flatMap((run) => run.map((item) => item.sourceId));
    expect(offeredIds).toContain('old-narrative');
    expect(offeredIds).not.toContain('read-call');
    expect(offeredIds).not.toContain('read-result');
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

  it('keeps a no-gain short chunk exact while applying profitable full-compactor chunks', async () => {
    const rows = [
      row('system', 0, null, 'system_policy', 'POLICY'),
      row('user-0', 1, 0, 'user', 'goal'),
      row('assistant-0', 2, 0, 'assistant_narrative', 'old history '.repeat(6_000)),
      row('user-1', 3, 1, 'user', 'next'),
      row('assistant-1', 4, 1, 'assistant_narrative', 'tiny old tail'),
      row('user-2', 5, 2, 'user', 'recent one'),
      row('assistant-2', 6, 2, 'assistant_narrative', 'recent answer one'),
      row('user-3', 7, 3, 'user', 'recent two'),
      row('assistant-3', 8, 3, 'assistant_narrative', 'recent answer two'),
    ];

    const result = await planAgentContext({
      contextWindowTokens: 10_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 0,
      sourceRows: rows,
      fullCompactor: async ({ eligibleRuns }) =>
        await Promise.all(
          eligibleRuns.map((sourceRows, index) =>
            createAgentContextSummaryCandidate({
              summaryId: `mixed-gain-${index}`,
              sourceRows,
              content: index === 0 ? 'profitable summary' : 'no gain metadata tail',
            }),
          ),
        ),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.plan.segments.some(
        (segment) => segment.type === 'summary' && segment.summaryId === 'mixed-gain-0',
      ),
    ).toBe(true);
    expect(sourceSegment(result, 'assistant-1')).toMatchObject({
      type: 'source',
      row: { content: 'tiny old tail' },
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
    expect(first.plan.checkpoint.pinned.sourceHash).toBe(second.plan.checkpoint.pinned.sourceHash);
  });
});
