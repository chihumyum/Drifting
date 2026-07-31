import { describe, expect, it, vi } from 'vitest';
import {
  agentModelMessagesToContextSources,
  estimateAgentContextFixedInputTokens,
  verifyAgentContextProviderEnvelope,
  type AgentContextSupplementalPinnedRow,
} from './context-message-adapter';
import { createAgentContextSummaryCandidate, type AgentContextSourceRow } from './context-planner';
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

function toolRuntime(definitions: readonly AgentToolDefinition[]): AgentToolRuntime {
  return {
    listDefinitions: () => definitions,
    execute: async () => ({ ok: true, data: { value: 'read result' } }),
  };
}

class RecordingDriver implements AgentModelDriver {
  readonly id = 'recording-provider';
  readonly requests: AgentModelRequest[] = [];

  constructor(
    private readonly respond: (request: AgentModelRequest) => readonly AgentModelStreamEvent[],
  ) {}

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    this.requests.push(request);
    for (const event of this.respond(request)) yield event;
  }
}

function runInput(overrides: Partial<AgentRuntimeRunInput> = {}): AgentRuntimeRunInput {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    route: ROUTE,
    prompt: 'Inspect the chapter',
    ...overrides,
  };
}

function toolCall(callId: string, name: string): readonly AgentModelStreamEvent[] {
  return [
    { type: 'tool_call_start', callId, name },
    { type: 'tool_args_delta', callId, delta: '{}' },
    { type: 'tool_call_end', callId },
    USAGE,
    { type: 'finish', reason: 'tool_use' },
  ];
}

