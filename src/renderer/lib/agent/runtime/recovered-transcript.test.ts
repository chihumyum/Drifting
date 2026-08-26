import { describe, expect, it } from 'vitest';
import type { AgentRuntimeRecoverySnapshot } from '../../../domain/agent-runtime-persistence';
import type { AgentRuntimePersistenceRepository } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  findCanonicalAgentChatSessionId,
  loadCanonicalAgentChatProjection,
  loadCanonicalAgentTranscript,
} from './recovered-transcript';
import type { AgentRuntimeEvent, AgentRuntimeRoute, AgentRuntimeUsage } from './types';
import {
  AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE,
  AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE,
} from './types';
import { contextUsageSnapshot } from './context-usage.test-fixture';

const route: AgentRuntimeRoute = {
  kind: 'chat',
  projectId: 'project-1',
  conversationId: 'conversation-1',
};
const usage: AgentRuntimeUsage = {
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

function snapshot(): AgentRuntimeRecoverySnapshot {
  const now = '2026-07-31T00:00:00.000Z';
  const events: AgentRuntimeEvent[] = [
    { type: 'turn_started', prompt: 'do the whole task' },
    {
      type: 'model_iteration_started',
      iteration: 1,
      driverId: 'test-driver',
    },
    { type: 'context_planned', iteration: 1, snapshot: contextUsageSnapshot() },
    { type: 'text_delta', iteration: 1, text: 'partial progress' },
    { type: 'model_usage', iteration: 1, usage },
    {
      type: 'model_iteration_completed',
      iteration: 1,
      stopReason: 'unknown',
    },
    {
      type: 'turn_finished',
      outcome: 'budget_exceeded',
      failureCode: 'BUDGET_EXCEEDED',
      message: 'Turn budget reached',
      usage,
      modelIterations: 1,
      durationMs: 500,
    },
  ];
  return {
    session: {
      id: 'session-1',
      projectId: 'project-1',
      routeKind: 'chat',
      conversationId: 'conversation-1',
      goalRunId: null,
      chapterId: null,
      provider: 'test-driver',
      model: null,
      providerEpoch: 0,
      status: 'failed',
      createdAt: now,
      updatedAt: now,
      endedAt: now,
    },
    turns: [
      {
        id: 'turn-1',
        sessionId: 'session-1',
        ordinal: 0,
        status: 'completed',
        promptMessageId: 'message-user',
        acceptedAt: now,
        startedAt: now,
        endedAt: now,
        errorCode: 'BUDGET_EXCEEDED',
        errorMessage: 'Turn budget reached',
        updatedAt: now,
      },
    ],
    messages: [
      {
        id: 'message-user',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ordinal: 0,
        role: 'user',
        status: 'complete',
        content: 'do the whole task',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'message-assistant',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ordinal: 1,
        role: 'assistant',
        status: 'complete',
        content: [{ type: 'text', text: 'partial progress' }],
        createdAt: now,
        completedAt: now,
      },
    ],
    events: events.map((event, index) => {
      const seq = index + 1;
      return {
        eventId: `turn-1:${String(seq).padStart(8, '0')}`,
        sessionId: 'session-1',
        turnId: 'turn-1',
        seq,
        schemaVersion: 1,
        eventType: event.type,
        payload: { route, event },
        wallTimeMs: 1_800_000_000_000 + seq,
        createdAt: now,
      };
    }),
    toolCalls: [],
    checkpoints: [],
  };
}

function interruptedSnapshot(): AgentRuntimeRecoverySnapshot {
  const value = snapshot();
  const now = value.session.updatedAt;
  const hiddenPrompt = '【system context】\n\nRead the visible chapter.';
  const events: AgentRuntimeEvent[] = [
    { type: 'turn_started', prompt: hiddenPrompt },
    {
      type: 'model_iteration_started',
      iteration: 1,
      driverId: 'test-driver',
    },
    { type: 'thinking_delta', iteration: 1, text: 'checking context' },
    {
      type: 'tool_call_started',
      iteration: 1,
      callId: 'call-1',
      name: 'read_node',
    },
    {
      type: 'tool_args_delta',
      iteration: 1,
      callId: 'call-1',
      delta: '{"node":',
    },
  ];
  value.session = {
    ...value.session,
    status: 'running',
    endedAt: null,
  };
  value.turns = [
    {
      ...value.turns[0]!,
      status: 'running',
      endedAt: null,
      errorCode: null,
      errorMessage: null,
    },
  ];
  value.messages = [
    {
      ...value.messages[0]!,
      status: 'accepted',
      content: hiddenPrompt,
      completedAt: null,
    },
  ];
  value.events = events.map((event, index) => {
    const seq = index + 1;
    return {
      eventId: `turn-1:${String(seq).padStart(8, '0')}`,
      sessionId: 'session-1',
      turnId: 'turn-1',
      seq,
      schemaVersion: 1,
      eventType: event.type,
      payload: { route, event },
      wallTimeMs: 1_800_000_000_000 + seq,
      createdAt: now,
    };
  });
  return value;
}

function repository(value: AgentRuntimeRecoverySnapshot): AgentRuntimePersistenceRepository {
  return {
    loadRecoverySnapshot: async () => value,
  } as unknown as AgentRuntimePersistenceRepository;
}

describe('canonical Agent chat recovery projection', () => {
  it('finds a canonical session by the conversation route when the display cache missed its id', async () => {
    const findSessionForRoute = async () => snapshot().session;
    const found = await findCanonicalAgentChatSessionId('project-1', 'conversation-1', {
      findSessionForRoute,
    } as unknown as AgentRuntimePersistenceRepository);

    expect(found).toBe('session-1');
  });

  it('returns transcript, represented event ids, and the latest budget terminal', async () => {
    const persisted = snapshot();
    const projection = await loadCanonicalAgentChatProjection('session-1', repository(persisted));

    expect(projection?.eventIds).toEqual(persisted.events.map((event) => event.eventId));
    expect(projection?.lastTerminal).toEqual({
      turnId: 'turn-1',
      outcome: 'budget_exceeded',
      message: 'Turn budget reached',
    });
    expect(projection?.latestContextUsage).toEqual(contextUsageSnapshot());
    expect(projection?.messages).toEqual(
      expect.arrayContaining([
        { kind: 'user', text: 'do the whole task', at: '2026-07-31T00:00:00.000Z' },
        expect.objectContaining({
          kind: 'assistant',
          text: 'partial progress',
          streaming: false,
        }),
        { kind: 'error', text: 'Turn budget reached' },
      ]),
    );
    await expect(loadCanonicalAgentTranscript('session-1', repository(persisted))).resolves.toEqual(
      projection?.messages,
    );
  });

  it('renders a consolidated thinking row as one finished thinking message', async () => {
    const persisted = snapshot();
    const now = '2026-07-31T00:00:00.000Z';
    const events: AgentRuntimeEvent[] = [
      { type: 'turn_started', prompt: 'do the whole task' },
      { type: 'model_iteration_started', iteration: 1, driverId: 'test-driver' },
      { type: 'context_planned', iteration: 1, snapshot: contextUsageSnapshot() },
      {
        type: 'thinking_delta',
        iteration: 1,
        text: '先检查上下文。',
        consolidated: true,
      },
      { type: 'text_delta', iteration: 1, text: 'partial progress' },
      { type: 'model_usage', iteration: 1, usage },
      { type: 'model_iteration_completed', iteration: 1, stopReason: 'unknown' },
      {
        type: 'turn_finished',
        outcome: 'budget_exceeded',
        failureCode: 'BUDGET_EXCEEDED',
        message: 'Turn budget reached',
        usage,
        modelIterations: 1,
        durationMs: 500,
      },
    ];
    persisted.events = events.map((event, index) => {
      const seq = index + 1;
      return {
        eventId: `turn-1:${String(seq).padStart(8, '0')}`,
        sessionId: 'session-1',
        turnId: 'turn-1',
        seq,
        schemaVersion: 1,
        eventType: event.type,
        payload: { route, event },
        wallTimeMs: 1_800_000_000_000 + seq,
        createdAt: now,
      };
    });

    const projection = await loadCanonicalAgentChatProjection('session-1', repository(persisted));
    expect(
      projection?.messages.filter((message) => message.kind === 'thinking'),
    ).toEqual([{ kind: 'thinking', text: '先检查上下文。', streaming: false }]);
    expect(projection?.messages).toContainEqual(
      expect.objectContaining({ kind: 'assistant', text: 'partial progress' }),
    );
  });

  it('keeps runtime continuation prompts in model history but out of the visible transcript', async () => {
    const persisted = snapshot();
    const started = persisted.events.find((event) => event.eventType === 'turn_started')!;
    started.payload = {
      route,
      event: {
        type: 'turn_started',
        prompt: 'continue the durable plan',
        promptSource: 'runtime_continuation',
      },
    };
    persisted.messages[0] = {
      ...persisted.messages[0]!,
      content: 'continue the durable plan',
    };

    const projection = await loadCanonicalAgentChatProjection('session-1', repository(persisted));
    expect(projection?.messages.some((message) => message.kind === 'user')).toBe(false);
    expect(JSON.stringify(projection?.messages)).not.toContain('continue the durable plan');
    expect(projection?.messages).toContainEqual(
      expect.objectContaining({ kind: 'assistant', text: 'partial progress' }),
    );
  });

  it('fails closed partial canonical thinking/tool arguments after an interrupted restart', async () => {
    const persisted = interruptedSnapshot();
    const projection = await loadCanonicalAgentChatProjection('session-1', repository(persisted), [
      {
        kind: 'user',
        text: 'Read the visible chapter.',
        at: '2026-07-30T12:34:00.000Z',
      },
    ]);

    expect(projection?.messages).toEqual([
      {
        kind: 'user',
        text: 'Read the visible chapter.',
        at: '2026-07-30T12:34:00.000Z',
      },
      { kind: 'thinking', text: 'checking context', streaming: false },
      {
        kind: 'tool',
        id: 'call-1',
        name: 'read_node',
        inputText: '{"node":',
        phase: 'arguments',
        status: 'error',
        result: AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE,
      },
      { kind: 'error', text: AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE },
    ]);
    expect(projection?.lastTerminal).toEqual({
      turnId: 'turn-1',
      outcome: 'failed',
      message: AGENT_RUNTIME_INTERRUPTED_RECOVERY_MESSAGE,
    });
    expect(JSON.stringify(projection?.messages)).not.toContain('system context');
  });

  it('preserves unmatched preflight prompts and adjacent errors without trusting cached model rows', async () => {
    const persisted = snapshot();
    const projection = await loadCanonicalAgentChatProjection('session-1', repository(persisted), [
      { kind: 'user', text: 'prompt whose preflight failed' },
      { kind: 'error', text: 'Provider credential was unavailable.' },
      { kind: 'assistant', text: 'stale cached assistant text' },
      {
        kind: 'tool',
        id: 'stale-tool',
        name: 'untrusted_cached_tool',
        status: 'running',
      },
      { kind: 'user', text: 'do the whole task' },
    ]);

    expect(projection?.messages.slice(0, 3)).toEqual([
      { kind: 'user', text: 'prompt whose preflight failed' },
      { kind: 'error', text: 'Provider credential was unavailable.' },
      { kind: 'user', text: 'do the whole task', at: '2026-07-31T00:00:00.000Z' },
    ]);
    expect(JSON.stringify(projection?.messages)).not.toContain('stale cached assistant text');
    expect(JSON.stringify(projection?.messages)).not.toContain('untrusted_cached_tool');
  });

  it('keeps a failed same-text preflight attempt before the later canonical retry', async () => {
    const persisted = snapshot();
    const projection = await loadCanonicalAgentChatProjection('session-1', repository(persisted), [
      { kind: 'user', text: 'do the whole task' },
      { kind: 'error', text: 'Provider preflight failed.' },
      { kind: 'user', text: 'do the whole task' },
    ]);

    expect(projection?.messages.slice(0, 3)).toEqual([
      { kind: 'user', text: 'do the whole task' },
      { kind: 'error', text: 'Provider preflight failed.' },
      { kind: 'user', text: 'do the whole task', at: '2026-07-31T00:00:00.000Z' },
    ]);
  });

  it('projects a terminal-without-commit crash window as failed, never completed', async () => {
    const persisted = snapshot();
    persisted.session = {
      ...persisted.session,
      status: 'running',
      endedAt: null,
    };
    persisted.turns = persisted.turns.map((turn) => ({
      ...turn,
      status: 'running',
      endedAt: null,
    }));
    persisted.messages = persisted.messages.filter((message) => message.role === 'user');

    const projection = await loadCanonicalAgentChatProjection('session-1', repository(persisted), [
      { kind: 'user', text: 'do the whole task' },
    ]);

    expect(projection?.lastTerminal).toEqual({
      turnId: 'turn-1',
      outcome: 'failed',
      message: AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE,
    });
    expect(projection?.messages).toContainEqual({
      kind: 'error',
      text: AGENT_RUNTIME_DURABLE_COMMIT_FAILURE_MESSAGE,
    });
  });
});
