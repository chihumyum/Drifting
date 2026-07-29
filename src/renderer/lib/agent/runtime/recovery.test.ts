import { describe, expect, it } from 'vitest';
import type {
  AgentRuntimeRecoverySnapshot,
  PersistedAgentRuntimeEvent,
} from '../../../domain/agent-runtime-persistence';
import {
  AgentRuntimeRecoveryCorruptionError,
  applyAgentRuntimeRecoveryPlan,
  createAgentRuntimeCheckpointContextV2,
  hashAgentRuntimeCheckpointContext,
  hashAgentRuntimeCheckpointPayload,
  recoverAgentRuntimeSnapshot,
  type AgentRuntimeCheckpointContextV2,
} from './recovery';
import { planAgentModelContext } from './context-message-adapter';
import type {
  AgentModelMessage,
  AgentRuntimeEvent,
  AgentRuntimeRoute,
  AgentRuntimeUsage,
} from './types';

const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';
const PROJECT_ID = 'project-1';
const CONVERSATION_ID = 'conversation-1';
const NOW = '2026-07-30T08:00:00.000Z';
const ROUTE: AgentRuntimeRoute = {
  kind: 'chat',
  projectId: PROJECT_ID,
  conversationId: CONVERSATION_ID,
};

const USAGE_1: AgentRuntimeUsage = {
  inputTokens: 20,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  costUsd: 0.01,
};
const USAGE_2: AgentRuntimeUsage = {
  inputTokens: 10,
  outputTokens: 4,
  cacheReadTokens: 1,
  cacheWriteTokens: 0,
  costUsd: 0.02,
};
const TOTAL_USAGE: AgentRuntimeUsage = {
  inputTokens: 30,
  outputTokens: 9,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  costUsd: 0.03,
};

function event(
  seq: number,
  runtimeEvent: AgentRuntimeEvent,
  overrides: Partial<PersistedAgentRuntimeEvent> = {},
): PersistedAgentRuntimeEvent {
  const turnId = overrides.turnId ?? TURN_ID;
  return {
    eventId: overrides.eventId ?? `${turnId}:${String(seq).padStart(8, '0')}`,
    sessionId: overrides.sessionId ?? SESSION_ID,
    turnId,
    seq,
    schemaVersion: 1,
    eventType: overrides.eventType ?? runtimeEvent.type,
    payload: overrides.payload ?? { route: ROUTE, event: runtimeEvent },
    wallTimeMs: overrides.wallTimeMs ?? 1_800_000_000_000 + seq,
    createdAt: overrides.createdAt ?? NOW,
  };
}

function completeEvents(): PersistedAgentRuntimeEvent[] {
  const rawArguments = '{"query":"Alice"}';
  return [
    event(1, { type: 'turn_started', prompt: 'Find Alice.' }),
    event(2, {
      type: 'model_iteration_started',
      iteration: 1,
      driverId: 'deepseek',
    }),
    event(3, { type: 'text_delta', iteration: 1, text: 'Searching. ' }),
    event(4, {
      type: 'tool_call_started',
      iteration: 1,
      callId: 'call-1',
      name: 'search_project',
    }),
    event(5, {
      type: 'tool_args_delta',
      iteration: 1,
      callId: 'call-1',
      delta: rawArguments,
    }),
    event(6, {
      type: 'tool_call_ready',
      iteration: 1,
      callId: 'call-1',
      name: 'search_project',
      arguments: { query: 'Alice' },
      rawArguments,
    }),
    event(7, { type: 'model_usage', iteration: 1, usage: USAGE_1 }),
    event(8, {
      type: 'model_iteration_completed',
      iteration: 1,
      stopReason: 'tool_use',
    }),
    event(9, {
      type: 'tool_execution_started',
      callId: 'call-1',
      name: 'search_project',
      access: 'read',
    }),
    event(10, {
      type: 'tool_result',
      callId: 'call-1',
      name: 'search_project',
      ok: true,
      content: '{"hits":1}',
      source: 'executor',
    }),
    event(11, {
      type: 'model_iteration_started',
      iteration: 2,
      driverId: 'deepseek',
    }),
    event(12, { type: 'text_delta', iteration: 2, text: 'Alice appears once.' }),
    event(13, { type: 'model_usage', iteration: 2, usage: USAGE_2 }),
    event(14, {
      type: 'model_iteration_completed',
      iteration: 2,
      stopReason: 'end_turn',
    }),
    event(15, {
      type: 'turn_finished',
      outcome: 'completed',
      usage: TOTAL_USAGE,
      modelIterations: 2,
      durationMs: 250,
    }),
  ];
}

