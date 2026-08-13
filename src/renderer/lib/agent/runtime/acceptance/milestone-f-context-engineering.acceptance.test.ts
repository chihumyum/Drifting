import { describe, expect, it, vi } from 'vitest';

import type { AICompletionRequest, AICompletionResponse } from '../../../ai/types';
import {
  planAgentModelContext,
  verifyAgentContextProviderEnvelope,
  type AgentContextProviderEnvelopeV2,
} from '../context-message-adapter';
import { rankAgentContextEvidence } from '../context-evidence-retrieval';
import { createDriftingContextCompactor } from '../drifting-context-compactor';
import {
  AgentRuntimeContextPlanningCoordinator,
  identifyExplicitAgentUserConstraints,
  type AgentRuntimeContextPlanningRequest,
  type AgentRuntimeVerifiedContextPlan,
} from '../runtime-context-planning';
import type { AgentModelMessage, AgentModelToolDefinition, AgentToolDefinition } from '../types';
import { parseDriftingLiteraryContextSummary } from '../literary-context-summary';
import { loadMilestoneFLiteraryFixture } from './milestone-f-literary-fixture';

const ROUTE = { kind: 'chat', projectId: 'fog-harbor-distilled' } as const;
const READ_FILE: AgentToolDefinition = {
  name: 'read_file',
  description: 'Read one semantic manuscript path.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  access: 'read',
  validateInput: (value) => ({ ok: true, value }),
};
const PROVIDER_READ_FILE: AgentModelToolDefinition = {
  name: READ_FILE.name,
  description: READ_FILE.description,
  inputSchema: READ_FILE.inputSchema,
};

interface CompactionPayloadRow {
  sourceId: string;
  kind: string;
  content: string;
}

interface LongBookHistory {
  slices: AgentModelMessage[][];
  oracleEvidenceIds: string[];
}

function toolCall(callId: string, path: string): AgentModelMessage {
  const args = { path };
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_call',
        callId,
        name: 'read_file',
        arguments: args,
        rawArguments: JSON.stringify(args),
      },
    ],
  };
}

function addReadTurn(
  messages: AgentModelMessage[],
  input: { callId: string; prompt: string; path: string; content: string },
): void {
  messages.push(
    { role: 'user', content: input.prompt },
    toolCall(input.callId, input.path),
    {
      role: 'tool',
      content: [
        {
          callId: input.callId,
          name: 'read_file',
          ok: true,
          content: input.content,
        },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: `已取得 ${input.path} 的当前证据。` }],
    },
  );
}

function buildLongBookHistory(): LongBookHistory {
  const fixture = loadMilestoneFLiteraryFixture();
  const messages: AgentModelMessage[] = [
    { role: 'user', content: '润色整本《雾港纪事》，逐章核对设定并完成，不要漏章。' },
    { role: 'assistant', content: [{ type: 'text', text: '我会按整书计划执行。' }] },
    { role: 'user', content: '必须保持人物既有说话节奏、有限视角和叙事时态。' },
    { role: 'assistant', content: [{ type: 'text', text: '已固定写作约束。' }] },
    { role: 'user', content: '不要为了润色改写已经确立的世界观事实或人物关系。' },
    { role: 'assistant', content: [{ type: 'text', text: '不会擅自改动正典。' }] },
    { role: 'user', content: '主角的身份是留存者，这条事实以此为准。' },
    { role: 'assistant', content: [{ type: 'text', text: '已记录作者事实。' }] },
  ];

  for (const [index, oracle] of fixture.oracle.entries()) {
    addReadTurn(messages, {
      callId: `oracle-${index}`,
      prompt: `核对证据条目 ${oracle.id}`,
      path: `/oracle/${encodeURIComponent(oracle.id)}.json`,
      content: JSON.stringify({
        evidenceId: oracle.expectedEvidenceId,
        dimension: oracle.dimension,
        text: oracle.expectedText,
      }),
    });
  }

  const syntheticDocuments = fixture.documents.filter((document) =>
    document.evidenceId.startsWith('synthetic-chapter:'),
  );
  const slices: AgentModelMessage[][] = [];
  for (let pass = 1; pass <= 3; pass += 1) {
    for (const [index, document] of syntheticDocuments.entries()) {
      addReadTurn(messages, {
        callId: `synthetic-${pass}-${index}`,
        prompt: `继续处理整书证据批次 ${pass} 的章节 ${index + 1}`,
        path: `/chapters/pass-${pass}/${encodeURIComponent(document.title ?? document.evidenceId)}.md`,
        content: document.fields.map((field) => field.text).join('\n'),
      });
    }
    slices.push(messages.map((message) => structuredClone(message)));
  }
  return {
    slices,
    oracleEvidenceIds: fixture.oracle.map((oracle) => oracle.expectedEvidenceId),
  };
}

