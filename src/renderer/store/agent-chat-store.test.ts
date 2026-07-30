import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../domain/agent-conversation';
import { applyEvent } from './agent-chat-store';

describe('agent chat canonical control projection', () => {
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