function completeMessages(): AgentRuntimeRecoverySnapshot['messages'] {
  return [
    {
      id: 'message-user',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      ordinal: 0,
      role: 'user',
      status: 'complete',
      content: 'Find Alice.',
      createdAt: NOW,
      completedAt: NOW,
    },
    {
      id: 'message-assistant-tool',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      ordinal: 1,
      role: 'assistant',
      status: 'complete',
      content: [
        { type: 'text', text: 'Searching. ' },
        {
          type: 'tool_call',
          callId: 'call-1',
          name: 'search_project',
          arguments: { query: 'Alice' },
          rawArguments: '{"query":"Alice"}',
        },
      ],
      createdAt: NOW,
      completedAt: NOW,
    },
    {
      id: 'message-tool',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      ordinal: 2,
      role: 'tool',
      status: 'complete',
      content: [
        {
          callId: 'call-1',
          name: 'search_project',
          ok: true,
          content: '{"hits":1}',
        },
      ],
      createdAt: NOW,
      completedAt: NOW,
    },
    {
      id: 'message-assistant-final',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      ordinal: 3,
      role: 'assistant',
      status: 'complete',
      content: [{ type: 'text', text: 'Alice appears once.' }],
      createdAt: NOW,
      completedAt: NOW,
    },
  ];
}

function completeSnapshot(): AgentRuntimeRecoverySnapshot {
  return {
    session: {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      routeKind: 'chat',
      conversationId: CONVERSATION_ID,
      goalRunId: null,
      chapterId: null,
      provider: 'deepseek',
      model: 'deepseek-chat',
      providerEpoch: 0,
      status: 'idle',
      createdAt: NOW,
      updatedAt: NOW,
      endedAt: null,
    },
    turns: [
      {
        id: TURN_ID,
        sessionId: SESSION_ID,
        ordinal: 0,
        status: 'completed',
        promptMessageId: 'message-user',
        acceptedAt: NOW,
        startedAt: NOW,
        endedAt: NOW,
        errorCode: null,
        errorMessage: null,
        updatedAt: NOW,
      },
    ],
    messages: completeMessages(),
    events: completeEvents(),
    toolCalls: [
      {
        id: 'tool-row-1',
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        callId: 'call-1',
        name: 'search_project',
        access: 'read',
        status: 'completed',
        idempotencyKey: `${SESSION_ID}:${TURN_ID}:call-1`,
        arguments: { query: 'Alice' },
        result: { ok: true, content: '{"hits":1}' },
        errorCode: null,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
      },
    ],
    checkpoints: [],
  };
}

function interruptedSnapshot(): AgentRuntimeRecoverySnapshot {
  const snapshot = completeSnapshot();
  return {
    ...snapshot,
    session: { ...snapshot.session, status: 'running' },
    turns: [
      {
        ...snapshot.turns[0],
        status: 'running',
        endedAt: null,
      },
    ],
    messages: [
      { ...snapshot.messages[0] },
      {
        ...snapshot.messages[1],
        id: 'message-partial',
        ordinal: 1,
        status: 'streaming',
        // A crash can leave an intentionally non-canonical partial payload.
        // Recovery must never promote or parse it as complete provider history.
        content: { incompleteProviderFrame: '{"tool":' },
        completedAt: null,
      },
    ],
    events: [
      event(1, { type: 'turn_started', prompt: 'Find Alice.' }),
      event(2, {
        type: 'model_iteration_started',
        iteration: 1,
        driverId: 'deepseek',
      }),
      event(3, { type: 'text_delta', iteration: 1, text: 'Par' }),
    ],
    toolCalls: [
      {
        ...snapshot.toolCalls[0],
        access: 'write',
        status: 'running',
        result: null,
        completedAt: null,
      },
    ],
  };
}

