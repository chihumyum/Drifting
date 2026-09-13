import type { GeneralAgentTransport } from '../transport';
import type { AgentRuntimeJournalEntry } from './types';
import { hasAgentChatJournalEvent, rememberAgentChatJournalEvent } from './chat-journal-dedup';
import { markAgentChatMessagePublication } from './chat-message-publication';
import { projectAgentChatRunEvent, type AgentChatRunState } from './chat-run-projection';

type Scope = { sessionId: string; turnId: string };
type ConversationChange = { projectId: string; conversationIds: string[] };
export interface AgentChatJournalPorts {
  read(): { boundProjectId: string | null; runs: Record<string, AgentChatRunState>; runningTurns: Record<string, string> };
  /** Synchronous compare/project/publish boundary, called once per delivery. */
  updateRun(conversationId: string, project: (run: AgentChatRunState) => AgentChatRunState): void;
  persistConversation(conversationId: string): void;
  refreshPlan(conversationId: string, projectId: string, sessionId: string, turnId: string): void;
  finishTurn(conversationId: string, turnId: string): void;
  activity(): {
    onToolUse(scope: Scope, id: string, name: string, input: unknown): void;
    onToolResult(scope: Scope, id: string, ok: boolean, text: string): void;
    onTurnEnd(scope: Scope): void;
  };
  subscribeJournal: GeneralAgentTransport['subscribeJournal'];
  subscribeChanges(callback: (change: ConversationChange) => void): () => void;
  conversationsChanged(change: ConversationChange): void;
}

/** App-owned ingress. Panels may request connection repeatedly but never own
 * its lifetime. A disposed owner rejects queued callbacks and releases routes. */
export function createAgentChatJournalConsumer(ports: AgentChatJournalPorts) {
  const turnConversations = new Map<string, string>();
  let journalCleanup: (() => void) | undefined;
  let changesCleanup: (() => void) | undefined;
  let generation = 0;
  let disposed = false;
  let connecting = false;

  function handle(entry: AgentRuntimeJournalEntry): void {
    if (entry.route.kind !== 'chat') return;
    const { turnId, event: ev } = entry;
    const mapped = turnConversations.get(turnId);
    if (mapped && entry.route.conversationId && mapped !== entry.route.conversationId) return;
    const conversationId = mapped ?? entry.route.conversationId;
    if (!conversationId) return;
    const before = ports.read().runs[conversationId];
    if (!before || before.projectId !== entry.route.projectId || hasAgentChatJournalEvent(before.journalScope, entry.eventId)) return;
    const sessionBindingChanged = before.runtimeSessionId !== entry.sessionId;
    let accepted = false;
    ports.updateRun(conversationId, run => {
      if (run.projectId !== entry.route.projectId || hasAgentChatJournalEvent(run.journalScope, entry.eventId)) return run;
      const projected = projectAgentChatRunEvent(run, entry);
      markAgentChatMessagePublication(projected.transcript, ev.type);
      rememberAgentChatJournalEvent(run.journalScope, entry.eventId);
      accepted = true;
      return projected;
    });
    // A delivery accepted before disposal finishes its terminal/persistence
    // effects. Disposal invalidates future callbacks, not already accepted data.
    if (!accepted) return;

    const state = ports.read(); const run = state.runs[conversationId];
    // Capture the canonical binding at first delivery, including a partial turn.
    if (sessionBindingChanged) ports.persistConversation(conversationId);
    if (run && run.projectId === state.boundProjectId && state.runningTurns[conversationId] === turnId) {
      const activity = ports.activity(); const scope = { sessionId: entry.sessionId, turnId };
      if (ev.type === 'tool_call_ready') activity.onToolUse(scope, ev.callId, ev.name, ev.arguments);
      else if (ev.type === 'tool_result') activity.onToolResult(scope, ev.callId, ev.ok, ev.content);
    }
    if (ev.type === 'turn_finished') {
      if (run) ports.refreshPlan(conversationId, run.projectId, entry.sessionId, turnId);
      turnConversations.delete(turnId);
      ports.activity().onTurnEnd({ sessionId: entry.sessionId, turnId });
      ports.finishTurn(conversationId, turnId);
      ports.persistConversation(conversationId);
    }
  }

  return {
    registerTurn(turnId: string, conversationId: string) { if (!disposed) turnConversations.set(turnId, conversationId); },
    releaseTurn(turnId: string) { turnConversations.delete(turnId); },
    isDisposed: () => disposed,
    ensureConnected(): boolean {
      if (disposed) return false;
      if (journalCleanup) return true;
      if (connecting) return false;
      connecting = true;
      const current = ++generation;
      try {
        const subscription = ports.subscribeJournal(entry => { if (!disposed && generation === current) handle(entry); });
        if (!subscription.ok) { generation++; return false; }
        if (disposed) { subscription.value(); return false; }
        journalCleanup = subscription.value;
        const cleanup = ports.subscribeChanges(change => { if (!disposed && generation === current) ports.conversationsChanged(change); });
        if (disposed) { cleanup(); return false; }
        changesCleanup = cleanup;
        return true;
      } catch (error) {
        generation++; const cleanup = journalCleanup; journalCleanup = undefined; cleanup?.(); throw error;
      } finally { connecting = false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; turnConversations.clear();
      const journal = journalCleanup; const changes = changesCleanup;
      journalCleanup = undefined; changesCleanup = undefined;
      try { journal?.(); } finally { changes?.(); }
    },
  };
}
