import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeRecoverySnapshot,
  PersistedAgentRuntimeSession,
  PersistedAgentRuntimeToolCall,
} from '../../../domain/agent-runtime-persistence';
import type {
  AcceptAgentRuntimeTurnInput,
  AgentRuntimePersistenceRepository,
  CommitAgentRuntimeTurnInput,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  createRepositoryAgentTransportPersistence,
  type AgentRuntimeRecoveryCodec,
} from './repository-transport-persistence';
import { hashAgentRuntimeCheckpointContext } from './recovery';
import type { AgentModelMessage } from './types';

const NOW = '2026-07-30T00:00:00.000Z';
const LATER = '2026-07-30T00:00:01.000Z';

function session(
  overrides: Partial<PersistedAgentRuntimeSession> = {},
): PersistedAgentRuntimeSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    routeKind: 'chat',
    conversationId: 'conversation-1',
    goalRunId: null,
    chapterId: null,
    provider: 'provider-old',
    model: 'model-old',
    providerEpoch: 2,
    status: 'running',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:01.000Z',
    endedAt: null,
    ...overrides,
  };
}

function snapshot(): AgentRuntimeRecoverySnapshot {
  return {
    session: session(),
    turns: [
      {
        id: 'turn-crashed',
        sessionId: 'session-1',
        ordinal: 0,
        status: 'running',
        promptMessageId: 'prompt-crashed',
        acceptedAt: '2026-07-29T00:00:01.000Z',
        startedAt: '2026-07-29T00:00:01.100Z',
        endedAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: '2026-07-29T00:00:01.100Z',
      },
    ],
    messages: [
      {
        id: 'prompt-crashed',
        sessionId: 'session-1',
        turnId: 'turn-crashed',
        ordinal: 0,
        role: 'user',
        status: 'complete',
        content: 'unanswered prompt',
        createdAt: '2026-07-29T00:00:01.000Z',
        completedAt: '2026-07-29T00:00:01.000Z',
      },
    ],
    events: [],
    toolCalls: [],
    checkpoints: [],
  };
}

interface FakeRepository {
  repository: AgentRuntimePersistenceRepository;
  state: AgentRuntimeRecoverySnapshot;
  order: string[];
  accepted: AcceptAgentRuntimeTurnInput[];
  committed: CommitAgentRuntimeTurnInput[];
  appended: Parameters<AgentRuntimePersistenceRepository['appendEvent']>[0][];
  toolCalls: PersistedAgentRuntimeToolCall[];
}

function fakeRepository(): FakeRepository {
  const state = snapshot();
  const order: string[] = [];
  const accepted: AcceptAgentRuntimeTurnInput[] = [];
  const committed: CommitAgentRuntimeTurnInput[] = [];
  const appended: Parameters<
    AgentRuntimePersistenceRepository['appendEvent']
  >[0][] = [];
  const toolCalls: PersistedAgentRuntimeToolCall[] = [];

  const repository = {
    getSession: vi.fn(async (id: string) =>
      id === state.session.id ? structuredClone(state.session) : null,
    ),
    findSessionForRoute: vi.fn(async () => structuredClone(state.session)),
    listTurns: vi.fn(async () => structuredClone(state.turns)),
    interruptSession: vi.fn(async (_id: string, at: string) => {
      order.push('interrupt');
      state.session.status = 'interrupted';
      state.session.updatedAt = at;
      state.turns[0] = {
        ...state.turns[0],
        status: 'interrupted',
        endedAt: at,
        errorCode: 'PROCESS_INTERRUPTED',
        errorMessage: 'Agent process stopped before the turn committed.',
        updatedAt: at,
      };
    }),
    loadRecoverySnapshot: vi.fn(async () => {
      order.push('recover');
      return structuredClone(state);
    }),
    acceptTurn: vi.fn(async (input: AcceptAgentRuntimeTurnInput) => {
      order.push('accept');
      accepted.push(structuredClone(input));
      state.session = structuredClone(input.session);
      state.turns.push(structuredClone(input.turn));
      state.messages.push(structuredClone(input.promptMessage));
      return 'inserted' as const;
    }),
    appendEvent: vi.fn(
      async (
        event: Parameters<
          AgentRuntimePersistenceRepository['appendEvent']
        >[0],
      ) => {
        appended.push(structuredClone(event));
        return { outcome: 'inserted' as const, event };
      },
    ),
    markTurnRunning: vi.fn(async () => {
      order.push('running');
      state.turns[state.turns.length - 1].status = 'running';
    }),
    listToolCalls: vi.fn(async () => structuredClone(toolCalls)),
    createToolCall: vi.fn(async (toolCall: PersistedAgentRuntimeToolCall) => {
      toolCalls.push(structuredClone(toolCall));
      return 'inserted' as const;
    }),
    updateToolCall: vi.fn(
      async (
        id: string,
        patch: Partial<PersistedAgentRuntimeToolCall>,
      ) => {
        const index = toolCalls.findIndex((toolCall) => toolCall.id === id);
        if (index < 0) throw new Error('missing tool call');
        toolCalls[index] = { ...toolCalls[index], ...structuredClone(patch) };
      },
    ),
    commitTurn: vi.fn(async (input: CommitAgentRuntimeTurnInput) => {
      committed.push(structuredClone(input));
      return 'inserted' as const;
    }),
  } as unknown as AgentRuntimePersistenceRepository;

  return {
    repository,
    state,
    order,
    accepted,
    committed,
    appended,
    toolCalls,
  };
}

