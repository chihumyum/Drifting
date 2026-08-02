import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../domain/agent-conversation';
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  type AgentRuntimeEvent,
  type AgentRuntimeJournalEntry,
} from '../lib/agent/runtime/types';
import {
  AgentConversationLoadGuard,
  ACTIVE_PLAN_CONTINUATION_PROMPT,
  applyEvent,
  BUDGET_CONTINUATION_PROMPT,
  selectAgentTaskContinuationReason,
  selectCanContinueAgentTask,
  useAgentChatStore,
} from './agent-chat-store';
import {
  createInactiveAgentAutomaticContinuation,
  type AgentLongTaskPlanContinuationState,
} from '../lib/agent/runtime/long-task-auto-continuation';

function continuationPlanState(
  status: AgentLongTaskPlanContinuationState['status'],
  sessionId = 'session-1',
): AgentLongTaskPlanContinuationState {
  return {
    sessionId,
    taskId: status === 'none' ? null : 'task-1',
    revision: status === 'none' ? null : 1,
    status,
    scopeKind: status === 'none' ? null : 'whole_book_chapters',
    runnableStepCount: status === 'active' ? 1 : 0,
    waitingReviewStepCount: 0,
    manifestStatus: status === 'none' ? 'not_applicable' : 'current',
    needsManifestReconciliation: false,
    needsFinalization: false,
    progressFingerprint: `${sessionId}:${status}`,
  };
}

function journal(event: AgentRuntimeEvent, seq = 1): AgentRuntimeJournalEntry {
  return {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    sessionId: 'session-1',
    turnId: 'turn-1',
    route: {
      kind: 'chat',
      projectId: 'project-1',
      conversationId: 'conversation-1',
    },
    seq,
    eventId: `turn-1:${String(seq).padStart(8, '0')}`,
    wallTimeMs: 1_700_000_000_000 + seq,
    event,
  };
}

const usage = {
  inputTokens: 3,
  outputTokens: 5,
  cacheReadTokens: 7,
  cacheWriteTokens: 11,
  costUsd: 0.01,
};