function endTurn(text = 'final answer'): readonly AgentModelStreamEvent[] {
  return [{ type: 'text_delta', text }, USAGE, { type: 'finish', reason: 'end_turn' }];
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
      request.iteration === 1 ? toolCall('call-1', 'tool_0') : endTurn(),
    );
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: {
        select: ({ iteration }) => [iteration === 1 ? 'tool_0' : 'tool_9'],
      },
      contextPlanning: {
        contextWindowTokens: 200_000,
        providerOverheadTokens: 101,
        perToolOverheadTokens: 7,
        supplementalRows: (input) => {
          hookCalls.push(input);
          return supplementalRows;
        },
      },
    });

    const result = await runtime.runTurn(runInput({ toolSearch: 'auto' }));

    expect(result.state.status).toBe('completed');
    expect(driver.requests).toHaveLength(2);
    expect(driver.requests.map((request) => request.tools.map((tool) => tool.name))).toEqual([
      ['tool_0'],
      ['tool_9'],
    ]);
    expect(
      driver.requests.every(
        (request) =>
          request.tools.length <= 8 &&
          request.context.systemPrompt === DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
      ),
    ).toBe(true);
    expect(hookCalls.map((call) => call.purpose)).toEqual([
      'provider_call',
      'provider_call',
      'completed_turn',
    ]);
    expect(hookCalls.map((call) => call.tools.map((tool) => tool.name))).toEqual([
      ['tool_0'],
      ['tool_9'],
      ['tool_9'],
    ]);

    const contextEntries = result.entries.filter(
      (entry) => entry.event.type === 'context_planned',
    );
    expect(contextEntries).toHaveLength(driver.requests.length);
    expect(
      contextEntries.map((entry) =>
        entry.event.type === 'context_planned' ? entry.event.iteration : null,
      ),
    ).toEqual([1, 2]);
    for (const contextEntry of contextEntries) {
      if (contextEntry.event.type !== 'context_planned') throw new Error('expected context event');
      const contextEvent = contextEntry.event;
      const iterationStartIndex = result.entries.findIndex(
        (entry) =>
          entry.event.type === 'model_iteration_started' &&
          entry.event.iteration === contextEvent.iteration,
      );
      const contextIndex = result.entries.indexOf(contextEntry);
      const firstModelOutputIndex = result.entries.findIndex(
        (entry) =>
          (entry.event.type === 'text_delta' ||
            entry.event.type === 'thinking_delta' ||
            entry.event.type === 'tool_call_started') &&
          entry.event.iteration === contextEvent.iteration,
      );
      expect(iterationStartIndex).toBeGreaterThanOrEqual(0);
      expect(contextIndex).toBeGreaterThan(iterationStartIndex);
      expect(firstModelOutputIndex).toBeGreaterThan(contextIndex);
      expect(contextEvent.snapshot).toMatchObject({
        iteration: contextEvent.iteration,
        contextWindowTokens: 200_000,
      });
      expect(
        contextEvent.snapshot.categories.reduce(
          (total, category) => total + category.tokens,
          0,
        ),
      ).toBe(contextEvent.snapshot.estimatedInputTokens);
      expect(
        contextEvent.snapshot.estimatedInputTokens +
          contextEvent.snapshot.reservedOutputTokens +
          contextEvent.snapshot.safetyMarginTokens +
          contextEvent.snapshot.freeTokens,
      ).toBe(contextEvent.snapshot.contextWindowTokens);
    }

    const expectedFixedTokens = estimateAgentContextFixedInputTokens({
      tools: driver.requests[1]!.tools,
      providerOverheadTokens: 101,
      perToolOverheadTokens: 7,
    });
    expect(result.lastProviderCallContextEnvelope?.plannerCheckpoint.budget.fixedInputTokens).toBe(
      expectedFixedTokens,
    );
    expect(
      result.completedContextCheckpoint?.providerEnvelope.plannerCheckpoint.budget.fixedInputTokens,
    ).toBe(expectedFixedTokens);
    expect(JSON.stringify(result.lastProviderCallContextEnvelope?.providerContext)).not.toContain(
      'final answer',
    );
    expect(JSON.stringify(result.completedContextCheckpoint?.canonicalSourceRows)).toContain(
      'final answer',
    );

    const rebuilt = agentModelMessagesToContextSources({
      systemPrompt: DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
      messages: result.messages,
      resolveToolAccess: (name) => definitions.find((tool) => tool.name === name)?.access ?? null,
      supplementalRows,
    });
    expect(result.completedContextCheckpoint?.canonicalSourceRows).toEqual(rebuilt.sourceRows);
    await expect(
      verifyAgentContextProviderEnvelope({
        envelope: result.completedContextCheckpoint!.providerEnvelope,
        canonicalSourceRows: result.completedContextCheckpoint!.canonicalSourceRows,
      }),
    ).resolves.toBeUndefined();
  });

  it('creates a verified complete V2 checkpoint at a resumable model-iteration budget boundary', async () => {
    const read = definition('read_node');
    const hookPurposes: string[] = [];
    const driver = new RecordingDriver(() => toolCall('budget-read', 'read_node'));
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime([read]),
      contextPlanning: {
        supplementalRows: (input) => {
          hookPurposes.push(input.purpose);
          return [];
        },
      },
    });

    const result = await runtime.runTurn(
      runInput({
        limits: {
          maxModelIterations: 1,
          maxOutputTokensPerIteration: 512,
        },
      }),
    );

    expect(result.state.status).toBe('budget_exceeded');
    expect(result.state.terminal?.failureCode).toBe('MAX_MODEL_ITERATIONS');
    expect(driver.requests).toHaveLength(1);
    expect(hookPurposes).toEqual(['provider_call', 'completed_turn']);
    expect(result.completedContextCheckpoint).toBeDefined();
    expect(JSON.stringify(result.completedContextCheckpoint?.canonicalSourceRows)).toContain(
      'budget-read',
    );
    const rebuilt = agentModelMessagesToContextSources({
      systemPrompt: DEFAULT_AGENT_RUNTIME_SYSTEM_POLICY,
      messages: result.messages,
      resolveToolAccess: (name) => (name === 'read_node' ? 'read' : null),
    });
    expect(result.completedContextCheckpoint?.canonicalSourceRows).toEqual(rebuilt.sourceRows);
    await expect(
      verifyAgentContextProviderEnvelope({
        envelope: result.completedContextCheckpoint!.providerEnvelope,
        canonicalSourceRows: result.completedContextCheckpoint!.canonicalSourceRows,
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
    expect(result.state.terminal?.failureCode).toBe('PROTOCOL_VIOLATION');
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
      (source) => source.turnOrdinal === 0 && source.kind === 'assistant_narrative',
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
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(actualRequest, key);
    expect(hasOwn('messages')).toBe(false);
    expect(hasOwn('systemPrompt')).toBe(false);
    expect(hasOwn('plannedContext')).toBe(false);
    expect(actualRequest.context.messages.map((message) => message.type)).toContain(
      'context_summary',
    );
    expect(actualRequest.context.messages.map((message) => message.type)).toContain('context_note');
  });

  it('counts 3000 summary source ids and fails before invoking the provider', async () => {
    const oldAssistantBlocks = Array.from({ length: 3_000 }, (_, index) => ({
      type: 'text' as const,
      text: `historical-${index}:${'payload '.repeat(24)}`,
    }));
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
      (source) => source.turnOrdinal === 0 && source.kind === 'assistant_narrative',
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
    const driver = new RecordingDriver(() => endTurn('x'.repeat(3_000)));
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

  it('summarizes old ordinary dialogue only with an explicit verified constraint policy', async () => {
    const ordinaryUser = `brainstorm ${'possibility '.repeat(1_500)}`;
    const explicitVeto = '不要改变主角的第一人称视角。';
    const history: AgentModelMessage[] = [
      { role: 'user', content: 'Draft this chapter carefully.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood.' }],
      },
      { role: 'user', content: ordinaryUser },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'old exploration '.repeat(900) }],
      },
      { role: 'user', content: explicitVeto },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will preserve it.' }],
      },
      { role: 'user', content: 'Continue.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Continuing.' }],
      },
    ];
    const compactedRows: AgentContextSourceRow[][] = [];
    const driver = new RecordingDriver(() => endTurn());
    const result = await new AgentRuntime({
      driver,
      contextPlanning: {
        contextWindowTokens: 8_000,
        providerOverheadTokens: 0,
        perToolOverheadTokens: 0,
        userConstraintPolicy: ({ candidates }) =>
          candidates
            .filter((candidate, index) => index === 0 || candidate.content === explicitVeto)
            .map((candidate, index) => ({
              constraintId: `author-verified:${candidate.sourceId}`,
              sourceId: candidate.sourceId,
              kind: index === 0 ? ('session_goal' as const) : ('author_veto' as const),
            })),
        fullCompactor: async ({ eligibleRuns }) => {
          const candidates = [];
          for (const run of eligibleRuns) {
            if (run.reduce((total, source) => total + source.content.length, 0) < 1_000) {
              continue;
            }
            compactedRows.push([...run]);
            candidates.push(
              await createAgentContextSummaryCandidate({
                summaryId: `summary-${candidates.length}`,
                sourceRows: run,
                content: 'Verified historical exploration summary.',
              }),
            );
          }
          return candidates;
        },
      },
    }).runTurn(
      runInput({
        history,
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );

    expect(result.state.status, JSON.stringify(result.state.terminal)).toBe('completed');
    expect(driver.requests).toHaveLength(1);
    expect(
      compactedRows
        .flat()
        .some((source) => source.kind === 'user' && source.content === ordinaryUser),
    ).toBe(true);
    expect(compactedRows.flat().some((source) => source.content === explicitVeto)).toBe(false);
    const checkpoint = result.lastProviderCallContextEnvelope!.plannerCheckpoint;
    const vetoEntry = checkpoint.constraintLedger.entries.find(
      (entry) => entry.kind === 'author_veto',
    );
    expect(vetoEntry).toBeDefined();
    expect(
      checkpoint.projection.segments.find(
        (segment) => segment.type === 'source' && segment.row.sourceId === vetoEntry?.sourceId,
      ),
    ).toMatchObject({
      type: 'source',
      classification: 'pinned',
      pinReason: 'semantic',
      row: { content: explicitVeto },
    });
    const tampered = structuredClone(result.lastProviderCallContextEnvelope!);
    tampered.plannerCheckpoint.constraintLedger.entries[0]!.sourceHash = `sha256:${'0'.repeat(64)}`;
    await expect(
      verifyAgentContextProviderEnvelope({
        envelope: tampered,
      }),
    ).rejects.toThrow('envelope hash drifted');
  });

  it('reuses a verified full-compaction summary across later plans in the same provider epoch', async () => {
    const history: AgentModelMessage[] = [
      { role: 'user', content: 'Keep the opening goal.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `old exploration ${'detail '.repeat(4_000)}`,
          },
        ],
      },
      { role: 'user', content: 'Recent instruction.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Recent answer.' }],
      },
      { role: 'user', content: 'Newest instruction.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Newest answer.' }],
      },
    ];
    const compact = vi.fn(
      async ({ eligibleRuns }: { eligibleRuns: readonly (readonly AgentContextSourceRow[])[] }) =>
        Promise.all(
          eligibleRuns.map((sourceRows, index) =>
            createAgentContextSummaryCandidate({
              summaryId: `reusable-summary-${index}`,
              sourceRows,
              content: 'Durable factual summary of the old exploration.',
            }),
          ),
        ),
    );
    const runtime = new AgentRuntime({
      driver: new RecordingDriver(() => endTurn()),
      contextPlanning: {
        contextWindowTokens: 8_000,
        providerOverheadTokens: 0,
        perToolOverheadTokens: 0,
        userConstraintPolicy: ({ candidates }) =>
          candidates.slice(0, 1).map((candidate) => ({
            constraintId: `goal:${candidate.sourceId}`,
            sourceId: candidate.sourceId,
            kind: 'session_goal' as const,
          })),
        fullCompactor: compact,
      },
    });

    const first = await runtime.runTurn(
      runInput({
        turnId: 'turn-summary-1',
        history,
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );
    const second = await runtime.runTurn(
      runInput({
        turnId: 'turn-summary-2',
        history,
        limits: { maxOutputTokensPerIteration: 512 },
      }),
    );

    expect(first.state.status).toBe('completed');
    expect(second.state.status).toBe('completed');
    expect(compact).toHaveBeenCalledTimes(1);
    expect(
      second.lastProviderCallContextEnvelope?.plannerCheckpoint.projection.segments.some(
        (segment) => segment.type === 'summary' && segment.summaryId === 'reusable-summary-0',
      ),
    ).toBe(true);
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
    ]).toEqual(['budget_exceeded', 'budget_exceeded', 'budget_exceeded', 'budget_exceeded']);
    expect(compact).toHaveBeenCalledTimes(3);
    expect(driver.requests).toHaveLength(0);
  });
});
