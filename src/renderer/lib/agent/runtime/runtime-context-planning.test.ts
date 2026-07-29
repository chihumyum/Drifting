import { describe, expect, it, vi } from 'vitest';
import {
  agentModelMessagesToContextSources,
  estimateAgentContextFixedInputTokens,
  verifyAgentContextProviderEnvelope,
  type AgentContextSupplementalPinnedRow,
} from './context-message-adapter';
import { createAgentContextSummaryCandidate } from './context-planner';
import {
  DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
  type AgentRuntimeContextPlanningHookInput,
} from './runtime-context-planning';
import { AgentRuntime } from './runtime';
import type {
  AgentModelDriver,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStreamEvent,
  AgentRuntimeRunInput,
  AgentToolDefinition,
  AgentToolRuntime,
} from './types';

const ROUTE = { kind: 'test', projectId: 'project-1' } as const;
const USAGE: AgentModelStreamEvent = {
  type: 'usage',
  usage: {
    inputTokens: 12,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  },
};

function definition(name: string, schemaPadding = ''): AgentToolDefinition {
  return {
    name,
    description: `read ${name} ${schemaPadding}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: schemaPadding },
      },
      additionalProperties: false,
    },
    access: 'read',
    validateInput: (value) => ({ ok: true, value }),
  };
}

function toolRuntime(
  definitions: readonly AgentToolDefinition[],
): AgentToolRuntime {
  return {
    listDefinitions: () => definitions,
    execute: async () => ({ ok: true, data: { value: 'read result' } }),
  };
}

class RecordingDriver implements AgentModelDriver {
  readonly id = 'recording-provider';
  readonly requests: AgentModelRequest[] = [];

  constructor(
    private readonly respond: (
      request: AgentModelRequest,
    ) => readonly AgentModelStreamEvent[],
  ) {}

  async *stream(
    request: AgentModelRequest,
  ): AsyncIterable<AgentModelStreamEvent> {
    this.requests.push(request);
    for (const event of this.respond(request)) yield event;
  }
}

function runInput(
  overrides: Partial<AgentRuntimeRunInput> = {},
): AgentRuntimeRunInput {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    route: ROUTE,
    prompt: 'Inspect the chapter',
    ...overrides,
  };
}

function toolCall(
  callId: string,
  name: string,
): readonly AgentModelStreamEvent[] {
  return [
    { type: 'tool_call_start', callId, name },
    { type: 'tool_args_delta', callId, delta: '{}' },
    { type: 'tool_call_end', callId },
    USAGE,
    { type: 'finish', reason: 'tool_use' },
  ];
}

function endTurn(text = 'final answer'): readonly AgentModelStreamEvent[] {
  return [
    { type: 'text_delta', text },
    USAGE,
    { type: 'finish', reason: 'end_turn' },
  ];
}

describe('AgentRuntime context planning integration', () => {
  it('plans every provider iteration with exact selected schemas and creates a complete final checkpoint', async () => {
    const definitions = Array.from({ length: 10 }, (_, index) =>
      definition(`tool_${index}`, 'x'.repeat(index * 40)),
    );
    const hookCalls: AgentRuntimeContextPlanningHookInput[] = [];
    const supplementalRows: AgentContextSupplementalPinnedRow[] = [
      {
        sourceId: 'freshness/node-1',
        turnOrdinal: null,
        kind: 'freshness',
        content: '{"nodeId":"node-1","revision":"r1"}',
      },
    ];
    const driver = new RecordingDriver((request) =>
      request.iteration === 1
        ? toolCall('call-1', 'tool_0')
        : endTurn(),
    );
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: {
        select: ({ iteration }) => [
          iteration === 1 ? 'tool_0' : 'tool_9',
        ],
      },
      contextPlanning: {
        providerOverheadTokens: 101,
        perToolOverheadTokens: 7,
        supplementalRows: (input) => {
          hookCalls.push(input);
          return supplementalRows;
        },
      },
    });

    const result = await runtime.runTurn(
      runInput({ toolSearch: 'auto' }),
    );

    expect(result.state.status).toBe('completed');
    expect(driver.requests).toHaveLength(2);
    expect(
      driver.requests.map((request) =>
        request.tools.map((tool) => tool.name),
      ),
    ).toEqual([['tool_0'], ['tool_9']]);
    expect(
      driver.requests.every(
        (request) =>
          request.tools.length <= 8 &&
          request.context.systemPrompt ===
            DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
      ),
    ).toBe(true);
    expect(hookCalls.map((call) => call.purpose)).toEqual([
      'provider_call',
      'provider_call',
      'completed_turn',
    ]);
    expect(
      hookCalls.map((call) => call.tools.map((tool) => tool.name)),
    ).toEqual([['tool_0'], ['tool_9'], ['tool_9']]);

    const expectedFixedTokens = estimateAgentContextFixedInputTokens({
      tools: driver.requests[1]!.tools,
      providerOverheadTokens: 101,
      perToolOverheadTokens: 7,
    });
    expect(
      result.lastProviderCallContextEnvelope?.plannerCheckpoint.budget
        .fixedInputTokens,
    ).toBe(expectedFixedTokens);
    expect(
      result.completedContextCheckpoint?.providerEnvelope.plannerCheckpoint
        .budget.fixedInputTokens,
    ).toBe(expectedFixedTokens);
    expect(
      JSON.stringify(
        result.lastProviderCallContextEnvelope?.providerContext,
      ),
    ).not.toContain('final answer');
    expect(
      JSON.stringify(
        result.completedContextCheckpoint?.canonicalSourceRows,
      ),
    ).toContain('final answer');

    const rebuilt = agentModelMessagesToContextSources({
      systemPrompt: DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
      messages: result.messages,
      resolveToolAccess: (name) =>
        definitions.find((tool) => tool.name === name)?.access ?? null,
      supplementalRows,
    });
    expect(
      result.completedContextCheckpoint?.canonicalSourceRows,
    ).toEqual(rebuilt.sourceRows);
    await expect(
      verifyAgentContextProviderEnvelope({
        envelope: result.completedContextCheckpoint!.providerEnvelope,
        canonicalSourceRows:
          result.completedContextCheckpoint!.canonicalSourceRows,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      name: 'unknown historical tool',
      history: [
        { role: 'user', content: 'old request' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'unknown-call',
              name: 'removed_tool',
              arguments: {},
              rawArguments: '{}',
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              callId: 'unknown-call',
              name: 'removed_tool',
              ok: true,
              content: 'old result',
            },
          ],
        },
      ] satisfies AgentModelMessage[],
    },
    {
      name: 'dangling historical tool call',
      history: [
        { role: 'user', content: 'old request' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'dangling-call',
              name: 'read_node',
              arguments: {},
              rawArguments: '{}',
            },
          ],
        },
      ] satisfies AgentModelMessage[],
    },
  ])('fails closed before provider invocation for $name', async ({ history }) => {
    const driver = new RecordingDriver(() => endTurn());
    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime([definition('read_node')]),
    }).runTurn(runInput({ history }));

    expect(result.state.status).toBe('failed');
    expect(result.state.terminal?.failureCode).toBe(
      'PROTOCOL_VIOLATION',
    );
    expect(driver.requests).toHaveLength(0);
    expect(result.lastProviderCallContextEnvelope).toBeUndefined();
    expect(result.completedContextCheckpoint).toBeUndefined();
  });

  it('rejects pinned overflow before invoking the provider', async () => {
    const driver = new RecordingDriver(() => endTurn());
    const result = await new AgentRuntime({
      driver,
      contextPlanning: {
        contextWindowTokens: 5_000,
        providerOverheadTokens: 0,
        perToolOverheadTokens: 0,
      },
    }).runTurn(
      runInput({
        prompt: `must preserve ${'不可压缩'.repeat(600)}`,
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );

    expect(result.state.status).toBe('budget_exceeded');
    expect(result.state.terminal?.failureCode).toBe('BUDGET_EXCEEDED');
    expect(driver.requests).toHaveLength(0);
    expect(result.lastProviderCallContextEnvelope).toBeUndefined();
    expect(result.completedContextCheckpoint).toBeUndefined();
  });

  it('does not expose canonical history bypass fields to a provider driver', async () => {
    const history: AgentModelMessage[] = [
      { role: 'user', content: 'old turn' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'old context '.repeat(2_000) }],
      },
      { role: 'user', content: 'middle turn' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'middle answer' }],
      },
      { role: 'user', content: 'recent turn' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'recent answer' }],
      },
    ];
    const canonicalMessages = [
      ...history,
      { role: 'user' as const, content: 'Inspect the chapter' },
    ];
    const bridge = agentModelMessagesToContextSources({
      systemPrompt: DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
      messages: canonicalMessages,
      resolveToolAccess: () => null,
    });
    const oldRows = bridge.sourceRows.filter(
      (source) =>
        source.turnOrdinal === 0 &&
        source.kind === 'assistant_narrative',
    );
    const summary = await createAgentContextSummaryCandidate({
      summaryId: 'old-turn-summary',
      sourceRows: oldRows,
      content: 'Verified old-turn summary.',
    });
    const driver = new RecordingDriver(() => endTurn());
    const result = await new AgentRuntime({
      driver,
      contextPlanning: {
        contextWindowTokens: 8_000,
        providerOverheadTokens: 0,
        perToolOverheadTokens: 0,
        deterministicSummaries: [summary],
        supplementalRows: [
          {
            sourceId: 'freshness/node-seam',
            turnOrdinal: null,
            kind: 'freshness',
            content: '{"revision":"seam-r1"}',
          },
        ],
      },
    }).runTurn(
      runInput({
        history,
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );

    expect(result.state.status).toBe('completed');
    expect(driver.requests).toHaveLength(1);
    const actualRequest = driver.requests[0]!;
    const hasOwn = (key: string) =>
      Object.prototype.hasOwnProperty.call(actualRequest, key);
    expect(hasOwn('messages')).toBe(false);
    expect(hasOwn('systemPrompt')).toBe(false);
    expect(hasOwn('plannedContext')).toBe(false);
    expect(
      actualRequest.context.messages.map((message) => message.type),
    ).toContain('context_summary');
    expect(
      actualRequest.context.messages.map((message) => message.type),
    ).toContain('context_note');
  });

  it('counts 3000 summary source ids and fails before invoking the provider', async () => {
    const oldAssistantBlocks = Array.from(
      { length: 3_000 },
      (_, index) => ({
        type: 'text' as const,
        text: `historical-${index}:${'payload '.repeat(24)}`,
      }),
    );
    const history: AgentModelMessage[] = [
      { role: 'user', content: 'turn zero' },
      { role: 'assistant', content: oldAssistantBlocks },
      { role: 'user', content: 'turn one' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'short one' }],
      },
      { role: 'user', content: 'turn two' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'short two' }],
      },
    ];
    const canonicalMessages = [
      ...history,
      { role: 'user' as const, content: 'Inspect the chapter' },
    ];
    const bridge = agentModelMessagesToContextSources({
      systemPrompt: DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
      messages: canonicalMessages,
      resolveToolAccess: () => null,
    });
    const oldRows = bridge.sourceRows.filter(
      (source) =>
        source.turnOrdinal === 0 &&
        source.kind === 'assistant_narrative',
    );
    expect(oldRows).toHaveLength(3_000);
    const summary = await createAgentContextSummaryCandidate({
      summaryId: 'summary-with-3000-sources',
      sourceRows: oldRows,
      content: 'Compact old history.',
    });
    const driver = new RecordingDriver(() => endTurn());
    const result = await new AgentRuntime({
      driver,
      contextPlanning: {
        contextWindowTokens: 20_000,
        providerOverheadTokens: 0,
        perToolOverheadTokens: 0,
        deterministicSummaries: [summary],
      },
    }).runTurn(
      runInput({
        history,
        limits: { maxOutputTokensPerIteration: 1_000 },
      }),
    );

    expect(result.state.status).toBe('budget_exceeded');
    expect(result.state.terminal?.failureCode).toBe('BUDGET_EXCEEDED');
    expect(driver.requests).toHaveLength(0);
    expect(result.lastProviderCallContextEnvelope).toBeUndefined();
  });

  it('fails closed when the completed assistant no longer fits a verified checkpoint', async () => {
    const driver = new RecordingDriver(() =>
      endTurn('x'.repeat(3_000)),
    );
    const result = await new AgentRuntime({
      driver,
      contextPlanning: {
        contextWindowTokens: 5_000,
        providerOverheadTokens: 0,
        perToolOverheadTokens: 0,
      },
    }).runTurn(
      runInput({
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );

    expect(driver.requests).toHaveLength(1);
    expect(result.lastProviderCallContextEnvelope).toBeDefined();
    expect(result.state.status).toBe('budget_exceeded');
    expect(result.state.terminal?.failureCode).toBe('BUDGET_EXCEEDED');
    expect(result.completedContextCheckpoint).toBeUndefined();
  });

  it('opens a compaction circuit only for the failing session/provider epoch', async () => {
    const compact = vi.fn(async () => {
      throw new Error('compactor unavailable');
    });
    const driver = new RecordingDriver(() => endTurn());
    const runtime = new AgentRuntime({
      driver,
      contextPlanning: {
        contextWindowTokens: 8_000,
        providerOverheadTokens: 0,
        perToolOverheadTokens: 0,
        fullCompactor: compact,
      },
    });
    const history: AgentModelMessage[] = [
      { role: 'user', content: 'turn zero' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(18_000) }],
      },
      { role: 'user', content: 'turn one' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'short one' }],
      },
      { role: 'user', content: 'turn two' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'short two' }],
      },
    ];

    const first = await runtime.runTurn(
      runInput({
        turnId: 'turn-a',
        history,
        model: 'epoch-a',
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );
    const sameEpoch = await runtime.runTurn(
      runInput({
        turnId: 'turn-b',
        history,
        model: 'epoch-a',
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );
    const otherSession = await runtime.runTurn(
      runInput({
        sessionId: 'session-2',
        turnId: 'turn-c',
        history,
        model: 'epoch-a',
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );
    const otherProviderEpoch = await runtime.runTurn(
      runInput({
        turnId: 'turn-d',
        history,
        model: 'epoch-b',
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );

    expect([
      first.state.status,
      sameEpoch.state.status,
      otherSession.state.status,
      otherProviderEpoch.state.status,
    ]).toEqual([
      'budget_exceeded',
      'budget_exceeded',
      'budget_exceeded',
      'budget_exceeded',
    ]);
    expect(compact).toHaveBeenCalledTimes(3);
    expect(driver.requests).toHaveLength(0);
  });
});