function exactQuote(content: string): string {
  return [...content].slice(0, 180).join('').trim();
}

function compactorResponse(request: AICompletionRequest): AICompletionResponse {
  const raw = request.messages[0]?.content;
  if (typeof raw !== 'string') throw new Error('missing compaction payload');
  const payload = JSON.parse(raw) as { rows: CompactionPayloadRow[] };
  const evidence = payload.rows.flatMap((row) => {
    if (row.kind !== 'tool_result') return [];
    const outer = JSON.parse(row.content) as { content?: unknown };
    const providerContent = typeof outer.content === 'string' ? outer.content : '';
    let parsed: { evidenceId?: unknown; dimension?: unknown; text?: unknown } | undefined;
    try {
      parsed = JSON.parse(providerContent) as typeof parsed;
    } catch {
      parsed = undefined;
    }
    const dimension = typeof parsed?.dimension === 'string' ? parsed.dimension : null;
    const claim =
      typeof parsed?.evidenceId === 'string'
        ? JSON.stringify({
            evidenceId: parsed.evidenceId,
            dimension,
            text: parsed.text,
          })
        : `Manuscript evidence read successfully: ${providerContent.slice(0, 240)}`;
    return [
      {
        sourceId: row.sourceId,
        kind:
          dimension === 'character_voice'
            ? ('character_voice' as const)
            : dimension === 'writing_rule'
              ? ('author_decision' as const)
              : dimension === 'chapter_evidence'
                ? ('task_progress' as const)
                : ('canon_fact' as const),
        claim,
        quote: exactQuote(row.content),
      },
    ];
  });
  return {
    toolCall: {
      id: `summary-${String(request.metadata?.compactionRunIndex ?? 0)}-${String(request.metadata?.compactionChunkIndex ?? 0)}`,
      name: 'submit_context_summary',
      arguments: {
        summary: `Compacted ${payload.rows.length} canonical rows with ${evidence.length} exact evidence citations.`,
        evidence,
        decisions: [],
        unresolved: [],
        nextActions: ['Continue the durable whole-book plan from the next unfinished chapter.'],
      },
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function planningRequest(
  messages: readonly AgentModelMessage[],
  iteration: number,
  turnId: string,
): AgentRuntimeContextPlanningRequest {
  return {
    purpose: 'provider_call',
    sessionId: 'milestone-f-session',
    turnId,
    iteration,
    driverId: 'deterministic-literary-driver',
    model: 'deterministic-literary-model',
    context: { route: ROUTE },
    systemPrompt: 'Work as Drifting literary Agent and preserve cited author truth.',
    messages,
    executableDefinitions: [READ_FILE],
    selectedTools: [PROVIDER_READ_FILE],
    requestedOutputTokens: 8_192,
    signal: new AbortController().signal,
  };
}

function summariesFromPlan(plan: AgentRuntimeVerifiedContextPlan) {
  return plan.envelope.plannerCheckpoint.projection.segments.flatMap((segment) =>
    segment.type === 'summary'
      ? [
          {
            summaryId: segment.summaryId,
            sourceIds: [...segment.sourceIds],
            sourceHash: segment.sourceHash,
            content: segment.content,
          },
        ]
      : [],
  );
}

function providerEvidenceIds(envelope: AgentContextProviderEnvelopeV2): Set<string> {
  const ids = new Set<string>();
  for (const message of envelope.providerContext.messages) {
    if (message.type === 'context_summary') {
      const summary = parseDriftingLiteraryContextSummary(message.content);
      for (const citation of summary?.evidence ?? []) {
        try {
          const claim = JSON.parse(citation.claim) as { evidenceId?: unknown };
          if (typeof claim.evidenceId === 'string') ids.add(claim.evidenceId);
        } catch {
          // Synthetic literary citations intentionally use a prose claim.
        }
      }
      continue;
    }
    if (message.type !== 'model_message' || message.message.role !== 'tool') continue;
    for (const result of message.message.content) {
      try {
        const content = JSON.parse(result.content) as { evidenceId?: unknown };
        if (typeof content.evidenceId === 'string') ids.add(content.evidenceId);
      } catch {
        // Synthetic literary reads are measured by source coverage, not copied.
      }
    }
  }
  return ids;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

describe('Milestone F context engineering acceptance', () => {
  it('keeps a durable long prose write canonical while removing its transport payload from the next model call', async () => {
    const callId = 'paid-writing-shape-write';
    const transportSentinel = String.raw`\"TRANSPORT_SENTINEL\"\他说。`;
    const prose = `${transportSentinel}\n${'长篇正文。'.repeat(8_000)}`;
    const planned = await planAgentModelContext({
      systemPrompt: 'Reason only about the authored work.',
      messages: [
        { role: 'user', content: '把这一章润色完整。' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId,
              name: 'write_file',
              arguments: { path: '/chapters/第三章/prose.md', content: prose },
              rawArguments: JSON.stringify({
                path: '/chapters/第三章/prose.md',
                content: prose,
              }),
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              callId,
              name: 'write_file',
              ok: true,
              content: '{"updated":true,"path":"/chapters/第三章/prose.md","writeRef":"private"}',
            },
          ],
        },
        { role: 'user', content: '继续。' },
      ],
      resolveToolAccess: (name) => (name === 'write_file' ? 'write' : null),
      supplementalRows: [
        {
          sourceId: 'write-receipt:private-session:committed',
          turnOrdinal: 0,
          kind: 'write_receipt',
          content:
            '章节「第三章」正文已更新。这一步已经完成；直接继续剩余任务，不要为了确认写入而重读。',
          durableWriteCoverage: [{ turnOrdinal: 0, callId, toolName: 'write_file' }],
        },
      ],
      planner: {
        contextWindowTokens: 200_000,
        requestedOutputTokens: 8_192,
        fixedInputTokens: 0,
      },
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    await expect(
      verifyAgentContextProviderEnvelope({
        envelope: planned.envelope,
        canonicalSourceRows: planned.bridge.sourceRows,
      }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(planned.bridge.sourceRows)).toContain('TRANSPORT_SENTINEL');
    const providerProjection = JSON.stringify(planned.envelope.providerContext);
    expect(providerProjection).toContain('章节「第三章」正文已更新');
    expect(providerProjection).not.toMatch(
      /TRANSPORT_SENTINEL|长篇正文|\/chapters\/第三章|writeRef|rawArguments/,
    );
    expect(planned.plan.checkpoint.coverage.discardedSourceIds).toEqual(
      expect.arrayContaining(
        planned.bridge.sourceRows.filter((row) => row.callId === callId).map((row) => row.sourceId),
      ),
    );
  });

  it('preserves literary evidence and author constraints across 200k multi-slice compaction, restart, and compactor faults', async () => {
    const fixture = loadMilestoneFLiteraryFixture();
    const retrievalByDimension = new Map<string, { hits: number; total: number }>();
    for (const oracle of fixture.oracle) {
      const results = rankAgentContextEvidence({
        query: oracle.query,
        documents: fixture.documents,
        limit: 5,
      });
      const metric = retrievalByDimension.get(oracle.dimension) ?? { hits: 0, total: 0 };
      metric.total += 1;
      if (results.some((result) => result.evidenceId === oracle.expectedEvidenceId)) {
        metric.hits += 1;
      }
      retrievalByDimension.set(oracle.dimension, metric);
    }

    const complete = vi.fn(async (request: AICompletionRequest) => compactorResponse(request));
    const fullCompactor = createDriftingContextCompactor({
      createClient: async () => ({ supportsTools: true, complete }),
      maxInputTokensPerRequest: 18_000,
    });
    const coordinator = new AgentRuntimeContextPlanningCoordinator({
      contextWindowTokens: 200_000,
      providerProfileId: 'milestone-f-200k-v1',
      providerMaxOutputTokens: 8_192,
      providerOverheadTokens: 512,
      perToolOverheadTokens: 8,
      userConstraintPolicy: identifyExplicitAgentUserConstraints,
      fullCompactor,
    });
    const history = buildLongBookHistory();
    const plans: AgentRuntimeVerifiedContextPlan[] = [];
    for (const [index, messages] of history.slices.entries()) {
      const plan = await coordinator.plan(
        planningRequest(messages, index + 1, `slice-${index + 1}`),
      );
      await expect(
        verifyAgentContextProviderEnvelope({
          envelope: plan.envelope,
          canonicalSourceRows: plan.canonicalSourceRows,
        }),
      ).resolves.toBeUndefined();
      plans.push(plan);
    }

    const finalPlan = plans[plans.length - 1]!;
    const projectedEvidenceIds = providerEvidenceIds(finalPlan.envelope);
    const evidenceHits = history.oracleEvidenceIds.filter((id) => projectedEvidenceIds.has(id));
    const voiceCases = fixture.oracle.filter((item) => item.dimension === 'character_voice');
    const voiceHits = voiceCases.filter((item) =>
      projectedEvidenceIds.has(item.expectedEvidenceId),
    );
    const ledger = finalPlan.envelope.plannerCheckpoint.constraintLedger;
    const rowById = new Map(
      finalPlan.canonicalSourceRows.map((row) => [row.sourceId, row] as const),
    );
    const providerProjection = JSON.stringify(finalPlan.envelope.providerContext);
    const retainedConstraints = ledger.entries.filter((entry) =>
      providerProjection.includes(rowById.get(entry.sourceId)?.content ?? '\u0000'),
    );
    const compactedPlans = plans.filter((plan) => plan.contextUsage.compaction.stages.length > 0);
    const tokenReductions = compactedPlans.map((plan) =>
      ratio(
        plan.contextUsage.compaction.savedTokens,
        plan.contextUsage.compaction.initialSourceTokens,
      ),
    );
    const contextWindowRatios = plans.map((plan) =>
      ratio(plan.contextUsage.estimatedInputTokens, plan.contextUsage.contextWindowTokens),
    );

    const restartCompactor = vi.fn(async () => {
      throw new Error('restart should reuse verified summaries');
    });
    const restartedCoordinator = new AgentRuntimeContextPlanningCoordinator({
      contextWindowTokens: 200_000,
      providerProfileId: 'milestone-f-200k-v1',
      providerMaxOutputTokens: 8_192,
      providerOverheadTokens: 512,
      perToolOverheadTokens: 8,
      userConstraintPolicy: identifyExplicitAgentUserConstraints,
      deterministicSummaries: summariesFromPlan(finalPlan),
      fullCompactor: restartCompactor,
    });
    const restarted = await restartedCoordinator.plan(
      planningRequest(history.slices[history.slices.length - 1]!, 4, 'slice-after-restart'),
    );
    await expect(
      verifyAgentContextProviderEnvelope({
        envelope: restarted.envelope,
        canonicalSourceRows: restarted.canonicalSourceRows,
      }),
    ).resolves.toBeUndefined();

    const faultCompactor = vi.fn(async () => {
      throw new Error('injected compactor outage');
    });
    const faultCoordinator = new AgentRuntimeContextPlanningCoordinator({
      contextWindowTokens: 8_000,
      providerProfileId: 'fault-profile-v1',
      providerMaxOutputTokens: 1_024,
      providerOverheadTokens: 0,
      perToolOverheadTokens: 0,
      userConstraintPolicy: identifyExplicitAgentUserConstraints,
      fullCompactor: faultCompactor,
    });
    const faultHistory: AgentModelMessage[] = [
      { role: 'user', content: '检查长篇历史并给出结论。' },
      { role: 'assistant', content: [{ type: 'text', text: '旧证据'.repeat(9_000) }] },
      { role: 'user', content: '继续第一轮。' },
      { role: 'assistant', content: [{ type: 'text', text: '第一轮已记录。' }] },
      { role: 'user', content: '继续第二轮。' },
      { role: 'assistant', content: [{ type: 'text', text: '第二轮已记录。' }] },
    ];
    const faultRequest = {
      ...planningRequest(faultHistory, 1, 'fault-turn'),
      requestedOutputTokens: 1_024,
    };
    await expect(faultCoordinator.plan(faultRequest)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    await expect(faultCoordinator.plan({ ...faultRequest, iteration: 2 })).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });

    const retrieval = Object.fromEntries(
      [...retrievalByDimension].map(([dimension, value]) => [
        dimension,
        { ...value, recallAt5: ratio(value.hits, value.total) },
      ]),
    );
    const metrics = {
      fixture: {
        oracleCases: fixture.oracle.length,
        syntheticCorpusGenerated: fixture.syntheticCorpus.generated,
        syntheticCorpusDocuments: fixture.syntheticCorpus.documents,
        syntheticCorpusBytes: fixture.syntheticCorpus.bytes,
      },
      providerContext: {
        profileId: 'milestone-f-200k-v1',
        contextWindowTokens: finalPlan.contextUsage.contextWindowTokens,
        slices: plans.length,
        compactedSlices: compactedPlans.length,
        compactorCalls: complete.mock.calls.length,
        medianTokenReduction: median(tokenReductions),
        maxContextWindowRatio: Math.max(...contextWindowRatios),
        finalEstimatedInputTokens: finalPlan.contextUsage.estimatedInputTokens,
      },
      retrieval,
      compactionFidelity: {
        evidenceHits: evidenceHits.length,
        evidenceTotal: history.oracleEvidenceIds.length,
        evidenceRecall: ratio(evidenceHits.length, history.oracleEvidenceIds.length),
        voiceHits: voiceHits.length,
        voiceTotal: voiceCases.length,
        characterVoiceRecall: ratio(voiceHits.length, voiceCases.length),
        constraintHits: retainedConstraints.length,
        constraintTotal: ledger.entries.length,
        constraintRecall: ratio(retainedConstraints.length, ledger.entries.length),
        retentionWitness: ledger.retentionWitness?.status ?? null,
        sourceCoverage: ratio(
          finalPlan.envelope.plannerCheckpoint.coverage.representedSourceIds.length,
          finalPlan.envelope.plannerCheckpoint.canonicalSources.sourceCount,
        ),
      },
      restart: {
        reusedVerifiedSummaries: restartCompactor.mock.calls.length === 0,
        evidenceRecall: ratio(
          history.oracleEvidenceIds.filter((id) => providerEvidenceIds(restarted.envelope).has(id))
            .length,
          history.oracleEvidenceIds.length,
        ),
      },
      faultInjection: {
        compactorCallsBeforeCircuitOpened: faultCompactor.mock.calls.length,
        retriesAfterCircuitOpened: Math.max(0, faultCompactor.mock.calls.length - 1),
      },
      completionQuality: {
        providerIndependentContextScore: median([
          ratio(evidenceHits.length, history.oracleEvidenceIds.length),
          ratio(voiceHits.length, voiceCases.length),
          ratio(retainedConstraints.length, ledger.entries.length),
          restartCompactor.mock.calls.length === 0 ? 1 : 0,
        ]),
        generatedProseJudgment: 'deferred_to_milestone_h',
      },
    };

    console.info(`MILESTONE_F_METRICS=${JSON.stringify(metrics)}`);

    expect(fixture.syntheticCorpus.documents).toBeGreaterThanOrEqual(16);
    expect(fixture.syntheticCorpus.bytes).toBeGreaterThan(250_000);
    expect(Object.values(retrieval).every((value) => value.recallAt5 === 1)).toBe(true);
    expect(compactedPlans.length).toBeGreaterThanOrEqual(1);
    expect(metrics.providerContext.contextWindowTokens).toBe(200_000);
    expect(metrics.providerContext.medianTokenReduction).toBeGreaterThanOrEqual(0.5);
    expect(metrics.providerContext.maxContextWindowRatio).toBeLessThanOrEqual(0.9);
    expect(metrics.compactionFidelity.evidenceRecall).toBe(1);
    expect(metrics.compactionFidelity.characterVoiceRecall).toBe(1);
    expect(metrics.compactionFidelity.constraintRecall).toBe(1);
    expect(metrics.compactionFidelity.retentionWitness).toBe('exact');
    expect(metrics.restart).toEqual({ reusedVerifiedSummaries: true, evidenceRecall: 1 });
    expect(metrics.faultInjection).toEqual({
      compactorCallsBeforeCircuitOpened: 1,
      retriesAfterCircuitOpened: 0,
    });
    expect(metrics.completionQuality.providerIndependentContextScore).toBe(1);
  }, 30_000);
});
