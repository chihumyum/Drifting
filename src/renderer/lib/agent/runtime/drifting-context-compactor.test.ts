import { describe, expect, it, vi } from 'vitest';
import type { AICompletionRequest, AICompletionResponse } from '../../ai/types';
import { hashAgentContextSourceRows, type AgentContextSourceRow } from './context-planner';
import { createDriftingContextCompactor } from './drifting-context-compactor';
import {
  parseDriftingLiteraryContextSummary,
  serializeDriftingLiteraryContextSummary,
} from './literary-context-summary';
import type { AgentModelDriver, AgentModelRequest } from './types';

function row(
  sourceId: string,
  ordinal: number,
  turnOrdinal: number,
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
    ...(tool
      ? {
          callId: tool.callId,
          toolName: tool.toolName,
          toolAccess: tool.toolAccess,
        }
      : {}),
  };
}

function response(
  summary: string,
  evidence: Array<{
    sourceId: string;
    kind: 'canon_fact' | 'character_voice';
    claim: string;
    quote: string;
  }> = [],
): AICompletionResponse {
  return {
    toolCall: {
      id: 'summary-call',
      name: 'submit_context_summary',
      arguments: {
        summary,
        evidence,
        decisions: [],
        unresolved: [],
        nextActions: [],
      },
    },
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe('Drifting context compactor', () => {
  it('returns source-hash-bound summaries through a forced structured call', async () => {
    const rows = [
      row('assistant-1', 0, 0, 'assistant_narrative', 'Alice moved to the lighthouse.'),
      row('read-call-1', 1, 0, 'tool_call', '{"type":"tool_call"}', {
        callId: 'call-1',
        toolName: 'read_node',
        toolAccess: 'read',
      }),
      row('read-result-1', 2, 0, 'tool_result', '{"ok":true}', {
        callId: 'call-1',
        toolName: 'read_node',
        toolAccess: 'read',
      }),
    ];
    const complete = vi.fn(async (_request: AICompletionRequest) =>
      response('Alice moved to the lighthouse; read_node confirmed the current chapter.', [
        {
          sourceId: 'read-result-1',
          kind: 'canon_fact',
          claim: 'The current chapter read succeeded.',
          quote: '"ok":true',
        },
      ]),
    );
    const compactor = createDriftingContextCompactor({
      createClient: async () => ({ supportsTools: true, complete }),
    });

    const summaries = await compactor({
      eligibleRuns: [rows],
      currentEstimatedTokens: 20_000,
      usableInputBudgetTokens: 10_000,
      signal: new AbortController().signal,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sourceIds: rows.map((candidate) => candidate.sourceId),
      sourceHash: await hashAgentContextSourceRows(rows),
    });
    expect(parseDriftingLiteraryContextSummary(summaries[0]!.content)).toMatchObject({
      synopsis: 'Alice moved to the lighthouse; read_node confirmed the current chapter.',
      evidence: expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'read-result-1',
          kind: 'task_progress',
        }),
      ]),
    });
    expect(summaries[0].summaryId).toMatch(/^drifting-summary:[0-9a-f]{16}:0$/);
    const request = complete.mock.calls[0][0];
    expect(request.toolChoice).toEqual({ force: 'submit_context_summary' });
    expect(request.tools?.[0]?.parametersSchema).toEqual({
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Concise factual continuation summary, at most 3,600 Unicode characters.',
        },
        evidence: {
          type: 'array',
          maxItems: 96,
          items: {
            type: 'object',
            properties: {
              sourceId: { type: 'string' },
              kind: {
                type: 'string',
                enum: [
                  'canon_fact',
                  'character_voice',
                  'author_decision',
                  'write_outcome',
                  'task_progress',
                  'unresolved',
                ],
              },
              claim: { type: 'string' },
              quote: {
                type: 'string',
                description: 'A short byte-exact substring copied from the cited source row.',
              },
            },
            required: ['sourceId', 'kind', 'claim', 'quote'],
            additionalProperties: false,
          },
          description: 'Material read or author evidence worth retaining. Omit write tool results.',
        },
        decisions: {
          type: 'array',
          maxItems: 12,
          items: { type: 'string' },
          description: 'Material decisions that still affect continuation.',
        },
        unresolved: {
          type: 'array',
          maxItems: 12,
          items: { type: 'string' },
          description: 'Unresolved work, blockers, or questions.',
        },
        nextActions: {
          type: 'array',
          maxItems: 12,
          items: { type: 'string' },
          description: 'Concrete immediate actions in execution order.',
        },
      },
      required: ['summary', 'evidence', 'decisions', 'unresolved', 'nextActions'],
      additionalProperties: false,
    });
    expect(request.maxOutputTokens).toBe(1_024);
    expect(request.thinking).toBe(false);
    expect(request.terminalRequirements).toEqual({
      finishReason: true,
      usage: true,
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('rolls up a prior verified summary while binding the result to original canonical rows', async () => {
    const rows = [
      row('old-a', 0, 0, 'assistant_narrative', `ORIGINAL_A_${'a'.repeat(8_000)}`),
      row('old-b', 1, 0, 'assistant_narrative', `ORIGINAL_B_${'b'.repeat(8_000)}`),
    ];
    const complete = vi.fn(async (_request: AICompletionRequest) =>
      response('Earlier progress was rolled up; continue with the unresolved chapter cleanup.'),
    );
    const compactor = createDriftingContextCompactor({
      createClient: async () => ({ supportsTools: true, complete }),
    });

    const summaries = await compactor({
      eligibleRuns: [],
      eligibleProjectionRuns: [
        [
          {
            sourceRows: rows,
            projectionRows: [
              {
                type: 'summary',
                summaryId: 'prior-summary',
                sourceIds: rows.map((candidate) => candidate.sourceId),
                content: 'PRIOR VERIFIED SUMMARY: chapters were scanned; cleanup remains.',
              },
            ],
            estimatedTokens: 4_000,
          },
        ],
      ],
      currentEstimatedTokens: 20_000,
      usableInputBudgetTokens: 10_000,
      signal: new AbortController().signal,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sourceIds: rows.map((candidate) => candidate.sourceId),
      sourceHash: await hashAgentContextSourceRows(rows),
    });
    const request = complete.mock.calls[0]![0];
    const payload = JSON.parse(request.messages[0]!.content) as {
      rows: Array<{ kind: string; content: string; sourceIds: string[] }>;
    };
    expect(payload.rows).toEqual([
      expect.objectContaining({
        kind: 'compaction_summary',
        content: 'PRIOR VERIFIED SUMMARY: chapters were scanned; cleanup remains.',
        sourceIds: rows.map((candidate) => candidate.sourceId),
      }),
    ]);
    expect(request.messages[0]!.content).not.toContain('ORIGINAL_A_');
    expect(request.messages[0]!.content).not.toContain('ORIGINAL_B_');
  });

  it('carries prior verified citations and continuation lists through a hierarchical rollup', async () => {
    const rows = [row('old-evidence', 0, 0, 'assistant_narrative', '奥伦仍记得茶城的雨。')];
    const prior = serializeDriftingLiteraryContextSummary({
      schemaVersion: 1,
      synopsis: '奥伦已离开茶城。',
      evidence: [
        {
          sourceId: 'old-evidence',
          kind: 'canon_fact',
          claim: '{"evidenceId":"tea-rain"}',
          quote: '茶城的雨',
        },
      ],
      decisions: ['保留茶城雨意象。'],
      unresolved: ['女孩身份尚未揭示。'],
      nextActions: ['继续整理福地章节。'],
    });
    const complete = vi.fn(async () => response('继续处理福地章节。'));
    const compactor = createDriftingContextCompactor({
      createClient: async () => ({ supportsTools: true, complete }),
    });

    const summaries = await compactor({
      eligibleRuns: [],
      eligibleProjectionRuns: [
        [
          {
            sourceRows: rows,
            projectionRows: [
              {
                type: 'summary',
                summaryId: 'prior-summary',
                sourceIds: ['old-evidence'],
                content: prior,
              },
            ],
            estimatedTokens: 4_000,
          },
        ],
      ],
      currentEstimatedTokens: 20_000,
      usableInputBudgetTokens: 10_000,
      signal: new AbortController().signal,
    });

    const rolled = parseDriftingLiteraryContextSummary(summaries[0]!.content);
    expect(rolled).toMatchObject({
      evidence: [
        expect.objectContaining({
          sourceId: 'old-evidence',
          claim: '{"evidenceId":"tea-rain"}',
        }),
      ],
      decisions: ['保留茶城雨意象。'],
      unresolved: ['女孩身份尚未揭示。'],
      nextActions: expect.arrayContaining(['继续整理福地章节。']),
    });
  });

  it('bounds retained evidence bytes without losing structured evidence identity', async () => {
    const quote = '精确证据'.repeat(160);
    const rows = [row('old-evidence', 0, 0, 'assistant_narrative', quote)];
    const prior = serializeDriftingLiteraryContextSummary({
      schemaVersion: 1,
      synopsis: '此前已完成证据读取。',
      evidence: [
        {
          sourceId: 'old-evidence',
          kind: 'character_voice',
          claim: JSON.stringify({
            evidenceId: 'voice-001',
            dimension: 'character_voice',
            text: '会导致摘要无限膨胀的长说明'.repeat(160),
          }),
          quote,
        },
      ],
      decisions: ['仍需遵守的决定'.repeat(160)],
      unresolved: [],
      nextActions: [],
    });
    const compactor = createDriftingContextCompactor({
      createClient: async () => ({
        supportsTools: true,
        complete: async () => response('继续执行。'),
      }),
    });

    const summaries = await compactor({
      eligibleRuns: [],
      eligibleProjectionRuns: [
        [
          {
            sourceRows: rows,
            projectionRows: [
              {
                type: 'summary',
                summaryId: 'prior-summary',
                sourceIds: ['old-evidence'],
                content: prior,
              },
            ],
            estimatedTokens: 10_000,
          },
        ],
      ],
      currentEstimatedTokens: 20_000,
      usableInputBudgetTokens: 10_000,
      signal: new AbortController().signal,
    });

    const rolled = parseDriftingLiteraryContextSummary(summaries[0]!.content);
    expect(rolled?.evidence[0]).toMatchObject({
      sourceId: 'old-evidence',
      claim: '{"evidenceId":"voice-001","dimension":"character_voice"}',
    });
    expect([...(rolled?.evidence[0]?.quote ?? '')]).toHaveLength(180);
    expect([...(rolled?.decisions[0] ?? '')].length).toBeLessThanOrEqual(600);
  });

  it('keeps provider decisions and next actions while fitting an oversized synopsis', async () => {
    const complete = vi.fn(
      async () =>
        ({
          ...response('unused'),
          toolCall: {
            id: 'summary-call',
            name: 'submit_context_summary',
            arguments: {
              summary: `objective:${'x'.repeat(5_000)}\nnext:write chapter 02`,
              decisions: ['Use chapter 01 as the direct predecessor.'],
              unresolved: ['The missing chapter 02 still needs to be created.'],
              nextActions: ['Create chapter 02, then write its opening scene.'],
            },
          },
        }) satisfies AICompletionResponse,
    );
    const compactor = createDriftingContextCompactor({
      createClient: async () => ({ supportsTools: true, complete }),
    });

    const summaries = await compactor({
      eligibleRuns: [[row('assistant-1', 0, 0, 'assistant_narrative', 'history')]],
      currentEstimatedTokens: 100,
      usableInputBudgetTokens: 50,
      signal: new AbortController().signal,
    });
    const parsed = parseDriftingLiteraryContextSummary(summaries[0]!.content);

    expect([...(parsed?.synopsis ?? '')].length).toBeLessThanOrEqual(4_000);
    expect(parsed?.synopsis).toContain('objective:');
    expect(parsed?.synopsis).toContain('next:write chapter 02');
    expect(parsed?.decisions).toEqual(['Use chapter 01 as the direct predecessor.']);
    expect(parsed?.unresolved).toEqual(['The missing chapter 02 still needs to be created.']);
    expect(parsed?.nextActions).toEqual(['Create chapter 02, then write its opening scene.']);
  });

  it('reuses the active provider and model through the product driver', async () => {
    const requests: AgentModelRequest[] = [];
    const driver: AgentModelDriver = {
      id: 'compactor-provider-router',
      async *stream(request) {
        requests.push(request);
        const args = response('Provider-aligned summary.').toolCall!.arguments;
        yield { type: 'tool_call_start', callId: 'aligned', name: 'submit_context_summary' };
        yield {
          type: 'tool_args_delta',
          callId: 'aligned',
          delta: JSON.stringify(args),
        };
        yield { type: 'tool_call_end', callId: 'aligned' };
        yield { type: 'finish', reason: 'tool_use' };
      },
    };
    const compactor = createDriftingContextCompactor({ driver });

    const summaries = await compactor({
      eligibleRuns: [[row('assistant-1', 0, 0, 'assistant_narrative', 'history')]],
      currentEstimatedTokens: 100,
      usableInputBudgetTokens: 50,
      sessionId: 'session-live',
      turnId: 'turn-live',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      signal: new AbortController().signal,
    });

    expect(parseDriftingLiteraryContextSummary(summaries[0]!.content)?.synopsis).toBe(
      'Provider-aligned summary.',
    );
    expect(requests[0]).toMatchObject({
      sessionId: 'session-live',
      turnId: 'turn-live',
      lifecycle: 'single_request',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      toolChoice: { force: 'submit_context_summary' },
    });
  });

  it('chunks inside one turn at tool-topology boundaries without splitting a pair', async () => {
    const large = 'x'.repeat(800);
    const rows = [
      row('call-0', 0, 0, 'tool_call', large, {
        callId: 'c0',
        toolName: 'read_node',
        toolAccess: 'read',
      }),
      row('result-0', 1, 0, 'tool_result', large, {
        callId: 'c0',
        toolName: 'read_node',
        toolAccess: 'read',
      }),
      row('assistant-1', 2, 0, 'assistant_narrative', large),
    ];
    const requests: AICompletionRequest[] = [];
    const compactor = createDriftingContextCompactor({
      maxInputTokensPerRequest: 100,
      createClient: async () => ({
        supportsTools: true,
        complete: async (request) => {
          requests.push(request);
          const payload = JSON.parse(String(request.messages[0]?.content ?? '{}')) as {
            rows?: Array<{ sourceId: string; kind: string; content: string }>;
          };
          const toolResult = payload.rows?.find((candidate) => candidate.kind === 'tool_result');
          return response(
            `summary-${requests.length}`,
            toolResult
              ? [
                  {
                    sourceId: toolResult.sourceId,
                    kind: 'canon_fact',
                    claim: 'The read result remains available.',
                    quote: toolResult.content.slice(0, 16),
                  },
                ]
              : [],
          );
        },
      }),
    });

    const summaries = await compactor({
      eligibleRuns: [rows],
      currentEstimatedTokens: 2_000,
      usableInputBudgetTokens: 500,
      signal: new AbortController().signal,
    });

    expect(summaries).toHaveLength(2);
    expect(summaries[0].sourceIds).toEqual(['call-0', 'result-0']);
    expect(summaries[1].sourceIds).toEqual(['assistant-1']);
    expect(requests).toHaveLength(2);
  });

  it('stops after enough chunk gain instead of compacting all history', async () => {
    const large = 'x'.repeat(16_000);
    const rows = Array.from({ length: 3 }, (_, index) =>
      row(`assistant-${index}`, index, 0, 'assistant_narrative', large),
    );
    const complete = vi.fn(async () => response('A bounded old-history summary.'));
    const compactor = createDriftingContextCompactor({
      maxInputTokensPerRequest: 1_000,
      createClient: async () => ({ supportsTools: true, complete }),
    });

    const summaries = await compactor({
      eligibleRuns: [rows],
      currentEstimatedTokens: 10_100,
      usableInputBudgetTokens: 10_000,
      signal: new AbortController().signal,
    });

    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.sourceIds).toEqual(['assistant-0']);
    expect(summaries[1]!.sourceIds).toEqual(['assistant-1']);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('bounds paid summary chunks and rolls the remaining history up deterministically', async () => {
    const large = 'x'.repeat(16_000);
    const rows = Array.from({ length: 4 }, (_, index) =>
      row(`assistant-budget-${index}`, index, 0, 'assistant_narrative', large),
    );
    const complete = vi.fn(async () => response('One paid continuation summary.'));
    const compactor = createDriftingContextCompactor({
      maxInputTokensPerRequest: 1_000,
      maxProviderChunksPerPass: 1,
      targetReductionRatio: 0.9,
      createClient: async () => ({ supportsTools: true, complete }),
    });

    const summaries = await compactor({
      eligibleRuns: [rows],
      currentEstimatedTokens: 16_000,
      usableInputBudgetTokens: 1_000,
      signal: new AbortController().signal,
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(summaries).toHaveLength(4);
    expect(parseDriftingLiteraryContextSummary(summaries[1]!.content)?.synopsis).toContain(
      'bounded provider-summary call budget',
    );
    expect(summaries[1]!.content).not.toContain('provider_failure');
  });

  it('caps a configured large chunk against the current provider source budget', async () => {
    const requests: AICompletionRequest[] = [];
    const compactor = createDriftingContextCompactor({
      maxInputTokensPerRequest: 64_000,
      createClient: async () => ({
        supportsTools: true,
        complete: async (request) => {
          requests.push(request);
          return response(`summary-${requests.length}`);
        },
      }),
    });
    const rows = Array.from({ length: 3 }, (_, index) =>
      row(
        `assistant-window-${index}`,
        index,
        0,
        'assistant_narrative',
        String(index).repeat(8_000),
      ),
    );

    const summaries = await compactor({
      eligibleRuns: [rows],
      currentEstimatedTokens: 9_000,
      usableInputBudgetTokens: 4_000,
      signal: new AbortController().signal,
    });

    // 45% of the 4k usable source budget is 1.8k, so each roughly 2k-token
    // topology unit stays isolated even though the configured ceiling is 64k.
    expect(summaries).toHaveLength(3);
    expect(requests).toHaveLength(3);
  });

  it('falls back deterministically on unsupported or malformed provider output', async () => {
    const rows = [row('assistant-1', 0, 0, 'assistant_narrative', 'history')];
    const unsupported = createDriftingContextCompactor({
      createClient: async () => ({
        supportsTools: false,
        complete: vi.fn(),
      }),
    });
    const unsupportedSummaries = await unsupported({
      eligibleRuns: [rows],
      currentEstimatedTokens: 100,
      usableInputBudgetTokens: 50,
      signal: new AbortController().signal,
    });
    expect(
      parseDriftingLiteraryContextSummary(unsupportedSummaries[0]!.content)?.synopsis,
    ).toContain('deterministic fallback');

    const malformed = createDriftingContextCompactor({
      createClient: async () => ({
        supportsTools: true,
        complete: async () => ({
          text: 'unstructured summary',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      }),
    });
    const malformedSummaries = await malformed({
      eligibleRuns: [rows],
      currentEstimatedTokens: 100,
      usableInputBudgetTokens: 50,
      signal: new AbortController().signal,
    });
    expect(parseDriftingLiteraryContextSummary(malformedSummaries[0]!.content)?.synopsis).toContain(
      'deterministic fallback',
    );
  });

  it('retains successful and stable missing read targets but drops transient failures', async () => {
    const rows = [
      row(
        'call-old',
        0,
        0,
        'tool_call',
        JSON.stringify({
          type: 'tool_call',
          name: 'read_file',
          callId: 'read-old',
          arguments: { path: '/chapters/00' },
          rawArguments: '{"path":"/chapters/00"}',
        }),
        { callId: 'read-old', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'result-old',
        1,
        0,
        'tool_result',
        JSON.stringify({
          callId: 'read-old',
          content: '/chapters/00/prose.md\nold content',
          name: 'read_file',
          ok: true,
        }),
        { callId: 'read-old', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'call-new',
        2,
        0,
        'tool_call',
        JSON.stringify({
          type: 'tool_call',
          name: 'read_file',
          callId: 'read-new',
          arguments: { path: '/chapters/00' },
          rawArguments: '{"path":"/chapters/00"}',
        }),
        { callId: 'read-new', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'result-new',
        3,
        0,
        'tool_result',
        JSON.stringify({
          callId: 'read-new',
          content: '/chapters/00/prose.md\nnew content',
          name: 'read_file',
          ok: true,
        }),
        { callId: 'read-new', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'call-failed',
        4,
        0,
        'tool_call',
        JSON.stringify({
          type: 'tool_call',
          name: 'read_file',
          callId: 'read-failed',
          arguments: { path: '/chapters/missing' },
          rawArguments: '{"path":"/chapters/missing"}',
        }),
        { callId: 'read-failed', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'result-failed',
        5,
        0,
        'tool_result',
        JSON.stringify({
          callId: 'read-failed',
          content: 'not found',
          name: 'read_file',
          ok: false,
        }),
        { callId: 'read-failed', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'call-transient',
        6,
        0,
        'tool_call',
        JSON.stringify({
          type: 'tool_call',
          name: 'read_file',
          callId: 'read-transient',
          arguments: { path: '/chapters/temporarily-unavailable' },
          rawArguments: '{"path":"/chapters/temporarily-unavailable"}',
        }),
        { callId: 'read-transient', toolName: 'read_file', toolAccess: 'read' },
      ),
      row(
        'result-transient',
        7,
        0,
        'tool_result',
        JSON.stringify({
          callId: 'read-transient',
          content: 'database is not open for this renderer session',
          name: 'read_file',
          ok: false,
        }),
        { callId: 'read-transient', toolName: 'read_file', toolAccess: 'read' },
      ),
    ];
    const compactor = createDriftingContextCompactor({
      createClient: async () => ({ supportsTools: false, complete: vi.fn() }),
    });

    const summaries = await compactor({
      eligibleRuns: [rows],
      currentEstimatedTokens: 1_000,
      usableInputBudgetTokens: 500,
      signal: new AbortController().signal,
    });
    const parsed = parseDriftingLiteraryContextSummary(summaries[0]!.content);

    expect(parsed?.evidence).toEqual([
      expect.objectContaining({
        sourceId: 'result-new',
        kind: 'task_progress',
        claim: expect.stringContaining('/chapters/00'),
      }),
      expect.objectContaining({
        sourceId: 'result-failed',
        kind: 'task_progress',
        claim: expect.stringContaining('/chapters/missing'),
      }),
    ]);
    expect(parsed?.nextActions.join('\n')).toContain('Do not repeat broad directory scans');
    expect(JSON.stringify(parsed)).toContain('not found');
    expect(JSON.stringify(parsed)).not.toContain('/chapters/temporarily-unavailable');
  });

  it('leaves committed-write proof to durable receipts and rejects forged provider evidence', async () => {
    const rows = [
      row('call-1', 0, 0, 'tool_call', '{"query":"harbor"}', {
        callId: 'c1',
        toolName: 'write_node',
        toolAccess: 'write',
      }),
      row('result-1', 1, 0, 'tool_result', '{"location":"South Harbor"}', {
        callId: 'c1',
        toolName: 'write_node',
        toolAccess: 'write',
      }),
    ];
    const omitted = createDriftingContextCompactor({
      createClient: async () => ({
        supportsTools: true,
        complete: async () => response('The harbor was inspected.'),
      }),
    });
    const omittedSummaries = await omitted({
      eligibleRuns: [rows],
      currentEstimatedTokens: 100,
      usableInputBudgetTokens: 50,
      signal: new AbortController().signal,
    });
    expect(parseDriftingLiteraryContextSummary(omittedSummaries[0]!.content)?.evidence).toEqual([]);

    const forged = createDriftingContextCompactor({
      createClient: async () => ({
        supportsTools: true,
        complete: async () =>
          response('The harbor was inspected.', [
            {
              sourceId: 'result-1',
              kind: 'canon_fact',
              claim: 'The location is North Harbor.',
              quote: 'North Harbor',
            },
          ]),
      }),
    });
    const forgedSummaries = await forged({
      eligibleRuns: [rows],
      currentEstimatedTokens: 100,
      usableInputBudgetTokens: 50,
      signal: new AbortController().signal,
    });
    const recovered = parseDriftingLiteraryContextSummary(forgedSummaries[0]!.content);
    expect(recovered?.synopsis).toBe('The harbor was inspected.');
    expect(recovered?.evidence).toEqual([]);
    expect(JSON.stringify(recovered)).not.toContain('North Harbor');
  });

  it('times out one stalled paid chunk and continues with the deterministic fallback', async () => {
    let providerSignal: AbortSignal | undefined;
    const complete = vi.fn(async (request: AICompletionRequest): Promise<AICompletionResponse> => {
      providerSignal = request.signal;
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
          once: true,
        });
      });
    });
    const compactor = createDriftingContextCompactor({
      chunkTimeoutMs: 5,
      maxInputTokensPerRequest: 100,
      createClient: async () => ({ supportsTools: true, complete }),
    });

    const summaries = await compactor({
      eligibleRuns: [
        Array.from({ length: 3 }, (_, index) =>
          row(
            `assistant-timeout-${index}`,
            index,
            0,
            'assistant_narrative',
            'old history '.repeat(400),
          ),
        ),
      ],
      currentEstimatedTokens: 4_000,
      usableInputBudgetTokens: 1_000,
      signal: new AbortController().signal,
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(summaries.length).toBeGreaterThan(1);
    expect(providerSignal?.aborted).toBe(true);
    expect(parseDriftingLiteraryContextSummary(summaries[0]!.content)?.synopsis).toContain(
      'deterministic fallback',
    );
  });

  it('does not create a client after cancellation', async () => {
    const createClient = vi.fn();
    const controller = new AbortController();
    controller.abort('cancelled');
    const compactor = createDriftingContextCompactor({ createClient });

    await expect(
      compactor({
        eligibleRuns: [[row('assistant-1', 0, 0, 'assistant_narrative', 'history')]],
        currentEstimatedTokens: 100,
        usableInputBudgetTokens: 50,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createClient).not.toHaveBeenCalled();
  });
});
