import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { useAgentChatStore } from '../store/agent-chat-store';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../lib/agent/transport';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { AGENT_RUNTIME_SCHEMA_VERSION, type AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';

/** Actual chat-store journal consumer, isolated from SQLite and model execution. */
export async function runAgentEventScenarios() {
  const previous = useAgentChatStore.getState();
  const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  const restoreTransport = installGeneralAgentTransport({
    ...unsupportedGeneralAgentTransport,
    subscribeJournal: (listener) => {
      listeners.add(listener);
      return { ok: true, value: () => { listeners.delete(listener); } };
    },
  });
  const projectId = 'synthetic-event-project';
  const conversationId = 'synthetic-event-conversation';
  const sessionId = 'synthetic-event-session';
  const scenarios = [];
  try {
    // The session is already bound, so this only installs the real listener.
    // refreshList is replaced within this disposable fixture to avoid SQLite.
    useAgentChatStore.setState({ boundProjectId: projectId, refreshList: () => undefined });
    useAgentChatStore.getState().bindProject(projectId);
    if (listeners.size !== 1) throw new Error('Expected one chat journal consumer');
    for (const eventCount of [1_000, 3_000, 6_000]) {
      const entries: AgentRuntimeJournalEntry[] = Array.from({ length: eventCount }, (_, index) => ({
        schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION, sessionId, turnId: 'synthetic-event-turn',
        route: { kind: 'chat', projectId, conversationId },
        seq: index + 1, eventId: `synthetic-event:${index + 1}`, wallTimeMs: 1_700_000_000_000 + index,
        event: { type: 'text_delta', iteration: 1, text: '字' },
      }));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(entries)));
      const fixtureHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const samples = [];
      let notifications = 0;
      let duplicateNotifications = 0;
      for (let repetition = 0; repetition < 3; repetition++) {
        useAgentChatStore.setState({ activeConvId: conversationId, runningTurns: {}, runs: {
          [conversationId]: {
            projectId, runtimeSessionId: sessionId, messages: [], journalScope: createAgentChatJournalScope(),
            controlStatus: null, pendingControl: null, lastTerminal: null, longTaskPlanState: null,
            contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation(),
          },
        } });
        let commits = 0;
        const unsubscribe = useAgentChatStore.subscribe(() => { commits++; });
        const emit = (entry: AgentRuntimeJournalEntry) => { for (const listener of listeners) listener(entry); };
        try {
          const start = performance.now();
          for (const entry of entries) emit(entry);
          samples.push(performance.now() - start);
          notifications = commits;
          for (const entry of entries) emit(entry);
          duplicateNotifications = commits - notifications;
          const messages = useAgentChatStore.getState().runs[conversationId].messages;
          if (messages.length !== 1 || messages[0].kind !== 'assistant' || messages[0].text !== '字'.repeat(eventCount)) {
            throw new Error('Agent event fixture lost or duplicated text');
          }
          if (notifications !== eventCount || duplicateNotifications !== 0) throw new Error('Agent event notification mismatch');
        } finally { unsubscribe(); }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const sorted = [...samples].sort((a, b) => a - b);
      scenarios.push({ eventCount, fixtureHash, samplesMs: samples, medianMs: sorted[1], notifications, duplicateNotifications, finalCharacters: eventCount });
    }
    return { implementation: 'private-membership-index', repetitions: 3, scenarios,
      boundary: 'Real chat-store consumer; synthetic text events only; no React view, model, SQLite, terminal persistence or native UI.' };
  } finally {
    useAgentChatStore.setState(previous, true);
    restoreTransport();
  }
}
