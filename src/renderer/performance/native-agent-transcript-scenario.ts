import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { useAgentChatStore } from '../store/agent-chat-store';
import { createAgentRuntimePersistenceRepository } from '../sqlite-repo/agent-runtime-persistence-repo';
import { createAgentConversationRepository } from '../sqlite-repo/agent-conversation-repo';
import { createRepositoryAgentTransportPersistence } from '../lib/agent/runtime/repository-transport-persistence';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../lib/agent/transport';
import { applyAgentChatJournalEntry } from '../lib/agent/runtime/chat-journal-projection';
import type { AgentChatMessage } from '../domain/agent-conversation';
import type { AgentRuntimeEvent, AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';

export function createNativeAgentTranscriptJournal(projectId: string, acceptedAt: string): AgentRuntimeJournalEntry[] {
  const turnId = 'native-transcript-turn';
  const usage = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const events: AgentRuntimeEvent[] = [
    { type: 'turn_started', prompt: 'Synthetic durable transcript request' },
    { type: 'model_iteration_started', iteration: 1, driverId: 'synthetic-provider' },
    ...['Native ', 'canonical ', 'tail.'].map(text => ({ type: 'text_delta' as const, iteration: 1, text })),
    { type: 'model_usage', iteration: 1, usage },
    { type: 'model_iteration_completed', iteration: 1, stopReason: 'end_turn' },
    { type: 'commit_started', outcome: 'completed' },
    { type: 'turn_finished', outcome: 'completed', usage, modelIterations: 1, durationMs: 10 },
  ];
  return events.map((event, index) => ({ schemaVersion: 1, sessionId: 'native-transcript-session', turnId,
    route: { kind: 'chat', projectId, conversationId: 'native-transcript-conversation' }, seq: index + 1,
    eventId: `${turnId}:${String(index + 1).padStart(8, '0')}`, wallTimeMs: Date.parse(acceptedAt) + index + 1, event }));
}

/** Native acceptance only: real SQLite journal/checkpoint, real store ingress,
 * real conversation persistence and recovery; no model or tool execution. */
export async function runNativeAgentTranscriptScenario(projectId: string, restart: boolean) {
  const conversationId = 'native-transcript-conversation'; const sessionId = 'native-transcript-session'; const turnId = 'native-transcript-turn';
  const prompt = 'Synthetic durable transcript request'; const text = 'Native canonical tail.';
  const before = useAgentChatStore.getState(); const repository = createAgentConversationRepository();
  const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  const restore = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
    listPendingControls: async () => ({ ok: true, value: [] }),
    subscribeJournal: listener => { listeners.add(listener); return { ok: true, value: () => { listeners.delete(listener); } }; },
  });
  const checks: Record<string, boolean> = {};
  const check = (name: string, passed: boolean) => { if (!passed) throw new Error(`Native transcript: ${name}`); checks[name] = true; };
  try {
    useAgentChatStore.setState({ boundProjectId: projectId, activeConvId: null, runs: {}, runningTurns: {}, starting: false, refreshList: () => undefined });
    useAgentChatStore.getState().bindProject(projectId);
    const entries: AgentRuntimeJournalEntry[] = [];
    if (!restart) {
      const now = new Date().toISOString();
      let expected: AgentChatMessage[] = [{ kind: 'user', text: prompt, at: now }];
      await repository.create({ id: conversationId, projectId, title: 'Synthetic native transcript', mode: 'byok', messages: expected, runtimeSessionId: sessionId, createdAt: now, updatedAt: now });
      const persistence = createRepositoryAgentTransportPersistence({ resolveToolAccess: () => undefined });
      const route = { kind: 'chat' as const, projectId, conversationId };
      await persistence.prepareTurn({ candidateSessionId: sessionId, newConversation: true, route, provider: 'synthetic-provider', model: 'synthetic-model', turnId, prompt, acceptedAt: now });
      const original = AgentChatTranscript.from(expected);
      useAgentChatStore.setState({ activeConvId: conversationId, runningTurns: { [conversationId]: turnId }, runs: { [conversationId]: { projectId, runtimeSessionId: sessionId, transcript: original,
        journalScope: createAgentChatJournalScope(), controlStatus: 'running', pendingControl: null, lastTerminal: null, longTaskPlanState: null, contextUsage: null,
        automaticContinuation: createInactiveAgentAutomaticContinuation() } } });
      for (const entry of createNativeAgentTranscriptJournal(projectId, now)) {
        entries.push(entry); expected = applyAgentChatJournalEntry(expected, entry); await persistence.appendJournal(entry);
        if (entry.event.type !== 'turn_finished') for (const listener of listeners) listener(entry);
        if (entry.event.type === 'text_delta' && entry.event.text === 'tail.') {
          const streaming = useAgentChatStore.getState().runs[conversationId].transcript.at(1);
          check('liveIndexedTextCurrent', streaming?.kind === 'assistant' && streaming.text === text && streaming.streaming === true);
        }
      }
      check('originalSnapshotUnchanged', original.length === 1 && original.at(0)?.kind === 'user');
      await persistence.commitTurn({ sessionId, turnId, turnMessages: [{ role: 'user', content: prompt }, { role: 'assistant', content: [{ type: 'text', text }] }], outcome: 'completed', errorCode: null, errorMessage: null, endedAt: new Date().toISOString() });
      for (const listener of listeners) listener(entries[entries.length - 1]);
      const terminal = useAgentChatStore.getState().runs[conversationId].transcript;
      for (const listener of listeners) listener(entries[entries.length - 1]);
      check('duplicateTerminalKeepsSnapshot', useAgentChatStore.getState().runs[conversationId].transcript === terminal);
      let saved = await repository.get(conversationId);
      for (let attempt = 0; attempt < 100 && JSON.stringify(saved?.messages) !== JSON.stringify(expected); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20)); saved = await repository.get(conversationId);
      }
      check('terminalArrayPersistedExactly', JSON.stringify(saved?.messages) === JSON.stringify(expected));
    }
    const stored = await repository.get(conversationId);
    check('storedArrayContentAndFormat', Array.isArray(stored?.messages) && stored.messages.length === 3 && stored.messages[0].kind === 'user' && stored.messages[0].text === prompt
      && stored.messages[1].kind === 'assistant' && stored.messages[1].text === text && stored.messages[1].streaming === false && stored.messages[2].kind === 'usage' && stored.messages[2].outputTokens === 4);
    useAgentChatStore.setState({ activeConvId: null, runs: {}, runningTurns: {} });
    await useAgentChatStore.getState().loadConversation(conversationId);
    const recovered = useAgentChatStore.getState().runs[conversationId];
    check('canonicalRecoveryEqualsStoredArray', recovered?.transcript instanceof AgentChatTranscript && JSON.stringify(recovered.transcript.toArray()) === JSON.stringify(stored?.messages));
    check('canonicalTerminalRecovered', recovered?.lastTerminal?.turnId === turnId && recovered.lastTerminal.outcome === 'completed');
    // loadConversation has validated this canonical recovery snapshot; replay
    // its real persisted entries in both processes rather than an empty trace.
    const durable = await createAgentRuntimePersistenceRepository().loadRecoverySnapshot(sessionId);
    const snapshot = useAgentChatStore.getState();
    for (const row of durable?.events ?? []) {
      const payload = row.payload as Pick<AgentRuntimeJournalEntry, 'route' | 'event'>;
      const entry: AgentRuntimeJournalEntry = { schemaVersion: 1, sessionId: row.sessionId, turnId: row.turnId, seq: row.seq, eventId: row.eventId, wallTimeMs: row.wallTimeMs, ...payload };
      for (const listener of listeners) listener(entry);
    }
    check('replayDoesNotChangeRecoveredSnapshot', durable?.events.length === 9 && useAgentChatStore.getState() === snapshot);
    return { restart, checks, messageCount: stored!.messages.length, boundary: 'Synthetic text-only turn through real native SQLite journal/checkpoint and conversation repository. No model or tool calls.' };
  } finally { useAgentChatStore.setState(before, true); restore(); }
}