describe('repository Agent transport persistence adapter', () => {
  it('hydrates provider history through the real strict recovery codec', async () => {
    const fake = fakeRepository();
    const route = {
      kind: 'chat' as const,
      projectId: 'project-1',
      conversationId: 'conversation-1',
    };
    const history: AgentModelMessage[] = [
      { role: 'user', content: 'first prompt' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'first answer' }],
      },
    ];
    fake.state.session = session({ status: 'idle' });
    fake.state.turns = [
      {
        id: 'turn-complete',
        sessionId: 'session-1',
        ordinal: 0,
        status: 'completed',
        promptMessageId: 'prompt-complete',
        acceptedAt: NOW,
        startedAt: NOW,
        endedAt: LATER,
        errorCode: null,
        errorMessage: null,
        updatedAt: LATER,
      },
    ];
    fake.state.messages = [
      {
        id: 'prompt-complete',
        sessionId: 'session-1',
        turnId: 'turn-complete',
        ordinal: 0,
        role: 'user',
        status: 'complete',
        content: 'first prompt',
        createdAt: NOW,
        completedAt: NOW,
      },
      {
        id: 'assistant-complete',
        sessionId: 'session-1',
        turnId: 'turn-complete',
        ordinal: 1,
        role: 'assistant',
        status: 'complete',
        content: [{ type: 'text', text: 'first answer' }],
        createdAt: LATER,
        completedAt: LATER,
      },
    ];
    const usage = {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    const events = [
      { type: 'turn_started' as const, prompt: 'first prompt' },
      {
        type: 'model_iteration_started' as const,
        iteration: 1,
        driverId: 'provider-old',
      },
      { type: 'text_delta' as const, iteration: 1, text: 'first answer' },
      { type: 'model_usage' as const, iteration: 1, usage },
      {
        type: 'model_iteration_completed' as const,
        iteration: 1,
        stopReason: 'end_turn' as const,
      },
      {
        type: 'turn_finished' as const,
        outcome: 'completed' as const,
        usage,
        modelIterations: 1,
        durationMs: 1000,
      },
    ];
    fake.state.events = events.map((event, index) => ({
      eventId: `turn-complete:${String(index + 1).padStart(8, '0')}`,
      sessionId: 'session-1',
      turnId: 'turn-complete',
      seq: index + 1,
      schemaVersion: 1,
      eventType: event.type,
      payload: { route, event },
      wallTimeMs: Date.parse(NOW) + index,
      createdAt: new Date(Date.parse(NOW) + index).toISOString(),
    }));
    fake.state.checkpoints = [
      {
        id: 'checkpoint-complete',
        sessionId: 'session-1',
        throughTurnOrdinal: 0,
        messageCount: history.length,
        context: history,
        contextHash: await hashAgentRuntimeCheckpointContext(history),
        createdAt: LATER,
      },
    ];
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      resolveToolAccess: () => 'read',
    });

    await expect(
      persistence.prepareTurn({
        candidateSessionId: 'session-unused',
        resumeSessionId: 'session-1',
        newConversation: false,
        route,
        provider: 'provider-old',
        model: 'model-old',
        turnId: 'turn-next',
        prompt: 'second prompt',
        acceptedAt: '2026-07-30T00:00:02.000Z',
      }),
    ).resolves.toEqual({
      sessionId: 'session-1',
      history,
      recovered: false,
    });
    expect(fake.accepted[0]?.turn.ordinal).toBe(1);
    expect(fake.accepted[0]?.promptMessage.ordinal).toBe(2);
  });

  it('repairs stale state, accepts the prompt before the provider, and commits a checkpoint from completed-turn history only', async () => {
    const fake = fakeRepository();
    const recoveredHistories: AgentModelMessage[][] = [];
    const hashInputs: AgentModelMessage[][] = [];
    const recovery: AgentRuntimeRecoveryCodec = {
      recoverSnapshot: async (current) => {
        expect(['running', 'interrupted']).toContain(
          current.turns[0]?.status,
        );
        recoveredHistories.push([]);
        return { providerHistory: [] };
      },
      hashCheckpointContext: async (context) => {
        hashInputs.push(
          context.map((message) => structuredClone(message)),
        );
        return 'sha256:checkpoint';
      },
    };
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      recovery,
      resolveToolAccess: () => 'read',
    });

    await expect(
      persistence.prepareTurn({
        candidateSessionId: 'session-unused',
        resumeSessionId: 'session-1',
        newConversation: false,
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
        provider: 'provider-new',
        model: 'model-new',
        turnId: 'turn-new',
        prompt: 'new prompt',
        acceptedAt: NOW,
      }),
    ).resolves.toEqual({
      sessionId: 'session-1',
      history: [],
      recovered: true,
    });

    expect(fake.order).toEqual([
      'recover',
      'interrupt',
      'recover',
      'accept',
    ]);
    expect(fake.accepted[0]?.session).toMatchObject({
      id: 'session-1',
      provider: 'provider-new',
      model: 'model-new',
      providerEpoch: 3,
    });
    expect(fake.accepted[0]?.turn).toMatchObject({
      id: 'turn-new',
      ordinal: 1,
      status: 'accepted',
    });
    expect(fake.accepted[0]?.promptMessage).toMatchObject({
      id: 'agent-message:turn-new:0',
      ordinal: 1,
      status: 'complete',
      content: 'new prompt',
    });

    await persistence.appendJournal({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-new',
      route: {
        kind: 'chat',
        projectId: 'project-1',
        conversationId: 'conversation-1',
      },
      seq: 1,
      eventId: 'turn-new:00000001',
      wallTimeMs: Date.parse(NOW),
      event: { type: 'turn_started', prompt: 'new prompt' },
    });
    expect(fake.appended[0]).toMatchObject({
      eventType: 'turn_started',
      payload: {
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
        event: { type: 'turn_started', prompt: 'new prompt' },
      },
    });
    expect(fake.order).toContain('running');

    const toolRoute = {
      kind: 'chat' as const,
      projectId: 'project-1',
      conversationId: 'conversation-1',
    };
    await persistence.appendJournal({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-new',
      route: toolRoute,
      seq: 2,
      eventId: 'turn-new:00000002',
      wallTimeMs: Date.parse(NOW) + 1,
      event: {
        type: 'tool_call_started',
        iteration: 1,
        callId: 'call-1',
        name: 'read_node',
      },
    });
    await persistence.appendJournal({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-new',
      route: toolRoute,
      seq: 3,
      eventId: 'turn-new:00000003',
      wallTimeMs: Date.parse(NOW) + 2,
      event: {
        type: 'tool_call_ready',
        iteration: 1,
        callId: 'call-1',
        name: 'read_node',
        arguments: { node: '第一章' },
        rawArguments: '{"node":"第一章"}',
      },
    });
    expect(fake.toolCalls[0]).toMatchObject({
      turnId: 'turn-new',
      callId: 'call-1',
      name: 'read_node',
      access: 'read',
      status: 'requested',
      arguments: { node: '第一章' },
    });
    await persistence.appendJournal({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-new',
      route: toolRoute,
      seq: 4,
      eventId: 'turn-new:00000004',
      wallTimeMs: Date.parse(NOW) + 3,
      event: {
        type: 'tool_execution_started',
        callId: 'call-1',
        name: 'read_node',
        access: 'read',
      },
    });
    await persistence.appendJournal({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-new',
      route: toolRoute,
      seq: 5,
      eventId: 'turn-new:00000005',
      wallTimeMs: Date.parse(NOW) + 4,
      event: {
        type: 'tool_result',
        callId: 'call-1',
        name: 'read_node',
        ok: true,
        content: 'chapter text',
        source: 'executor',
      },
    });
    expect(fake.toolCalls[0]).toMatchObject({
      status: 'completed',
      result: {
        ok: true,
        content: 'chapter text',
        source: 'executor',
      },
    });

    const turnMessages: AgentModelMessage[] = [
      { role: 'user', content: 'new prompt' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'complete answer' }],
      },
    ];
    await persistence.commitTurn({
      sessionId: 'session-1',
      turnId: 'turn-new',
      turnMessages,
      outcome: 'completed',
      errorCode: null,
      errorMessage: null,
      endedAt: LATER,
    });

    expect(hashInputs).toEqual([turnMessages]);
    expect(fake.committed[0]).toMatchObject({
      sessionId: 'session-1',
      turnId: 'turn-new',
      terminalStatus: 'completed',
      messages: [
        {
          id: 'agent-message:turn-new:1',
          ordinal: 2,
          role: 'assistant',
          status: 'complete',
          content: [{ type: 'text', text: 'complete answer' }],
        },
      ],
      checkpoint: {
        id: 'agent-checkpoint:session-1:1',
        throughTurnOrdinal: 1,
        messageCount: 2,
        context: turnMessages,
        contextHash: 'sha256:checkpoint',
      },
    });
    expect(recoveredHistories).toHaveLength(3);
  });

  it('fails closed on a cross-project resume before accepting a prompt', async () => {
    const fake = fakeRepository();
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      recovery: {
        recoverSnapshot: async () => ({ providerHistory: [] }),
        hashCheckpointContext: async () => 'sha256:unused',
      },
      resolveToolAccess: () => 'read',
    });

    await expect(
      persistence.prepareTurn({
        candidateSessionId: 'session-unused',
        resumeSessionId: 'session-1',
        newConversation: false,
        route: {
          kind: 'chat',
          projectId: 'foreign-project',
          conversationId: 'conversation-1',
        },
        provider: 'provider',
        model: null,
        turnId: 'turn-foreign',
        prompt: 'foreign',
        acceptedAt: NOW,
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_SESSION_ROUTE_MISMATCH',
    });
    expect(fake.accepted).toHaveLength(0);
  });

  it('validates a recovery snapshot before applying interruption repairs', async () => {
    const fake = fakeRepository();
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      recovery: {
        recoverSnapshot: async () => {
          throw new Error('corrupt journal');
        },
        hashCheckpointContext: async () => 'sha256:unused',
      },
      resolveToolAccess: () => 'read',
    });

    await expect(
      persistence.prepareTurn({
        candidateSessionId: 'session-unused',
        resumeSessionId: 'session-1',
        newConversation: false,
        route: {
          kind: 'chat',
          projectId: 'project-1',
          conversationId: 'conversation-1',
        },
        provider: 'provider',
        model: null,
        turnId: 'turn-after-corruption',
        prompt: 'must not mutate',
        acceptedAt: NOW,
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_PERSISTENCE_CORRUPT',
    });
    expect(fake.order).toEqual(['recover']);
    expect(fake.accepted).toHaveLength(0);
    expect(fake.state.turns[0]?.status).toBe('running');
  });

  it('checks cancellation before touching durable state', async () => {
    const fake = fakeRepository();
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      recovery: {
        recoverSnapshot: async () => ({ providerHistory: [] }),
        hashCheckpointContext: async () => 'sha256:unused',
      },
      resolveToolAccess: () => 'read',
    });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      persistence.prepareTurn(
        {
          candidateSessionId: 'session-unused',
          newConversation: true,
          route: { kind: 'chat', projectId: 'project-1' },
          provider: 'provider',
          model: null,
          turnId: 'turn-cancelled',
          prompt: 'cancel',
          acceptedAt: NOW,
        },
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
    expect(fake.order).toEqual([]);
  });

  it('keeps pre-execution runtime rejections in the journal without inventing a tool lifecycle row', async () => {
    const fake = fakeRepository();
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      recovery: {
        recoverSnapshot: async () => ({ providerHistory: [] }),
        hashCheckpointContext: async () => 'sha256:unused',
      },
      resolveToolAccess: () => undefined,
    });
    const route = { kind: 'chat' as const, projectId: 'project-1' };

    await persistence.appendJournal({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-crashed',
      route,
      seq: 1,
      eventId: 'unknown:1',
      wallTimeMs: Date.parse(NOW),
      event: {
        type: 'tool_call_started',
        iteration: 1,
        callId: 'unknown-1',
        name: 'invented_tool',
      },
    });
    await persistence.appendJournal({
      schemaVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-crashed',
      route,
      seq: 2,
      eventId: 'unknown:2',
      wallTimeMs: Date.parse(NOW) + 1,
      event: {
        type: 'tool_result',
        callId: 'unknown-1',
        name: 'invented_tool',
        ok: false,
        content: 'Unknown tool',
        source: 'runtime',
        errorCode: 'UNKNOWN_TOOL',
      },
    });

    expect(fake.appended).toHaveLength(2);
    expect(fake.toolCalls).toHaveLength(0);
  });
});
