import type { AgentChatMessage } from '../domain/agent-conversation';
import type { AgentRuntimeRecoverySnapshot } from '../domain/agent-runtime-persistence';
import type { AgentRuntimeEvent } from '../lib/agent/runtime/types';

/** Entirely synthetic multi-turn history, including failed same-text preflight
 * attempts. Expected display is built from the fixture specification, not a fold. */
export function createAgentRecoveryFixture(turnCount: number) {
  const now = '2026-01-01T00:00:00.000Z'; const sessionId = 'synthetic-recovery-session';
  const route = { kind: 'chat' as const, projectId: 'synthetic-recovery-project', conversationId: 'synthetic-recovery-conversation' };
  const usage = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const snapshot: AgentRuntimeRecoverySnapshot = {
    session: { id: sessionId, projectId: route.projectId, routeKind: 'chat', conversationId: route.conversationId, goalRunId: null, chapterId: null,
      provider: 'synthetic-provider', model: null, providerEpoch: 0, status: 'idle', createdAt: now, updatedAt: now, endedAt: null },
    turns: [], messages: [], events: [], toolCalls: [], checkpoints: [],
  };
  const visibleCache: AgentChatMessage[] = []; const expected: AgentChatMessage[] = [];
  for (let index = 0; index < turnCount; index++) {
    const turnId = `synthetic-recovery-turn-${index}`; const promptId = `${turnId}-prompt`; const visible = `Synthetic prompt ${index}`;
    const prompt = `Synthetic hidden context\n\n${visible}`; const text = '字'.repeat(20);
    if (index % 50 === 0) {
      const failed: AgentChatMessage[] = [{ kind: 'user', text: visible, at: now }, { kind: 'error', text: 'Synthetic preflight failure' }];
      visibleCache.push(...failed); expected.push(...failed);
    }
    visibleCache.push({ kind: 'user', text: visible, at: now }, { kind: 'assistant', text: 'Stale cache must not become canonical' });
    snapshot.turns.push({ id: turnId, sessionId, ordinal: index, status: 'completed', promptMessageId: promptId,
      acceptedAt: now, startedAt: now, endedAt: now, updatedAt: now, errorCode: null, errorMessage: null });
    snapshot.messages.push({ id: promptId, sessionId, turnId, ordinal: index * 2, role: 'user', status: 'complete', content: prompt, createdAt: now, completedAt: now },
      { id: `${turnId}-answer`, sessionId, turnId, ordinal: index * 2 + 1, role: 'assistant', status: 'complete', content: [{ type: 'text', text }], createdAt: now, completedAt: now });
    const events: AgentRuntimeEvent[] = [
      { type: 'turn_started', prompt }, { type: 'model_iteration_started', iteration: 1, driverId: 'synthetic-provider' },
      { type: 'thinking_delta', iteration: 1, text: 'Synthetic reasoning', consolidated: true },
      ...Array.from({ length: 20 }, () => ({ type: 'text_delta' as const, iteration: 1, text: '字' })),
      { type: 'model_usage', iteration: 1, usage }, { type: 'model_iteration_completed', iteration: 1, stopReason: 'end_turn' },
      { type: 'commit_started', outcome: 'completed' }, { type: 'turn_finished', outcome: 'completed', usage, modelIterations: 1, durationMs: 10 },
    ];
    for (const [eventIndex, event] of events.entries()) snapshot.events.push({ eventId: `${turnId}:${String(eventIndex + 1).padStart(8, '0')}`, sessionId, turnId,
      seq: eventIndex + 1, schemaVersion: 1, eventType: event.type, payload: { route, event }, wallTimeMs: Date.parse(now) + index * 100 + eventIndex, createdAt: now });
    expected.push({ kind: 'user', text: visible, at: now }, { kind: 'thinking', text: 'Synthetic reasoning', streaming: false }, { kind: 'assistant', text, streaming: false },
      { kind: 'usage', inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, turns: 1, durationMs: 10,
        at: new Date(Date.parse(now) + index * 100 + events.length - 1).toISOString() });
  }
  return { snapshot, visibleCache, expected };
}
