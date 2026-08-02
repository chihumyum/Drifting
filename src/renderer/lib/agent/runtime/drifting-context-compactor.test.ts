import { describe, expect, it, vi } from 'vitest';
import type {
  AICompletionRequest,
  AICompletionResponse,
} from '../../ai/types';
import {
  hashAgentContextSourceRows,
  type AgentContextSourceRow,
} from './context-planner';
import { createDriftingContextCompactor } from './drifting-context-compactor';
import { parseDriftingLiteraryContextSummary } from './literary-context-summary';
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
      row(
        'read-call-1',
        1,
        0,
        'tool_call',
        '{"type":"tool_call"}',
        { callId: 'call-1', toolName: 'read_node', toolAccess: 'read' },
      ),
      row(
        'read-result-1',
        2,
        0,
        'tool_result',
        '{"ok":true}',
        { callId: 'call-1', toolName: 'read_node', toolAccess: 'read' },
      ),
    ];
    const complete = vi.fn(async (_request: AICompletionRequest) =>
      response(
        'Alice moved to the lighthouse; read_node confirmed the current chapter.',
        [
          {
            sourceId: 'read-result-1',
            kind: 'canon_fact',
            claim: 'The current chapter read succeeded.',
            quote: '"ok":true',
          },
        ],
      ),
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
      synopsis:
        'Alice moved to the lighthouse; read_node confirmed the current chapter.',
      evidence: [
        {
          sourceId: 'read-result-1',
          kind: 'canon_fact',
          quote: '"ok":true',
        },
      ],
    });
    expect(summaries[0].summaryId).toMatch(/^drifting-summary:[0-9a-f]{16}:0$/);
    const request = complete.mock.calls[0][0];
    expect(request.toolChoice).toEqual({ force: 'submit_context_summary' });
    expect(request.thinking).toBe(false);
    expect(request.signal).toBeInstanceOf(AbortSignal);
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

    expect(parseDriftingLiteraryContextSummary(summaries[0]!.content)?.synopsis)
      .toBe('Provider-aligned summary.');
    expect(requests[0]).toMatchObject({
      sessionId: 'session-live',
      turnId: 'turn-live',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });

  it('chunks inside one turn at tool-topology boundaries without splitting a pair', async () => {
    const large = 'x'.repeat(800);
    const rows = [
      row(
        'call-0',
        0,
        0,
        'tool_call',
        large,
        { callId: 'c0', toolName: 'read_node', toolAccess: 'read' },
      ),
      row(
        'result-0',
        1,
        0,
        'tool_result',
        large,
        { callId: 'c0', toolName: 'read_node', toolAccess: 'read' },
      ),
      row('assistant-1', 2, 0, 'assistant_narrative', large),
    ];
    const requests: AICompletionRequest[] = [];
    const compactor = createDriftingContextCompactor({
      maxInputTokensPerRequest: 100,
      createClient: async () => ({
        supportsTools: true,
        complete: async (request) => {
          requests.push(request);
          const payload = JSON.parse(
            String(request.messages[0]?.content ?? '{}'),
          ) as { rows?: Array<{ sourceId: string; kind: string; content: string }> };
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
    expect(parseDriftingLiteraryContextSummary(unsupportedSummaries[0]!.content)?.synopsis)
      .toContain('deterministic fallback');

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
    expect(parseDriftingLiteraryContextSummary(malformedSummaries[0]!.content)?.synopsis)
      .toContain('deterministic fallback');
  });

  it('replaces summaries that omit or forge write evidence with the safe fallback', async () => {
    const rows = [
      row(
        'call-1',
        0,
        0,
        'tool_call',
        '{"query":"harbor"}',
        { callId: 'c1', toolName: 'write_node', toolAccess: 'write' },
      ),
      row(
        'result-1',
        1,
        0,
        'tool_result',
        '{"location":"South Harbor"}',
        { callId: 'c1', toolName: 'write_node', toolAccess: 'write' },
      ),
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
    expect(parseDriftingLiteraryContextSummary(omittedSummaries[0]!.content)?.evidence)
      .toEqual([
        expect.objectContaining({
          sourceId: 'result-1',
          kind: 'write_outcome',
          quote: '{"location":"South Harbor"}',
        }),
      ]);

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
    expect(recovered?.synopsis).toContain('deterministic fallback');
    expect(JSON.stringify(recovered)).not.toContain('North Harbor');
  });

  it('times out one stalled paid chunk and continues with the deterministic fallback', async () => {
    let providerSignal: AbortSignal | undefined;
    const complete = vi.fn(
      async (request: AICompletionRequest): Promise<AICompletionResponse> => {
        providerSignal = request.signal;
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(request.signal?.reason),
            { once: true },
          );
        });
      },
    );
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
    expect(parseDriftingLiteraryContextSummary(summaries[0]!.content)?.synopsis)
      .toContain('deterministic fallback');
  });

  it('does not create a client after cancellation', async () => {
    const createClient = vi.fn();
    const controller = new AbortController();
    controller.abort('cancelled');
    const compactor = createDriftingContextCompactor({ createClient });

    await expect(
      compactor({
        eligibleRuns: [
          [row('assistant-1', 0, 0, 'assistant_narrative', 'history')],
        ],
        currentEstimatedTokens: 100,
        usableInputBudgetTokens: 50,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createClient).not.toHaveBeenCalled();
  });
});
