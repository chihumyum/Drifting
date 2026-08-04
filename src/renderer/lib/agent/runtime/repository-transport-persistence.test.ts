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
import { hashAgentPermissionArguments } from './control-plane';
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
  it('lists recovered wait points and safely cancels them without approving a lost execution stack', async () => {
    const fake = fakeRepository();
    const route = {
      kind: 'chat' as const,
      projectId: 'project-1',
      conversationId: 'conversation-1',
    };
    const args = { expectedRevision: 'rev-1', title: 'New' };
    const argumentsHash = await hashAgentPermissionArguments(args);
    fake.state.messages = [{
      id: 'prompt-crashed',
      sessionId: 'session-1',
      turnId: 'turn-crashed',
      ordinal: 0,
      role: 'user',
      status: 'complete',
      content: 'unanswered prompt',
      createdAt: NOW,
      completedAt: NOW,
    }];
    const usage = {
      inputTokens: 2,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    const events = [
      { type: 'turn_started' as const, prompt: 'unanswered prompt' },
      {
        type: 'model_iteration_started' as const,
        iteration: 1,
        driverId: 'provider-old',
      },
      {
        type: 'tool_call_started' as const,
        iteration: 1,
        callId: 'call-1',
        name: 'rename_node',
      },
      {
        type: 'tool_args_delta' as const,
        iteration: 1,
        callId: 'call-1',
        delta: JSON.stringify(args),
      },
      {
        type: 'tool_call_ready' as const,
        iteration: 1,
        callId: 'call-1',
        name: 'rename_node',
        arguments: args,
        rawArguments: JSON.stringify(args),
      },
      { type: 'model_usage' as const, iteration: 1, usage },
      {
        type: 'model_iteration_completed' as const,
        iteration: 1,
        stopReason: 'tool_use' as const,
      },
      {
        type: 'permission_requested' as const,
        request: {
          requestId: 'permission-1',
          sessionId: 'session-1',
          turnId: 'turn-crashed',
          callId: 'call-1',
          toolName: 'rename_node',
          access: 'write' as const,
          arguments: args,
          argumentsHash,
          revision: 'rev-1',
          allowedScopes: ['once' as const],
        },
      },
    ];
    fake.state.events = events.map((runtimeEvent, index) => ({
      eventId: `turn-crashed:${String(index + 1).padStart(8, '0')}`,
      sessionId: 'session-1',
      turnId: 'turn-crashed',
      seq: index + 1,
      schemaVersion: 1,
      eventType: runtimeEvent.type,
      payload: { route, event: runtimeEvent },
      wallTimeMs: Date.parse(NOW) + index,
      createdAt: new Date(Date.parse(NOW) + index).toISOString(),
    }));
    fake.state.toolCalls = [{
      id: 'tool-1',
      sessionId: 'session-1',
      turnId: 'turn-crashed',
      callId: 'call-1',
      name: 'rename_node',
      access: 'write',
      status: 'requested',
      idempotencyKey: 'session-1:turn-crashed:call-1',
      arguments: args,
      result: null,
      errorCode: null,
      createdAt: NOW,
      startedAt: null,
      completedAt: null,
    }];
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      resolveToolAccess: () => 'write',
    });

    await expect(
      persistence.listPendingControls!({ sessionId: 'session-1' }),
    ).resolves.toEqual([expect.objectContaining({
      status: 'waiting_permission',
      requiresContinuation: true,
      permissionRequest: expect.objectContaining({
        requestId: 'permission-1',
        argumentsHash,
      }),
    })]);

    await persistence.cancelPendingControl!({
      sessionId: 'session-1',
      turnId: 'turn-crashed',
      requestId: 'permission-1',
      reason: 'cancel after restart',
    });

    expect(fake.appended.slice(-3).map((row) => row.eventType)).toEqual([
      'permission_resolved',
      'cancellation_requested',
      'tool_result',
    ]);
    expect(fake.appended[fake.appended.length - 1]?.payload).toMatchObject({
      event: {
        errorCode: 'RECOVERED_CONTROL_CANCELLED',
      },
    });
    expect(fake.order).toContain('interrupt');
  });

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

  it('restores only the author request when explicitly continuing an aborted turn', async () => {
    const fake = fakeRepository();
    fake.state.session = session({ status: 'idle' });
    fake.state.turns[0] = {
      ...fake.state.turns[0]!,
      status: 'aborted',
      endedAt: LATER,
      errorCode: null,
      errorMessage: 'Agent turn aborted by user',
      updatedAt: LATER,
    };
    fake.state.messages[0] = {
      ...fake.state.messages[0]!,
      content: '整体润色第八章和第九章，并同步两个摘要。',
    };
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      recovery: {
        recoverSnapshot: async () => ({ providerHistory: [] }),
        hashCheckpointContext: hashAgentRuntimeCheckpointContext,
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
        provider: 'provider-old',
        model: 'model-old',
        turnId: 'turn-continue',
        prompt: '继续把刚才的任务做完。',
        acceptedAt: NOW,
      }),
    ).resolves.toMatchObject({
      history: [
        {
          role: 'user',
          content: '整体润色第八章和第九章，并同步两个摘要。',
        },
      ],
    });
  });

  it('does not revive an aborted author request when the author changes tasks', async () => {
    const fake = fakeRepository();
    fake.state.session = session({ status: 'idle' });
    fake.state.turns[0] = {
      ...fake.state.turns[0]!,
      status: 'aborted',
      endedAt: LATER,
      errorCode: null,
      errorMessage: 'Agent turn aborted by user',
      updatedAt: LATER,
    };
    fake.state.messages[0] = {
      ...fake.state.messages[0]!,
      content: '整体润色第八章和第九章。',
    };
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      recovery: {
        recoverSnapshot: async () => ({ providerHistory: [] }),
        hashCheckpointContext: hashAgentRuntimeCheckpointContext,
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
        provider: 'provider-old',
        model: 'model-old',
        turnId: 'turn-new-task',
        prompt: '改第十章结尾。',
        acceptedAt: NOW,
      }),
    ).resolves.toMatchObject({ history: [] });
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
    const interruptSessionWrites = vi.fn(
      async (_sessionId: string, _at: string) => {
        fake.order.push('interrupt-writes');
        return {
          failedBeforeMutation: 0,
          uncertainAfterMutationStart: 1,
        };
      },
    );
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      writeEffects: { interruptSessionWrites },
      beforeResumeSession: vi.fn(async (sessionId) => {
        expect(sessionId).toBe('session-1');
        fake.order.push('reconcile-writes');
      }),
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
      'reconcile-writes',
      'interrupt-writes',
      'interrupt',
      'recover',
      'accept',
    ]);
    expect(interruptSessionWrites).toHaveBeenCalledWith('session-1', NOW);
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

  it('acknowledges an exact retry when SQLite committed but the success response was lost', async () => {
    const fake = fakeRepository();
    const turnMessages: AgentModelMessage[] = [
      { role: 'user', content: 'commit once' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'durable answer' }],
      },
    ];
    fake.state.turns = [
      {
        id: 'turn-committed',
        sessionId: 'session-1',
        ordinal: 0,
        status: 'completed',
        promptMessageId: 'agent-message:turn-committed:0',
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
        id: 'agent-message:turn-committed:0',
        sessionId: 'session-1',
        turnId: 'turn-committed',
        ordinal: 0,
        role: 'user',
        status: 'complete',
        content: 'commit once',
        createdAt: NOW,
        completedAt: NOW,
      },
      {
        id: 'agent-message:turn-committed:1',
        sessionId: 'session-1',
        turnId: 'turn-committed',
        ordinal: 1,
        role: 'assistant',
        status: 'complete',
        content: [{ type: 'text', text: 'durable answer' }],
        createdAt: LATER,
        completedAt: LATER,
      },
    ];
    fake.state.checkpoints = [
      {
        id: 'agent-checkpoint:session-1:0',
        sessionId: 'session-1',
        throughTurnOrdinal: 0,
        messageCount: 2,
        context: turnMessages,
        contextHash: 'sha256:already-verified',
        createdAt: LATER,
      },
    ];
    const persistence = createRepositoryAgentTransportPersistence({
      repository: fake.repository,
      recovery: {
        recoverSnapshot: async () => ({ providerHistory: turnMessages }),
        hashCheckpointContext: async () => 'sha256:not-needed',
      },
      resolveToolAccess: () => 'read',
    });

    await expect(
      persistence.commitTurn({
        sessionId: 'session-1',
        turnId: 'turn-committed',
        turnMessages,
        outcome: 'completed',
        errorCode: null,
        errorMessage: null,
        endedAt: LATER,
      }),
    ).resolves.toBeUndefined();
    expect(fake.committed).toHaveLength(0);

    await expect(
      persistence.commitTurn({
        sessionId: 'session-1',
        turnId: 'turn-committed',
        turnMessages: [
          turnMessages[0],
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'different answer' }],
          },
        ],
        outcome: 'completed',
        errorCode: null,
        errorMessage: null,
        endedAt: LATER,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_PERSISTENCE_CONFLICT' });
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
