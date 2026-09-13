import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import type { AgentChatMessage } from '../domain/agent-conversation';
import { applyAgentChatJournalEntry, applyAgentChatTranscriptEntry } from '../lib/agent/runtime/chat-journal-projection';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { createAgentChatDisplayProjection } from '../features/agent/chat-display-projection';
import { useAgentChatStore } from '../store/agent-chat-store';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../lib/agent/transport';
import { AGENT_RUNTIME_SCHEMA_VERSION, type AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';
import { agentTranscriptWork, resetAgentTranscriptWork } from './agent-panel-counters';

export async function runAgentTranscriptScenarios() {
  const projectId = 'synthetic-transcript-project'; const conversationId = 'synthetic-transcript-conversation'; const sessionId = 'synthetic-transcript-session';
  const entries: AgentRuntimeJournalEntry[] = Array.from({ length: 6000 }, (_, index) => ({ schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION, sessionId, turnId: 'synthetic-turn',
    route: { kind: 'chat', projectId, conversationId }, seq: index + 1, eventId: `synthetic-transcript:${index}`, wallTimeMs: 1_700_000_000_000 + index, event: { type: 'text_delta', iteration: 1, text: '字' } }));
  const before = useAgentChatStore.getState(); const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  const restore = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport, subscribeJournal: listener => { listeners.add(listener); return { ok: true, value: () => { listeners.delete(listener); } }; } });
  const projections = []; const ingress = [];
  try {
    useAgentChatStore.setState({ boundProjectId: projectId, refreshList: () => undefined }); useAgentChatStore.getState().bindProject(projectId);
    if (listeners.size !== 1) throw new Error('Expected one canonical journal consumer');
    for (const historyMessages of [300, 3000, 30_000]) {
      const history: AgentChatMessage[] = Array.from({ length: historyMessages }, (_, index) => ({ kind: 'assistant', text: `Synthetic history ${index}`, streaming: false }));
      const initial: AgentChatMessage[] = [...history, { kind: 'assistant', text: '', streaming: true }];
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ initial, entries })));
      const fixtureHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const complete = (messages: AgentChatMessage[]) => messages.length === initial.length && history.every((message, index) => messages[index] === message)
        && messages[historyMessages].kind === 'assistant' && messages[historyMessages].text === '字'.repeat(entries.length);
      for (const implementation of ['array-reference', 'persistent-tree'] as const) {
        const samplesMs = []; const work = [];
        for (let repetition = 0; repetition < 3; repetition++) {
          let array = initial; let transcript = AgentChatTranscript.from(initial); resetAgentTranscriptWork();
          const start = performance.now();
          if (implementation === 'array-reference') for (const entry of entries) array = applyAgentChatJournalEntry(array, entry);
          else for (const entry of entries) transcript = applyAgentChatTranscriptEntry(transcript, entry);
          samplesMs.push(performance.now() - start); work.push({ ...agentTranscriptWork });
          if (!complete(implementation === 'array-reference' ? array : transcript.toArray())) throw new Error('Projection lost history or text');
        }
        projections.push({ implementation, historyMessages, fixtureHash, eventCount: entries.length, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[1], work });
      }
      const original = AgentChatTranscript.from(initial);
      useAgentChatStore.setState({ activeConvId: conversationId, starting: false, runningTurns: { [conversationId]: 'synthetic-turn' }, runs: { [conversationId]: {
        projectId, runtimeSessionId: sessionId, transcript: original, journalScope: createAgentChatJournalScope(), controlStatus: 'running', pendingControl: null,
        lastTerminal: null, longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation(),
      } } });
      const frames = new Map<number, () => void>(); let notifications = 0;
      const display = createAgentChatDisplayProjection(useAgentChatStore, { requestFrame: callback => { frames.set(1, callback); return 1; }, cancelFrame: id => { frames.delete(id); },
        setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: id => clearTimeout(id), isHidden: () => false, subscribeVisibility: () => () => undefined });
      const release = display.subscribe(() => { notifications++; }); const oldDisplay = display.getSnapshot();
      try {
        resetAgentTranscriptWork(); const start = performance.now();
        for (const entry of entries) for (const listener of listeners) listener(entry);
        const elapsedMs = performance.now() - start; const eventWork = { ...agentTranscriptWork };
        const current = useAgentChatStore.getState().runs[conversationId].transcript;
        const immediateRead = current.at(historyMessages);
        const beforeFrame = notifications;
        for (const entry of entries) for (const listener of listeners) listener(entry);
        const duplicateWork = Object.fromEntries(Object.entries(agentTranscriptWork).map(([key, value]) => [key, value - eventWork[key as keyof typeof eventWork]]));
        for (const callback of [...frames.values()]) callback();
        const checks = {
          canonicalCurrentBeforeFrame: immediateRead?.kind === 'assistant' && immediateRead.text === '字'.repeat(entries.length),
          originalSnapshotUnchanged: original.at(historyMessages)?.kind === 'assistant' && (original.at(historyMessages) as { text: string }).text === '' && oldDisplay === original.toArray(),
          completeDisplay: complete(display.getSnapshot()) && display.getSnapshot() === current.toArray(),
          duplicatesPreserveSnapshot: useAgentChatStore.getState().runs[conversationId].transcript === current,
        };
        if (Object.values(checks).some(value => !value)) throw new Error('Canonical transcript/display mismatch');
        ingress.push({ historyMessages, fixtureHash, eventCount: entries.length, elapsedMs, eventWork, duplicateWork, beforeFrame, afterFrame: notifications,
          frameWork: { flatMaterializations: agentTranscriptWork.flatMaterializations - eventWork.flatMaterializations, flattenedMessages: agentTranscriptWork.flattenedMessages - eventWork.flattenedMessages }, checks });
      } finally { release(); }
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    return { projections, ingress, boundary: 'Synthetic canonical text traces. Array and tree use the same event fold; real store/dedup/display tested separately. No model, SQLite or native input; timing includes allocation counters.' };
  } finally { useAgentChatStore.setState(before, true); restore(); }
}
