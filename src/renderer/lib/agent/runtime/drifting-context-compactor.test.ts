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

  it('chunks only between turns so read call/result topology stays together', async () => {
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
      row('assistant-1', 2, 1, 'assistant_narrative', large),
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

  it('fails closed on unsupported or malformed provider output', async () => {
    const rows = [row('assistant-1', 0, 0, 'assistant_narrative', 'history')];
    const unsupported = createDriftingContextCompactor({
      createClient: async () => ({
        supportsTools: false,
        complete: vi.fn(),
      }),
    });
    await expect(
      unsupported({
        eligibleRuns: [rows],
        currentEstimatedTokens: 100,
        usableInputBudgetTokens: 50,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('cannot produce a verified context summary');

    const malformed = createDriftingContextCompactor({
      createClient: async () => ({
        supportsTools: true,
        complete: async () => ({
          text: 'unstructured summary',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      }),
    });
    await expect(
      malformed({
        eligibleRuns: [rows],
        currentEstimatedTokens: 100,
        usableInputBudgetTokens: 50,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no summary tool call');
  });

  it('rejects summaries that omit or forge exact evidence from a tool result', async () => {
    const rows = [
      row(
        'call-1',
        0,
        0,
        'tool_call',
        '{"query":"harbor"}',
        { callId: 'c1', toolName: 'read_node', toolAccess: 'read' },
      ),
      row(
        'result-1',
        1,
        0,
        'tool_result',
        '{"location":"South Harbor"}',
        { callId: 'c1', toolName: 'read_node', toolAccess: 'read' },
      ),
    ];
    const omitted = createDriftingContextCompactor({
      createClient: async () => ({
        supportsTools: true,
        complete: async () => response('The harbor was inspected.'),
      }),
    });
    await expect(
      omitted({
        eligibleRuns: [rows],
        currentEstimatedTokens: 100,
        usableInputBudgetTokens: 50,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('has no exact evidence citation');

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
    await expect(
      forged({
        eligibleRuns: [rows],
        currentEstimatedTokens: 100,
        usableInputBudgetTokens: 50,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('quote is not byte-exact');
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
