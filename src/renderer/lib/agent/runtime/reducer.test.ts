import { describe, expect, it } from 'vitest';
import {
  agentRuntimeEventId,
  createAgentRuntimeState,
  reduceAgentRuntimeJournal,
  replayAgentRuntimeJournal,
} from './reducer';
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  type AgentRuntimeEvent,
  type AgentRuntimeJournalEntry,
  type AgentRuntimeRoute,
  type AgentRuntimeUsage,
} from './types';
import { contextUsageSnapshot } from './context-usage.test-fixture';

const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';
const ROUTE: AgentRuntimeRoute = {
  kind: 'chat',
  projectId: 'project-1',
  conversationId: 'conversation-1',
};

function entry(
  seq: number,
  event: AgentRuntimeEvent,
  overrides: Partial<AgentRuntimeJournalEntry> = {},
): AgentRuntimeJournalEntry {
  const turnId = overrides.turnId ?? TURN_ID;
  return {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    sessionId: overrides.sessionId ?? SESSION_ID,
    turnId,
    route: overrides.route ?? ROUTE,
    seq,
    eventId: overrides.eventId ?? agentRuntimeEventId(turnId, seq),
    wallTimeMs: overrides.wallTimeMs ?? 1_000 + seq,
    event,
  };
}

const USAGE_1: AgentRuntimeUsage = {
  inputTokens: 10,
  outputTokens: 4,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  costUsd: 0.25,
};

const USAGE_2: AgentRuntimeUsage = {
  inputTokens: 3,
  outputTokens: 2,
  cacheReadTokens: 1,
  cacheWriteTokens: 0,
  costUsd: 0.5,
};

const TOTAL_USAGE: AgentRuntimeUsage = {
  inputTokens: 13,
  outputTokens: 6,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  costUsd: 0.75,
};

function completeJournal(): AgentRuntimeJournalEntry[] {
  const rawArguments = '{"query":"Alice"}';
  return [
    entry(1, { type: 'turn_started', prompt: 'Find Alice and summarize the result.' }),
    entry(2, { type: 'model_iteration_started', iteration: 1, driverId: 'fake-driver' }),
    entry(3, { type: 'thinking_delta', iteration: 1, text: 'I should search. ' }),
    entry(4, { type: 'text_delta', iteration: 1, text: 'Searching now. ' }),
    entry(5, {
      type: 'tool_call_started',
      iteration: 1,
      callId: 'call-1',
      name: 'search_project',
    }),
    entry(6, {
      type: 'tool_args_delta',
      iteration: 1,
      callId: 'call-1',
      delta: '{"query":',
    }),
    entry(7, {
      type: 'tool_args_delta',
      iteration: 1,
      callId: 'call-1',
      delta: '"Alice"}',
    }),
    entry(8, {
      type: 'tool_call_ready',
      iteration: 1,
      callId: 'call-1',
      name: 'search_project',
      arguments: { query: 'Alice' },
      rawArguments,
    }),
    entry(9, { type: 'model_usage', iteration: 1, usage: USAGE_1 }),
    entry(10, {
      type: 'model_iteration_completed',
      iteration: 1,
      stopReason: 'tool_use',
    }),
    entry(11, {
      type: 'tool_execution_started',
      callId: 'call-1',
      name: 'search_project',
      access: 'read',
    }),
    entry(12, {
      type: 'tool_result',
      callId: 'call-1',
      name: 'search_project',
      ok: true,
      content: '{"hits":1}',
      source: 'executor',
    }),
    entry(13, { type: 'model_iteration_started', iteration: 2, driverId: 'fake-driver' }),
    entry(14, { type: 'text_delta', iteration: 2, text: 'Alice appears once.' }),
    entry(15, { type: 'model_usage', iteration: 2, usage: USAGE_2 }),
    entry(16, {
      type: 'model_iteration_completed',
      iteration: 2,
      stopReason: 'end_turn',
    }),
    entry(17, {
      type: 'turn_finished',
      outcome: 'completed',
      usage: TOTAL_USAGE,
      modelIterations: 2,
      durationMs: 250,
    }),
  ];
}

