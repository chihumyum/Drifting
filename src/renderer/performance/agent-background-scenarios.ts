import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import type { AgentChatMessage } from '../domain/agent-conversation';
import { createAgentChatDisplayProjection } from '../features/agent/chat-display-projection';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../lib/agent/transport';
import { useAgentChatStore } from '../store/agent-chat-store';
import type { AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';
import { agentTranscriptWork, resetAgentTranscriptWork } from './agent-panel-counters';

/** Browser execution with deterministic visibility/timer ports. The window is
 * not actually backgrounded; OS timer throttling is deliberately not measured. */
export async function runAgentBackgroundScenarios() {
  const projectId = 'synthetic-background-project'; const conversationId = 'synthetic-background-conversation';
  const sessionId = 'synthetic-background-session'; const turnId = 'synthetic-background-turn';
  const entries: AgentRuntimeJournalEntry[] = Array.from({ length: 6000 }, (_, index) => ({ schemaVersion: 1,
    sessionId, turnId, route: { kind: 'chat', projectId, conversationId }, seq: index + 1,
    eventId: `synthetic-background:${index}`, wallTimeMs: 1_700_000_000_000 + index,
    event: { type: 'text_delta', iteration: 1, text: '字' } }));
  const before = useAgentChatStore.getState(); const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  const restore = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
    subscribeJournal: listener => { listeners.add(listener); return { ok: true, value: () => { listeners.delete(listener); } }; } });
  const measurements = [];
  try {
    useAgentChatStore.setState({ boundProjectId: projectId, refreshList: () => undefined });
    useAgentChatStore.getState().bindProject(projectId);
    if (listeners.size !== 1) throw new Error('Expected one canonical background journal subscriber.');
    for (const historyMessages of [300, 3000, 30_000]) {
      const initial: AgentChatMessage[] = [...Array.from({ length: historyMessages }, (_, index) => ({
        kind: 'assistant' as const, text: `Synthetic background history ${index}`, streaming: false,
      })), { kind: 'assistant', text: '', streaming: true }];
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ initial, entries })));
      const fixtureHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
      const original = AgentChatTranscript.from(initial);
      useAgentChatStore.setState({ activeConvId: conversationId, starting: false, runningTurns: { [conversationId]: turnId },
        runs: { [conversationId]: { projectId, runtimeSessionId: sessionId, transcript: original,
          journalScope: createAgentChatJournalScope(), controlStatus: 'running', pendingControl: null, lastTerminal: null,
          longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() } } });
      const frames = new Map<number, () => void>(); const timers = new Map<number, () => void>();
      const visibility = new Set<() => void>(); let nextId = 0; let hidden = true; let notifications = 0;
      const timerDelays: number[] = [];
      const display = createAgentChatDisplayProjection(useAgentChatStore, {
        requestFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
        cancelFrame: id => { frames.delete(id); },
        setTimer: (callback, ms) => { const id = ++nextId; timerDelays.push(ms); timers.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: id => { timers.delete(id as unknown as number); }, isHidden: () => hidden,
        subscribeVisibility: callback => { visibility.add(callback); return () => { visibility.delete(callback); }; },
      });
      const release = display.subscribe(() => { notifications++; }); const initialDisplay = display.getSnapshot();
      try {
        resetAgentTranscriptWork(); const started = performance.now();
        for (const entry of entries) for (const listener of listeners) listener(entry);
        const elapsedMs = performance.now() - started;
        const ingressWork = { ...agentTranscriptWork }; const beforeTimer = notifications;
        const scheduled = { frames: frames.size, timers: timers.size, timerDelays: [...timerDelays] };
        const current = useAgentChatStore.getState().runs[conversationId].transcript;
        const tail = current.at(historyMessages);
        for (const entry of entries) for (const listener of listeners) listener(entry);
        const duplicateWork = Object.fromEntries(Object.entries(agentTranscriptWork).map(([key, value]) => [key, value - ingressWork[key as keyof typeof ingressWork]]));
        for (const callback of [...timers.values()]) callback();
        const afterTimer = notifications;
        const timerWork = { flatMaterializations: agentTranscriptWork.flatMaterializations - ingressWork.flatMaterializations,
          flattenedMessages: agentTranscriptWork.flattenedMessages - ingressWork.flattenedMessages };
        const complete = display.getSnapshot();
        const checks = {
          canonicalCurrentBeforeTimer: tail?.kind === 'assistant' && tail.text === '字'.repeat(entries.length),
          completeDisplay: complete.length === initial.length && complete[historyMessages].kind === 'assistant' && complete[historyMessages].text === '字'.repeat(entries.length)
            && initial.slice(0, historyMessages).every((message, index) => complete[index] === message),
          duplicatesPreserveSnapshot: useAgentChatStore.getState().runs[conversationId].transcript === current,
          originalSnapshotUnchanged: initialDisplay === original.toArray() && initialDisplay[historyMessages].kind === 'assistant' && initialDisplay[historyMessages].text === '',
          foregroundFlushesTail: false, disposedResources: false,
        };
        const returnEntry: AgentRuntimeJournalEntry = { ...entries[0], eventId: 'synthetic-background:return', seq: 6001,
          event: { type: 'text_delta', iteration: 1, text: ' returned' } };
        for (const listener of listeners) listener(returnEntry);
        hidden = false; for (const callback of visibility) callback();
        const returned = display.getSnapshot()[historyMessages];
        checks.foregroundFlushesTail = returned.kind === 'assistant' && returned.text === `${'字'.repeat(entries.length)} returned` && !frames.size && !timers.size;
        release(); checks.disposedResources = !frames.size && !timers.size && !visibility.size;
        if (Object.values(checks).some(value => !value)) throw new Error('Background transcript/display mismatch.');
        measurements.push({ historyMessages, fixtureHash, eventCount: entries.length, elapsedMs, ingressWork, duplicateWork,
          scheduled, beforeTimer, afterTimer, timerWork, checks });
      } finally { release(); }
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    return { measurements, boundary: 'Real store, journal consumer and display projection in Chromium; synthetic text and controlled hidden/timer ports. No OS background timer latency, SQLite, model or native input.' };
  } finally { useAgentChatStore.setState(before, true); restore(); }
}
