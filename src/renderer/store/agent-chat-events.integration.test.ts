import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentChatStore, applyEvent } from './agent-chat-store';
import { useSettingsStore } from './settings-store';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../lib/agent/transport';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { AGENT_RUNTIME_SCHEMA_VERSION, type AgentRuntimeEvent, type AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';
import { createAgentChatDisplayProjection } from '../features/agent/chat-display-projection';

const persistence = vi.hoisted(() => ({
  update: vi.fn(async () => undefined), get: vi.fn(), projection: vi.fn(),
  softDelete: vi.fn(async () => undefined), softDeleteAllByProject: vi.fn(async () => undefined),
}));
vi.mock('../sqlite-repo/agent-conversation-repo', () => ({ createAgentConversationRepository: () => persistence }));
vi.mock('../sqlite-repo/agent-runtime-long-task-repo', () => ({ createAgentRuntimeLongTaskRepository: () => ({ getLatestPlan: async () => null }) }));
vi.mock('../lib/agent/runtime/recovered-transcript', () => ({ loadCanonicalAgentChatProjection: persistence.projection, findCanonicalAgentChatSessionId: async () => null }));

const initial = useAgentChatStore.getState();
const initialSettings = useSettingsStore.getState();
const projectId = 'synthetic-project';
const conversationId = 'synthetic-conversation';
const sessionId = 'synthetic-session';
const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
let restoreTransport: () => void;
function run() {
  return { projectId, transcript: AgentChatTranscript.from([]), runtimeSessionId: sessionId, journalScope: createAgentChatJournalScope(),
    controlStatus: null, pendingControl: null, lastTerminal: null, longTaskPlanState: null, contextUsage: null,
    automaticContinuation: createInactiveAgentAutomaticContinuation() };
}
function entry(event: AgentRuntimeEvent, id: string, convId = conversationId): AgentRuntimeJournalEntry {
  return { schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION, sessionId, turnId: 'synthetic-turn',
    route: { kind: 'chat', projectId, conversationId: convId }, seq: 1, eventId: id, wallTimeMs: 1_700_000_000_000, event };
}
function emit(value: AgentRuntimeJournalEntry) { for (const listener of listeners) listener(value); }
function transport(target: typeof listeners) {
  return { ...unsupportedGeneralAgentTransport,
    listPendingControls: async () => ({ ok: true as const, value: [] }),
    subscribeJournal: (listener: (entry: AgentRuntimeJournalEntry) => void) => {
      target.add(listener);
      return { ok: true as const, value: () => { target.delete(listener); } };
    },
  };
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

beforeEach(() => {
  vi.clearAllMocks();
  restoreTransport = installGeneralAgentTransport(transport(listeners));
  useAgentChatStore.setState({ ...initial, boundProjectId: projectId, activeConvId: conversationId,
    refreshList: () => undefined, runs: { [conversationId]: run() } }, true);
  useAgentChatStore.getState().bindProject(projectId);
  expect(listeners.size).toBe(1);
});
afterEach(async () => {
  await settle();
  restoreTransport();
  expect(listeners.size).toBe(0);
  useAgentChatStore.setState(initial, true);
  useSettingsStore.setState(initialSettings, true);
});

describe('chat journal ingress and private deduplication', () => {
  it('rejects a foreign project route before changing the conversation or persistence', () => {
    const before = useAgentChatStore.getState();
    const value = entry({ type: 'text_delta', iteration: 1, text: 'Foreign output' }, 'foreign-route');
    emit({ ...value, route: { kind: 'chat', projectId: 'another-project', conversationId } });
    expect(useAgentChatStore.getState()).toBe(before);
    expect(persistence.update).not.toHaveBeenCalled();
    // A rejected delivery must not claim the event identity in the real owner.
    emit(value);
    expect(useAgentChatStore.getState().runs[conversationId].transcript.toArray()).toEqual([{ kind: 'assistant', text: 'Foreign output', streaming: true }]);
  });

  it('flushes the actual terminal tail before its finalized transcript is persisted', async () => {
    const frames = new Map<number, () => void>();
    const display = createAgentChatDisplayProjection(useAgentChatStore, {
      requestFrame: (callback) => { frames.set(1, callback); return 1; },
      cancelFrame: (id) => { frames.delete(id); },
      setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: clearTimeout,
      isHidden: () => false, subscribeVisibility: () => () => undefined,
    });
    const release = display.subscribe(() => undefined);
    try {
      emit(entry({ type: 'text_delta', iteration: 1, text: '末尾输出' }, 'pending-tail'));
      expect(display.getSnapshot()).toEqual([]);
      emit(entry({ type: 'turn_finished', outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, modelIterations: 1, durationMs: 100 }, 'terminal-tail'));
      const messages = useAgentChatStore.getState().runs[conversationId].transcript.toArray();
      expect(display.getSnapshot()).toBe(messages);
      expect(messages[0]).toEqual({ kind: 'assistant', text: '末尾输出', streaming: false });
      expect(frames.size).toBe(0);
      expect(persistence.update).toHaveBeenCalledWith(conversationId, expect.objectContaining({ messages }));
      await settle();
    } finally { release(); }
  });

  it('matches the reference projection with transient thinking, tools and a duplicated terminal', async () => {
    const trace: AgentRuntimeJournalEntry[] = [
      { ...entry({ type: 'thinking_delta', iteration: 1, text: '思' }, 'transient:1'), transient: true },
      { ...entry({ type: 'thinking_delta', iteration: 1, text: '考' }, 'transient:2'), transient: true },
      entry({ type: 'thinking_delta', iteration: 1, text: '思考', consolidated: true }, 'durable:1'),
      entry({ type: 'tool_call_started', iteration: 1, callId: 'read', name: 'read_node' }, 'durable:2'),
      entry({ type: 'tool_args_delta', iteration: 1, callId: 'read', delta: '{}' }, 'durable:3'),
      entry({ type: 'tool_call_ready', iteration: 1, callId: 'read', name: 'read_node', arguments: {}, rawArguments: '{}' }, 'durable:4'),
      entry({ type: 'tool_result', callId: 'read', name: 'read_node', ok: true, content: '合成正文', source: 'executor' }, 'durable:5'),
      entry({ type: 'text_delta', iteration: 1, text: '完成' }, 'durable:6'),
      entry({ type: 'turn_finished', outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, modelIterations: 1, durationMs: 100 }, 'durable:7'),
    ];
    let reference: ReturnType<typeof applyEvent> = [];
    for (const value of trace) { reference = applyEvent(reference, value); emit(value); emit(value); }
    await settle();
    const beforeReplay = useAgentChatStore.getState();
    for (const value of trace) emit(value);
    expect(useAgentChatStore.getState()).toBe(beforeReplay);
    expect(beforeReplay.runs[conversationId].transcript.toArray()).toEqual(reference);
    expect(persistence.update).toHaveBeenCalledTimes(1);
    expect(persistence.update).toHaveBeenCalledWith(conversationId, expect.objectContaining({ messages: reference, runtimeSessionId: sessionId }));
  });

  it('publishes permission and cancellation immediately without accepting duplicate controls', () => {
    const permission = entry({ type: 'permission_requested', request: {
      requestId: 'permission', sessionId, turnId: 'synthetic-turn', callId: 'write', toolName: 'write_node',
      access: 'write', arguments: {}, argumentsHash: `sha256:${'a'.repeat(64)}`, revision: null, allowedScopes: ['once'],
    } }, 'permission');
    emit(permission);
    const waiting = useAgentChatStore.getState();
    expect(waiting.runs[conversationId].controlStatus).toBe('waiting_permission');
    emit(permission);
    expect(useAgentChatStore.getState()).toBe(waiting);
    emit(entry({ type: 'cancellation_requested', reason: 'author' }, 'cancel'));
    expect(useAgentChatStore.getState().runs[conversationId].controlStatus).toBe('cancelling');
  });

  it('preserves membership across transport rebinding and isolates sibling conversations', () => {
    const value = entry({ type: 'text_delta', iteration: 1, text: '一次' }, 'shared-event-id');
    emit(value);
    const otherListeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
    const restore = installGeneralAgentTransport(transport(otherListeners));
    try {
      expect(listeners.size).toBe(0);
      expect(otherListeners.size).toBe(1);
      const before = useAgentChatStore.getState();
      for (const listener of otherListeners) listener(value);
      expect(useAgentChatStore.getState()).toBe(before);
      useAgentChatStore.setState({ runs: { ...before.runs, sibling: run() } });
      for (const listener of otherListeners) listener({ ...value, route: { kind: 'chat', projectId, conversationId: 'sibling' } });
      expect(useAgentChatStore.getState().runs.sibling.transcript.toArray()).toEqual(before.runs[conversationId].transcript.toArray());
    } finally { restore(); }
  });

  it('seeds a fresh recovery generation and drops deleted conversation routing', async () => {
    const first = entry({ type: 'text_delta', iteration: 1, text: '已恢复' }, 'recovered-event');
    emit(first);
    const oldScope = useAgentChatStore.getState().runs[conversationId].journalScope;
    const messages = useAgentChatStore.getState().runs[conversationId].transcript.toArray();
    await useAgentChatStore.getState().deleteConversation(conversationId);
    expect(useAgentChatStore.getState().runs[conversationId]).toBeUndefined();
    const deleted = useAgentChatStore.getState();
    emit(first);
    expect(useAgentChatStore.getState()).toBe(deleted);
    persistence.get.mockResolvedValue({ id: conversationId, projectId, runtimeSessionId: sessionId, messages: [] });
    persistence.projection.mockResolvedValue({ messages, eventIds: [first.eventId], lastTerminal: null, latestContextUsage: null });
    await useAgentChatStore.getState().loadConversation(conversationId);
    const recovered = useAgentChatStore.getState();
    expect(recovered.runs[conversationId].journalScope).not.toBe(oldScope);
    emit(first);
    expect(useAgentChatStore.getState()).toBe(recovered);
    emit(entry({ type: 'text_delta', iteration: 1, text: '新尾部' }, 'new-tail'));
    expect(useAgentChatStore.getState().runs[conversationId].transcript.toArray()).toEqual([{ kind: 'assistant', text: '已恢复新尾部', streaming: true }]);
  });

  it('does not remember an event when its projection fails', () => {
    const current = useAgentChatStore.getState().runs[conversationId];
    useAgentChatStore.setState({ runs: { [conversationId]: { ...current, transcript: null as unknown as typeof current.transcript } } });
    const value = entry({ type: 'text_delta', iteration: 1, text: '重试' }, 'retry');
    expect(() => emit(value)).toThrow();
    useAgentChatStore.setState({ runs: { [conversationId]: current } });
    emit(value);
    expect(useAgentChatStore.getState().runs[conversationId].transcript.toArray()).toEqual([{ kind: 'assistant', text: '重试', streaming: true }]);
  });
});