describe('agent runtime journal reducer', () => {
  it('folds a complete two-iteration tool-calling journal into its terminal state', () => {
    const entries = completeJournal();
    const state = replayAgentRuntimeJournal(entries);

    expect(state).toMatchObject({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      route: ROUTE,
      status: 'completed',
      lastSeq: entries.length,
      lastEventId: agentRuntimeEventId(TURN_ID, entries.length),
      journalEntries: entries.length,
      prompt: 'Find Alice and summarize the result.',
      startedAtMs: 1_001,
      endedAtMs: 1_017,
      activeIteration: null,
      modelIterations: 2,
      assistantText: 'Searching now. Alice appears once.',
      thinkingText: 'I should search. ',
      toolOrder: ['call-1'],
      usage: TOTAL_USAGE,
    });
    expect(state.tools['call-1']).toEqual({
      callId: 'call-1',
      name: 'search_project',
      iteration: 1,
      argumentsText: '{"query":"Alice"}',
      arguments: { query: 'Alice' },
      status: 'completed',
      result: {
        ok: true,
        content: '{"hits":1}',
        source: 'executor',
      },
    });
    expect(state.terminal).toEqual(entries[entries.length - 1]?.event);
  });

  it('rejects seq gaps, duplicate delivery, and out-of-order delivery', () => {
    const initial = createAgentRuntimeState(SESSION_ID, TURN_ID, ROUTE);
    const startedEntry = entry(1, { type: 'turn_started', prompt: 'hello' });
    const started = reduceAgentRuntimeJournal(initial, startedEntry);

    expect(() =>
      reduceAgentRuntimeJournal(
        started,
        entry(3, { type: 'model_iteration_started', iteration: 1, driverId: 'fake-driver' }),
      ),
    ).toThrow('expected seq 2, got 3');

    expect(() => reduceAgentRuntimeJournal(started, startedEntry)).toThrow(
      'expected seq 2, got 1',
    );

    expect(() =>
      reduceAgentRuntimeJournal(
        initial,
        entry(2, { type: 'model_iteration_started', iteration: 1, driverId: 'fake-driver' }),
      ),
    ).toThrow('expected seq 1, got 2');
  });

  it('rejects an eventId that does not match its turn and seq', () => {
    const initial = createAgentRuntimeState(SESSION_ID, TURN_ID, ROUTE);
    const started = reduceAgentRuntimeJournal(
      initial,
      entry(1, { type: 'turn_started', prompt: 'hello' }),
    );

    expect(() =>
      reduceAgentRuntimeJournal(
        started,
        entry(
          2,
          { type: 'model_iteration_started', iteration: 1, driverId: 'fake-driver' },
          { eventId: 'turn-1:conflicting-event-id' },
        ),
      ),
    ).toThrow('unexpected eventId "turn-1:conflicting-event-id"');
  });

  it('fails closed when a context snapshot does not belong to the active iteration', () => {
    let state = createAgentRuntimeState(SESSION_ID, TURN_ID, ROUTE);
    state = reduceAgentRuntimeJournal(
      state,
      entry(1, { type: 'turn_started', prompt: 'hello' }),
    );
    state = reduceAgentRuntimeJournal(
      state,
      entry(2, { type: 'model_iteration_started', iteration: 1, driverId: 'fake-driver' }),
    );

    expect(() =>
      reduceAgentRuntimeJournal(
        state,
        entry(3, {
          type: 'context_planned',
          iteration: 2,
          snapshot: contextUsageSnapshot(2),
        }),
      ),
    ).toThrow('context snapshot belongs to iteration 2, active iteration is 1');
    expect(() =>
      reduceAgentRuntimeJournal(
        state,
        entry(3, {
          type: 'context_planned',
          iteration: 1,
          snapshot: contextUsageSnapshot(2),
        }),
      ),
    ).toThrow('context snapshot iteration does not match its journal event');
  });

  it('rejects a validly sequenced event after the terminal event', () => {
    const entries = completeJournal();
    const terminal = replayAgentRuntimeJournal(entries);
    const late = entry(entries.length + 1, {
      type: 'text_delta',
      iteration: 2,
      text: 'late provider chunk',
    });

    expect(() => reduceAgentRuntimeJournal(terminal, late)).toThrow(
      'event text_delta arrived after terminal event',
    );
  });

  it.each(['end_turn', 'max_tokens', 'content_filter', 'unknown'] as const)(
    'rejects a new model iteration after %s',
    (stopReason) => {
      let state = createAgentRuntimeState(SESSION_ID, TURN_ID, ROUTE);
      for (const item of [
        entry(1, { type: 'turn_started', prompt: 'hello' }),
        entry(2, { type: 'model_iteration_started', iteration: 1, driverId: 'fake-driver' }),
        entry(3, { type: 'model_usage', iteration: 1, usage: USAGE_1 }),
        entry(4, { type: 'model_iteration_completed', iteration: 1, stopReason }),
      ]) {
        state = reduceAgentRuntimeJournal(state, item);
      }

      expect(() =>
        reduceAgentRuntimeJournal(
          state,
          entry(5, {
            type: 'model_iteration_started',
            iteration: 2,
            driverId: 'fake-driver',
          }),
        ),
      ).toThrow(`cannot continue after ${stopReason}`);
    },
  );

  it('replays identically after a JSON serialization roundtrip', () => {
    const entries = completeJournal();
    const roundtripped = JSON.parse(JSON.stringify(entries)) as AgentRuntimeJournalEntry[];

    expect(replayAgentRuntimeJournal(roundtripped)).toEqual(
      replayAgentRuntimeJournal(entries),
    );
  });

  it('rejects invalid usage and terminal duration during replay', () => {
    let state = createAgentRuntimeState(SESSION_ID, TURN_ID, ROUTE);
    state = reduceAgentRuntimeJournal(
      state,
      entry(1, { type: 'turn_started', prompt: 'hello' }),
    );
    state = reduceAgentRuntimeJournal(
      state,
      entry(2, { type: 'model_iteration_started', iteration: 1, driverId: 'fake-driver' }),
    );
    expect(() =>
      reduceAgentRuntimeJournal(
        state,
        entry(3, {
          type: 'model_usage',
          iteration: 1,
          usage: { ...USAGE_1, inputTokens: -1 },
        }),
      ),
    ).toThrow('invalid usage inputTokens=-1');

    const entries = completeJournal();
    const terminal = entries[entries.length - 1];
    if (terminal.event.type !== 'turn_finished') throw new Error('expected terminal fixture');
    entries[entries.length - 1] = {
      ...terminal,
      event: { ...terminal.event, durationMs: -1 },
    };
    expect(() => replayAgentRuntimeJournal(entries)).toThrow(
      'invalid terminal durationMs=-1',
    );
  });

  it.each([
    {
      label: 'session',
      overrides: { sessionId: 'session-2' } satisfies Partial<AgentRuntimeJournalEntry>,
      message: 'sessionId changed inside journal',
    },
    {
      label: 'turn',
      overrides: { turnId: 'turn-2' } satisfies Partial<AgentRuntimeJournalEntry>,
      message: 'turnId changed inside journal',
    },
    {
      label: 'route',
      overrides: {
        route: {
          kind: 'chat',
          projectId: 'project-2',
          conversationId: 'conversation-1',
        },
      } satisfies Partial<AgentRuntimeJournalEntry>,
      message: 'route changed inside journal',
    },
  ])('rejects a $label change inside one journal', ({ overrides, message }) => {
    const initial = createAgentRuntimeState(SESSION_ID, TURN_ID, ROUTE);
    const started = reduceAgentRuntimeJournal(
      initial,
      entry(1, { type: 'turn_started', prompt: 'hello' }),
    );
    const mismatched = entry(
      2,
      { type: 'model_iteration_started', iteration: 1, driverId: 'fake-driver' },
      overrides,
    );

    expect(() => reduceAgentRuntimeJournal(started, mismatched)).toThrow(message);
  });
});