function addCompletedSecondTurn(
  snapshot: AgentRuntimeRecoverySnapshot,
): AgentRuntimeRecoverySnapshot {
  const secondTurnId = 'turn-2';
  const secondRoute = ROUTE;
  const secondEvent = (
    seq: number,
    runtimeEvent: AgentRuntimeEvent,
  ): PersistedAgentRuntimeEvent =>
    event(seq, runtimeEvent, {
      turnId: secondTurnId,
      eventId: `${secondTurnId}:${String(seq).padStart(8, '0')}`,
      payload: { route: secondRoute, event: runtimeEvent },
    });
  return {
    ...snapshot,
    turns: [
      ...snapshot.turns,
      {
        id: secondTurnId,
        sessionId: SESSION_ID,
        ordinal: 1,
        status: 'completed',
        promptMessageId: 'message-user-2',
        acceptedAt: NOW,
        startedAt: NOW,
        endedAt: NOW,
        errorCode: null,
        errorMessage: null,
        updatedAt: NOW,
      },
    ],
    messages: [
      ...snapshot.messages,
      {
        id: 'message-user-2',
        sessionId: SESSION_ID,
        turnId: secondTurnId,
        ordinal: 4,
        role: 'user',
        status: 'complete',
        content: 'Continue.',
        createdAt: NOW,
        completedAt: NOW,
      },
      {
        id: 'message-assistant-2',
        sessionId: SESSION_ID,
        turnId: secondTurnId,
        ordinal: 5,
        role: 'assistant',
        status: 'complete',
        content: [{ type: 'text', text: 'Continued.' }],
        createdAt: NOW,
        completedAt: NOW,
      },
    ],
    events: [
      ...snapshot.events,
      secondEvent(1, { type: 'turn_started', prompt: 'Continue.' }),
      secondEvent(2, {
        type: 'model_iteration_started',
        iteration: 1,
        driverId: 'deepseek',
      }),
      secondEvent(3, { type: 'text_delta', iteration: 1, text: 'Continued.' }),
      secondEvent(4, {
        type: 'model_usage',
        iteration: 1,
        usage: USAGE_2,
      }),
      secondEvent(5, {
        type: 'model_iteration_completed',
        iteration: 1,
        stopReason: 'end_turn',
      }),
      secondEvent(6, {
        type: 'turn_finished',
        outcome: 'completed',
        usage: USAGE_2,
        modelIterations: 1,
        durationMs: 100,
      }),
    ],
    // Reusing a provider callId in a later turn is legal. Identity is scoped by
    // turnId, not by the entire runtime session.
    toolCalls: [
      ...snapshot.toolCalls,
      {
        ...snapshot.toolCalls[0],
        id: 'tool-row-2',
        turnId: secondTurnId,
        callId: 'call-1',
        idempotencyKey: `${SESSION_ID}:${secondTurnId}:call-1`,
      },
    ],
  };
}

function failureCode(error: unknown): string | undefined {
  return error instanceof AgentRuntimeRecoveryCorruptionError
    ? error.code
    : undefined;
}

