import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../domain/agent-conversation';
import { applyEvent } from './agent-chat-store';

describe('agent chat canonical control projection', () => {
  it('renders assistant deltas incrementally and finalizes the streaming tail on done', () => {
    const first = applyEvent([], {
      type: 'assistant_delta',
      text: '逐',
    });
    expect(first).toEqual([
      { kind: 'assistant', text: '逐', streaming: true },
    ]);

    const second = applyEvent(first, {
      type: 'assistant_delta',
      text: '字出现',
    });
    expect(second).toEqual([
      { kind: 'assistant', text: '逐字出现', streaming: true },
    ]);

    expect(applyEvent(second, { type: 'done' })).toEqual([
      { kind: 'assistant', text: '逐字出现', streaming: false },
    ]);
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
      applyEvent(initial, {
        type: 'tool_result',
        id: 'call_0',
        ok: true,
        text: 'new result',
      }),
    ).toEqual([
      initial[0],
      initial[1],
      {
        ...initial[2],
        status: 'ok',
        result: 'new result',
      },
    ]);
  });

  it('adds accepted steering exactly once from the canonical event', () => {
    const initial: AgentChatMessage[] = [
      { kind: 'assistant', text: 'working', streaming: true },
    ];

    const next = applyEvent(initial, {
      type: 'steering_received',
      messageId: 'steering-1',
      text: 'Keep the ending ambiguous.',
    });

    expect(next).toEqual([
      { kind: 'assistant', text: 'working', streaming: false },
      { kind: 'user', text: 'Keep the ending ambiguous.' },
    ]);
  });

  it('adds a user-input answer while keeping permission state out of the transcript', () => {
    const initial: AgentChatMessage[] = [];
    const permissionOnly = applyEvent(initial, {
      type: 'permission_request',
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
    });
    expect(permissionOnly).toBe(initial);

    expect(
      applyEvent(permissionOnly, {
        type: 'user_input_received',
        response: {
          requestId: 'question-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          callId: 'ask-1',
          text: 'Choose the quieter version.',
        },
      }),
    ).toEqual([
      { kind: 'user', text: 'Choose the quieter version.' },
    ]);
  });
});