describe('agent chat canonical journal projection', () => {
  it('renders text deltas immediately and finalizes only from canonical lifecycle events', () => {
    const first = applyEvent([], journal({ type: 'text_delta', iteration: 1, text: '逐' }));
    expect(first).toEqual([{ kind: 'assistant', text: '逐', streaming: true }]);

    const second = applyEvent(
      first,
      journal({ type: 'text_delta', iteration: 1, text: '字出现' }, 2),
    );
    expect(second).toEqual([{ kind: 'assistant', text: '逐字出现', streaming: true }]);

    expect(
      applyEvent(
        second,
        journal(
          {
            type: 'model_iteration_completed',
            iteration: 1,
            stopReason: 'end_turn',
          },
          3,
        ),
      ),
    ).toEqual([{ kind: 'assistant', text: '逐字出现', streaming: false }]);
  });

  it('shows fragmented tool arguments before ready/execution/result', () => {
    let messages = applyEvent(
      [],
      journal({
        type: 'tool_call_started',
        iteration: 1,
        callId: 'call-1',
        name: 'read_node',
      }),
    );
    expect(messages).toEqual([
      {
        kind: 'tool',
        id: 'call-1',
        name: 'read_node',
        inputText: '',
        phase: 'arguments',
        status: 'running',
      },
    ]);

    messages = applyEvent(
      messages,
      journal(
        {
          type: 'tool_args_delta',
          iteration: 1,
          callId: 'call-1',
          delta: '{"node":',
        },
        2,
      ),
    );
    messages = applyEvent(
      messages,
      journal(
        {
          type: 'tool_args_delta',
          iteration: 1,
          callId: 'call-1',
          delta: '"第一章"}',
        },
        3,
      ),
    );
    expect(messages[0]).toMatchObject({
      inputText: '{"node":"第一章"}',
      phase: 'arguments',
    });

    messages = applyEvent(
      messages,
      journal(
        {
          type: 'tool_call_ready',
          iteration: 1,
          callId: 'call-1',
          name: 'read_node',
          arguments: { node: '第一章' },
          rawArguments: '{"node":"第一章"}',
        },
        4,
      ),
    );
    expect(messages[0]).toEqual({
      kind: 'tool',
      id: 'call-1',
      name: 'read_node',
      input: { node: '第一章' },
      phase: 'ready',
      status: 'running',
    });

    messages = applyEvent(
      messages,
      journal(
        {
          type: 'tool_execution_started',
          callId: 'call-1',
          name: 'read_node',
          access: 'read',
        },
        5,
      ),
    );
    expect(messages[0]).toMatchObject({ phase: 'executing' });

    messages = applyEvent(
      messages,
      journal(
        {
          type: 'tool_result',
          callId: 'call-1',
          name: 'read_node',
          ok: true,
          content: '章节正文',
          source: 'executor',
        },
        6,
      ),
    );
    expect(messages[0]).toMatchObject({
      status: 'ok',
      result: '章节正文',
    });
  });

  it('settles the newest tool card when a later turn reuses a provider call id', () => {
    const initial: AgentChatMessage[] = [
      {
        kind: 'tool',
        id: 'call_0',
        name: 'list_nodes',
        input: {},
        status: 'ok',
        result: 'old result',
      },
      { kind: 'assistant', text: '上一轮完成', streaming: false },
      {
        kind: 'tool',
        id: 'call_0',
        name: 'read_node',
        input: { node: '第一章' },
        status: 'running',
      },
    ];

    expect(
      applyEvent(
        initial,
        journal({
          type: 'tool_result',
          callId: 'call_0',
          name: 'read_node',
          ok: true,
          content: 'new result',
          source: 'executor',
        }),
      ),
    ).toEqual([
      initial[0],
      initial[1],
      {
        ...initial[2],
        name: 'read_node',
        status: 'ok',
        result: 'new result',
      },
    ]);
  });

  it('surfaces a certified write review from the canonical tool result', () => {
    const initial: AgentChatMessage[] = [
      {
        kind: 'tool',
        id: 'write-1',
        name: 'edit_block',
        input: { node: '第一章' },
        status: 'running',
        phase: 'executing',
      },
    ];
    const content = JSON.stringify({
      result: { changed: true },
      effectId: 'effect-1',
      review: { id: 'review-1', status: 'pending' },
    });

    expect(
      applyEvent(
        initial,
        journal({
          type: 'tool_result',
          callId: 'write-1',
          name: 'edit_block',
          ok: true,
          content,
          source: 'executor',
        }),
      ),
    ).toEqual([
      {
        ...initial[0],
        name: 'edit_block',
        status: 'ok',
        result: content,
        review: {
          id: 'review-1',
          status: 'pending',
          provenance: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            callId: 'write-1',
            toolName: 'edit_block',
          },
        },
      },
    ]);
  });

  it('adds accepted steering and user input once from canonical events', () => {
    const steered = applyEvent(
      [{ kind: 'assistant', text: 'working', streaming: true }],
      journal({
        type: 'steering_received',
        messageId: 'steering-1',
        text: 'Keep the ending ambiguous.',
      }),
    );

    expect(steered).toEqual([
      { kind: 'assistant', text: 'working', streaming: false },
      { kind: 'user', text: 'Keep the ending ambiguous.' },
    ]);

    expect(
      applyEvent(
        steered,
        journal(
          {
            type: 'user_input_received',
            response: {
              requestId: 'question-1',
              sessionId: 'session-1',
              turnId: 'turn-1',
              callId: 'ask-1',
              text: 'Choose the quieter version.',
            },
          },
          2,
        ),
      ),
    ).toEqual([...steered, { kind: 'user', text: 'Choose the quieter version.' }]);
  });

  it('keeps permission state out of transcript and derives usage/error from turn_finished', () => {
    const initial: AgentChatMessage[] = [];
    const permissionOnly = applyEvent(
      initial,
      journal({
        type: 'permission_requested',
        request: {
          requestId: 'permission-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'call-1',
          toolName: 'write',
          access: 'write',
          arguments: {},
          argumentsHash: `sha256:${'a'.repeat(64)}`,
          revision: null,
          allowedScopes: ['once'],
        },
      }),
    );
    expect(permissionOnly).toBe(initial);

    const terminal = applyEvent(
      permissionOnly,
      journal(
        {
          type: 'turn_finished',
          outcome: 'failed',
          failureCode: 'MODEL_ERROR',
          message: 'provider failed',
          usage,
          modelIterations: 1,
          durationMs: 420,
        },
        2,
      ),
    );
    expect(terminal).toEqual([
      {
        kind: 'usage',
        inputTokens: 3,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheCreationTokens: 11,
        costUsd: 0.01,
        turns: 1,
        durationMs: 420,
        at: new Date(1_700_000_000_002).toISOString(),
      },
      { kind: 'error', text: 'provider failed' },
    ]);
  });

  it('offers an explicit one-shot continuation only after an idle budget terminal', () => {
    const state = {
      activeConvId: 'conversation-1',
      runningConvId: null,
      runs: {
        'conversation-1': {
          projectId: 'project-1',
          messages: [],
          runtimeSessionId: 'session-1',
          longTaskPlanState: continuationPlanState('none'),
          seenJournalEventIds: {},
          controlStatus: null,
          pendingControl: null,
          lastTerminal: {
            turnId: 'turn-1',
            outcome: 'budget_exceeded',
          },
        },
      },
    } as unknown as Parameters<typeof selectCanContinueAgentTask>[0];

    expect(selectCanContinueAgentTask(state)).toBe(true);
    expect(selectAgentTaskContinuationReason(state)).toBe('budget_exceeded');
    expect(
      selectCanContinueAgentTask({
        ...state,
        runningConvId: 'conversation-1',
      }),
    ).toBe(false);
    expect(
      selectCanContinueAgentTask({
        ...state,
        starting: true,
      }),
    ).toBe(false);
    expect(
      selectAgentTaskContinuationReason({
        ...state,
        runs: {
          ...state.runs,
          'conversation-1': {
            ...state.runs['conversation-1'],
            longTaskPlanState: continuationPlanState('completed'),
          },
        },
      }),
    ).toBeNull();
    expect(BUDGET_CONTINUATION_PROMPT).toContain('不要重复已完成的步骤');
    expect(BUDGET_CONTINUATION_PROMPT).toContain('从尚未完成的部分继续');
  });

  it('offers manual continuation after any terminal turn with an authoritative same-session open plan', () => {
    const state = {
      activeConvId: 'conversation-1',
      runningConvId: null,
      starting: false,
      runs: {
        'conversation-1': {
          projectId: 'project-1',
          messages: [],
          runtimeSessionId: 'session-1',
          longTaskPlanState: continuationPlanState('active'),
          seenJournalEventIds: {},
          controlStatus: null,
          pendingControl: null,
          lastTerminal: {
            turnId: 'turn-1',
            outcome: 'completed',
          },
        },
      },
    } as unknown as Parameters<typeof selectAgentTaskContinuationReason>[0];

    expect(selectAgentTaskContinuationReason(state)).toBe('active_plan');
    expect(selectCanContinueAgentTask(state)).toBe(true);
    expect(ACTIVE_PLAN_CONTINUATION_PROMPT).toContain('持久化任务计划');

    for (const outcome of ['aborted', 'failed'] as const) {
      expect(
        selectAgentTaskContinuationReason({
          ...state,
          runs: {
            ...state.runs,
            'conversation-1': {
              ...state.runs['conversation-1'],
              lastTerminal: { turnId: `turn-${outcome}`, outcome },
            },
          },
        }),
      ).toBe('active_plan');
    }

    expect(
      selectAgentTaskContinuationReason({
        ...state,
        runs: {
          ...state.runs,
          'conversation-1': {
            ...state.runs['conversation-1'],
            longTaskPlanState: continuationPlanState('active', 'different-session'),
          },
        },
      }),
    ).toBeNull();
    for (const status of ['paused', 'blocked', 'completed', 'failed'] as const) {
      expect(
        selectAgentTaskContinuationReason({
          ...state,
          runs: {
            ...state.runs,
            'conversation-1': {
              ...state.runs['conversation-1'],
              longTaskPlanState: continuationPlanState(status),
            },
          },
        }),
      ).toBeNull();
    }
  });

  it('keeps only the latest same-project conversation load intent current', () => {
    const guard = new AgentConversationLoadGuard();
    const first = guard.begin('project-1');
    const second = guard.begin('project-1');

    expect(guard.isCurrent(first, 'project-1')).toBe(false);
    expect(guard.isCurrent(second, 'project-1')).toBe(true);
    expect(guard.isCurrent(second, 'project-2')).toBe(false);

    guard.invalidate();
    expect(guard.isCurrent(second, 'project-1')).toBe(false);
  });

  it('does not let an awaited send preflight override New Chat or Load Conversation intent', async () => {
    const previous = useAgentChatStore.getState();
    const seedOrigin = (): void => {
      useAgentChatStore.setState(
        {
          ...previous,
          boundProjectId: 'project-intent',
          activeConvId: 'conversation-origin',
          runs: {
            'conversation-origin': {
              projectId: 'project-intent',
              messages: [],
              runtimeSessionId: 'session-origin',
              forkCheckpointId: null,
              seenJournalEventIds: {},
              controlStatus: null,
              pendingControl: null,
              lastTerminal: null,
              longTaskPlanState: null,
              contextUsage: null,
              automaticContinuation: createInactiveAgentAutomaticContinuation(),
            },
          },
          prompt: 'stale preflight prompt',
          convList: [],
          runningTurnId: null,
          runningConvId: null,
          starting: false,
        },
        true,
      );
    };

    try {
      seedOrigin();
      const sendBeforeNew = useAgentChatStore.getState().send();
      useAgentChatStore.getState().newConversation();
      await sendBeforeNew;
      expect(useAgentChatStore.getState()).toMatchObject({
        activeConvId: null,
        runningTurnId: null,
        runningConvId: null,
        starting: false,
      });
      expect(useAgentChatStore.getState().runs['conversation-origin']?.messages).toEqual([]);

      seedOrigin();
      const sendBeforeLoad = useAgentChatStore.getState().send();
      const load = useAgentChatStore
        .getState()
        .loadConversation('conversation-target')
        .catch(() => undefined);
      await Promise.all([sendBeforeLoad, load]);
      expect(useAgentChatStore.getState()).toMatchObject({
        runningTurnId: null,
        runningConvId: null,
        starting: false,
      });
      expect(useAgentChatStore.getState().runs['conversation-origin']?.messages).toEqual([]);
    } finally {
      useAgentChatStore.setState(previous, true);
    }
  });
});