async function completeV2Context(
  history: readonly AgentModelMessage[],
): Promise<AgentRuntimeCheckpointContextV2> {
  const planned = await planAgentModelContext({
    systemPrompt: 'Drifting canonical agent policy.',
    messages: history,
    resolveToolAccess: (name) =>
      name === 'search_project' ? 'read' : undefined,
    planner: {
      contextWindowTokens: 20_000,
      requestedOutputTokens: 1_000,
      fixedInputTokens: 120,
    },
  });
  if (!planned.ok) {
    throw new Error(`V2 fixture planning failed: ${planned.error.code}`);
  }
  return createAgentRuntimeCheckpointContextV2({
    canonicalHistory: history,
    canonicalSourceRows: planned.bridge.sourceRows,
    providerEnvelope: planned.envelope,
  });
}

describe('Agent runtime canonical recovery', () => {
  it('rebuilds provider history and the UI transcript without display cache', async () => {
    const snapshot = completeSnapshot();
    const before = structuredClone(snapshot);
    const result = await recoverAgentRuntimeSnapshot(snapshot);

    expect(result.providerHistory).toEqual(
      completeMessages().map((row) => ({
        role: row.role,
        content: row.content,
      })),
    );
    expect(result.transcript).toMatchObject([
      { kind: 'user', text: 'Find Alice.' },
      { kind: 'assistant', text: 'Searching. ' },
      {
        kind: 'tool',
        id: 'call-1',
        name: 'search_project',
        status: 'ok',
        result: '{"hits":1}',
      },
      { kind: 'assistant', text: 'Alice appears once.' },
      {
        kind: 'usage',
        inputTokens: 30,
        outputTokens: 9,
        turns: 2,
        durationMs: 250,
      },
    ]);
    expect(result.repairs).toEqual([]);
    expect(result.plan).toEqual({
      session: null,
      turns: [],
      messages: [],
      toolCalls: [],
    });
    expect(snapshot).toEqual(before);
  });

  it('uses an exact verified checkpoint without duplicating its messages', async () => {
    const snapshot = completeSnapshot();
    const context = completeMessages().map((row) => ({
      role: row.role,
      content: row.content,
    })) as AgentModelMessage[];
    snapshot.checkpoints = [
      {
        id: 'checkpoint-1',
        sessionId: SESSION_ID,
        throughTurnOrdinal: 0,
        messageCount: context.length,
        context,
        contextHash: await hashAgentRuntimeCheckpointContext(context),
        createdAt: NOW,
      },
    ];

    const result = await recoverAgentRuntimeSnapshot(snapshot);
    expect(result.checkpointId).toBe('checkpoint-1');
    expect(result.providerHistory).toEqual(context);
  });

  it('recovers canonical history from a verified V2 provider envelope', async () => {
    const snapshot = completeSnapshot();
    const context = completeMessages().map((row) => ({
      role: row.role,
      content: row.content,
    })) as AgentModelMessage[];
    const durableContext = await completeV2Context(context);
    snapshot.checkpoints = [
      {
        id: 'checkpoint-v2',
        sessionId: SESSION_ID,
        throughTurnOrdinal: 0,
        messageCount: context.length,
        context: durableContext,
        contextHash: await hashAgentRuntimeCheckpointPayload(durableContext),
        createdAt: NOW,
      },
    ];

    const result = await recoverAgentRuntimeSnapshot(snapshot);
    expect(result.checkpointId).toBe('checkpoint-v2');
    expect(result.providerHistory).toEqual(context);
    expect(
      durableContext.canonicalHistory[
        durableContext.canonicalHistory.length - 1
      ],
    ).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Alice appears once.' }],
    });
  });

  it.each([
    {
      label: 'canonical history',
      mutate: (context: AgentRuntimeCheckpointContextV2) => {
        const message =
          context.canonicalHistory[context.canonicalHistory.length - 1];
        if (message?.role !== 'assistant') throw new Error('fixture drift');
        message.content[0] = { type: 'text', text: 'tampered answer' };
      },
    },
    {
      label: 'canonical source rows',
      mutate: (context: AgentRuntimeCheckpointContextV2) => {
        context.canonicalSourceRows[0].content = 'tampered policy';
      },
    },
    {
      label: 'source manifest',
      mutate: (context: AgentRuntimeCheckpointContextV2) => {
        context.providerEnvelope.sourceManifest[0].sourceHash = 'sha256:tampered';
      },
    },
    {
      label: 'source binding',
      mutate: (context: AgentRuntimeCheckpointContextV2) => {
        context.providerEnvelope.sourceBindings[0].sourceId = 'tampered-source';
      },
    },
    {
      label: 'provider projection',
      mutate: (context: AgentRuntimeCheckpointContextV2) => {
        context.providerEnvelope.providerContext.systemPrompt =
          'tampered provider policy';
      },
    },
    {
      label: 'planner budget',
      mutate: (context: AgentRuntimeCheckpointContextV2) => {
        context.providerEnvelope.plannerCheckpoint.budget.fixedInputTokens += 1;
      },
    },
  ])(
    'fails closed when V2 $label is changed even with a recomputed outer hash',
    async ({ mutate }) => {
      const snapshot = completeSnapshot();
      const history = completeMessages().map((row) => ({
        role: row.role,
        content: row.content,
      })) as AgentModelMessage[];
      const durableContext = await completeV2Context(history);
      mutate(durableContext);
      snapshot.checkpoints = [
        {
          id: 'checkpoint-v2-tampered',
          sessionId: SESSION_ID,
          throughTurnOrdinal: 0,
          messageCount: history.length,
          context: durableContext,
          contextHash: await hashAgentRuntimeCheckpointPayload(durableContext),
          createdAt: NOW,
        },
      ];

      await expect(recoverAgentRuntimeSnapshot(snapshot)).rejects.toSatisfy(
        (error: unknown) => failureCode(error) === 'INVALID_CHECKPOINT',
      );
    },
  );

  it('adds only post-checkpoint completed turns and permits callId reuse across turns', async () => {
    const snapshot = addCompletedSecondTurn(completeSnapshot());
    const context = completeMessages().map((row) => ({
      role: row.role,
      content: row.content,
    })) as AgentModelMessage[];
    snapshot.checkpoints = [
      {
        id: 'checkpoint-through-turn-1',
        sessionId: SESSION_ID,
        throughTurnOrdinal: 0,
        messageCount: context.length,
        context,
        contextHash: await hashAgentRuntimeCheckpointContext(context),
        createdAt: NOW,
      },
    ];

    const result = await recoverAgentRuntimeSnapshot(snapshot);
    expect(result.providerHistory).toEqual([
      ...context,
      { role: 'user', content: 'Continue.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Continued.' }],
      },
    ]);
    expect(result.turns).toHaveLength(2);
  });

  it('excludes complete prompts and malformed partial assistant state from an interrupted turn', async () => {
    const snapshot = interruptedSnapshot();
    const result = await recoverAgentRuntimeSnapshot(snapshot);

    expect(result.providerHistory).toEqual([]);
    expect(result.transcript).toEqual([{ kind: 'user', text: 'Find Alice.' }]);
    expect(result.plan).toMatchObject({
      session: {
        id: SESSION_ID,
        from: 'running',
        to: 'interrupted',
        reason: 'process_interrupted',
      },
      turns: [
        {
          id: TURN_ID,
          from: 'running',
          to: 'interrupted',
        },
      ],
      messages: [
        {
          id: 'message-partial',
          from: 'streaming',
          to: 'interrupted',
        },
      ],
      toolCalls: [
        {
          id: 'tool-row-1',
          from: 'running',
          to: 'uncertain',
        },
      ],
    });
  });

  it('recovers every contiguous journal crash prefix without promoting partial output', async () => {
    const journal = completeEvents();
    for (let length = 0; length <= journal.length; length += 1) {
      const snapshot = interruptedSnapshot();
      snapshot.events = journal.slice(0, length);
      snapshot.toolCalls = [];

      const result = await recoverAgentRuntimeSnapshot(snapshot);
      expect(
        result.providerHistory,
        `journal prefix length ${length}`,
      ).toEqual([]);
      expect(
        result.turns[0]?.recoveredStatus,
        `journal prefix length ${length}`,
      ).toBe('interrupted');
      expect(result.transcript[0], `journal prefix length ${length}`).toEqual({
        kind: 'user',
        text: 'Find Alice.',
      });
      expect(
        result.transcript.filter(
          (message) =>
            message.kind === 'assistant' ||
            message.kind === 'thinking' ||
            message.kind === 'tool',
        ),
        `journal prefix length ${length}`,
      ).toEqual([]);
    }
  });

  it('does not place a failed turn in future provider context, while retaining its UI trace', async () => {
    const snapshot = completeSnapshot();
    snapshot.session.status = 'idle';
    snapshot.turns[0] = {
      ...snapshot.turns[0],
      status: 'failed',
      errorCode: 'MODEL_ERROR',
      errorMessage: 'provider disconnected',
    };
    snapshot.events[snapshot.events.length - 1] = event(15, {
      type: 'turn_finished',
      outcome: 'failed',
      failureCode: 'MODEL_ERROR',
      message: 'provider disconnected',
      usage: TOTAL_USAGE,
      modelIterations: 2,
      durationMs: 250,
    });

    const result = await recoverAgentRuntimeSnapshot(snapshot);
    expect(result.providerHistory).toEqual([]);
    expect(result.transcript).toContainEqual({
      kind: 'error',
      text: 'provider disconnected',
    });
    expect(result.transcript).toContainEqual({
      kind: 'user',
      text: 'Find Alice.',
    });
  });

  it('does not infer a canonical commit from a terminal journal when the turn row is still running', async () => {
    const snapshot = completeSnapshot();
    snapshot.session.status = 'running';
    snapshot.turns[0] = {
      ...snapshot.turns[0],
      status: 'running',
      endedAt: null,
    };
    snapshot.messages = [snapshot.messages[0]];
    snapshot.toolCalls = [];

    const result = await recoverAgentRuntimeSnapshot(snapshot);
    expect(result.providerHistory).toEqual([]);
    expect(result.turns[0]).toMatchObject({
      persistedStatus: 'running',
      recoveredStatus: 'interrupted',
    });
    expect(result.plan.turns).toEqual([
      expect.objectContaining({
        id: TURN_ID,
        from: 'running',
        to: 'interrupted',
      }),
    ]);
  });

  it('closes an orphan completed tool call with a deterministic interrupted result', async () => {
    const snapshot = completeSnapshot();
    snapshot.messages = snapshot.messages
      .filter((message) => message.id !== 'message-tool')
      .map((message, ordinal) => ({ ...message, ordinal }));

    const result = await recoverAgentRuntimeSnapshot(snapshot);
    expect(result.repairs).toContainEqual({
      type: 'synthesized_interrupted_tool_result',
      turnId: TURN_ID,
      callId: 'call-1',
      name: 'search_project',
    });
    expect(result.providerHistory[2]).toEqual({
      role: 'tool',
      content: [
        {
          callId: 'call-1',
          name: 'search_project',
          ok: false,
          content:
            'Tool execution was interrupted before a durable result was recorded.',
        },
      ],
    });
    expect(result.transcript).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        id: 'call-1',
        status: 'error',
      }),
    );
  });

  it('drops an orphan tool result rather than inventing an assistant call', async () => {
    const snapshot = completeSnapshot();
    snapshot.messages[1] = {
      ...snapshot.messages[1],
      content: [{ type: 'text', text: 'Searching. ' }],
    };

    const result = await recoverAgentRuntimeSnapshot(snapshot);
    expect(result.repairs).toContainEqual({
      type: 'dropped_orphan_tool_result',
      turnId: TURN_ID,
      callId: 'call-1',
      name: 'search_project',
    });
    expect(result.providerHistory.some((message) => message.role === 'tool')).toBe(false);
    expect(result.transcript.some((message) => message.kind === 'tool')).toBe(false);
  });

  it('materializes recovery transitions idempotently', async () => {
    const snapshot = interruptedSnapshot();
    const first = await recoverAgentRuntimeSnapshot(snapshot);
    const materialized = applyAgentRuntimeRecoveryPlan(snapshot, first.plan);
    const appliedTwice = applyAgentRuntimeRecoveryPlan(materialized, first.plan);
    const second = await recoverAgentRuntimeSnapshot(appliedTwice);

    expect(appliedTwice).toEqual(materialized);
    expect(second.providerHistory).toEqual(first.providerHistory);
    expect(second.transcript).toEqual(first.transcript);
    expect(second.plan).toEqual({
      session: null,
      turns: [],
      messages: [],
      toolCalls: [],
    });
  });

  it('refuses to apply a stale recovery plan over a concurrently changed row', async () => {
    const snapshot = interruptedSnapshot();
    const result = await recoverAgentRuntimeSnapshot(snapshot);
    const concurrentlyChanged = {
      ...snapshot,
      turns: [{ ...snapshot.turns[0], status: 'completed' as const }],
    };

    expect(() =>
      applyAgentRuntimeRecoveryPlan(concurrentlyChanged, result.plan),
    ).toThrowError(
      expect.objectContaining({ code: 'STALE_RECOVERY_PLAN' }),
    );
  });

  it('fails closed on a sequence gap', async () => {
    const snapshot = completeSnapshot();
    snapshot.events.splice(3, 1);

    await expect(recoverAgentRuntimeSnapshot(snapshot)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === 'EVENT_SEQUENCE_INVALID',
    );
  });

  it('fails closed when a turn has two terminal events', async () => {
    const snapshot = completeSnapshot();
    snapshot.events.push(
      event(16, {
        type: 'turn_finished',
        outcome: 'completed',
        usage: TOTAL_USAGE,
        modelIterations: 2,
        durationMs: 251,
      }),
    );

    await expect(recoverAgentRuntimeSnapshot(snapshot)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === 'EVENT_SEQUENCE_INVALID',
    );
  });

  it('fails closed when the event type column drifts from its immutable payload', async () => {
    const snapshot = completeSnapshot();
    snapshot.events[2] = {
      ...snapshot.events[2],
      eventType: 'thinking_delta',
    };

    await expect(recoverAgentRuntimeSnapshot(snapshot)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === 'EVENT_PAYLOAD_INVALID',
    );
  });

  it('fails closed on checkpoint hash drift', async () => {
    const snapshot = completeSnapshot();
    const context = completeMessages().map((row) => ({
      role: row.role,
      content: row.content,
    })) as AgentModelMessage[];
    snapshot.checkpoints = [
      {
        id: 'checkpoint-corrupt',
        sessionId: SESSION_ID,
        throughTurnOrdinal: 0,
        messageCount: context.length,
        context,
        contextHash: 'sha256:bad',
        createdAt: NOW,
      },
    ];

    await expect(recoverAgentRuntimeSnapshot(snapshot)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === 'CHECKPOINT_HASH_MISMATCH',
    );
  });

  it('fails closed on foreign rows, duplicate ordinals, and terminal status drift', async () => {
    const foreign = completeSnapshot();
    foreign.messages[0] = { ...foreign.messages[0], sessionId: 'foreign' };
    await expect(recoverAgentRuntimeSnapshot(foreign)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === 'FOREIGN_REFERENCE',
    );

    const duplicate = completeSnapshot();
    duplicate.messages[1] = { ...duplicate.messages[1], ordinal: 0 };
    await expect(recoverAgentRuntimeSnapshot(duplicate)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === 'ORDER_INVALID',
    );

    const conflict = completeSnapshot();
    conflict.turns[0] = { ...conflict.turns[0], status: 'failed' };
    await expect(recoverAgentRuntimeSnapshot(conflict)).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === 'TURN_STATUS_CONFLICT',
    );
  });
});
