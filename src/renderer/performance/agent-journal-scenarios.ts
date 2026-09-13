import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { createAgentChatJournalConsumer, type AgentChatJournalPorts } from '../lib/agent/runtime/chat-journal-consumer';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import type { AgentChatRunState } from '../lib/agent/runtime/chat-run-projection';
import type { AgentRuntimeEvent, AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';

function fixture() {
  const run = (): AgentChatRunState => ({ projectId: 'synthetic-project', runtimeSessionId: 'synthetic-session', transcript: AgentChatTranscript.from([]),
    journalScope: createAgentChatJournalScope(), controlStatus: null, pendingControl: null, lastTerminal: null, longTaskPlanState: null,
    contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() });
  let state: ReturnType<AgentChatJournalPorts['read']> = { boundProjectId: 'synthetic-project', runs: { first: run(), second: run() }, runningTurns: { first: 'synthetic-turn' } };
  const journals = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  const changes = new Set<Parameters<AgentChatJournalPorts['subscribeChanges']>[0]>();
  const effects: string[] = []; const saved: ReturnType<AgentChatTranscript['toArray']>[] = [];
  const counts = { journalConnections: 0, journalCleanup: 0, changesCleanup: 0, changed: 0 };
  let onPublish = () => {};
  const ports: AgentChatJournalPorts = {
    read: () => state,
    updateRun: (id, project) => { const run = state.runs[id]; if (!run) return; const next = project(run);
      if (run !== next) { state = { ...state, runs: { ...state.runs, [id]: next } }; effects.push(`publish:${id}`); onPublish(); } },
    persistConversation: id => { effects.push(`persist:${id}`); saved.push(state.runs[id].transcript.toArray()); },
    refreshPlan: id => { effects.push(`plan:${id}`); },
    finishTurn: (id, turnId) => { effects.push(`finish:${id}`); if (state.runningTurns[id] === turnId) {
      const runningTurns = { ...state.runningTurns }; delete runningTurns[id]; state = { ...state, runningTurns }; } },
    activity: () => ({ onToolUse: () => { effects.push('tool-ready'); }, onToolResult: () => { effects.push('tool-result'); }, onTurnEnd: () => { effects.push('turn-end'); } }),
    subscribeJournal: callback => { counts.journalConnections++; journals.add(callback); return { ok: true, value: () => { counts.journalCleanup++; journals.delete(callback); } }; },
    subscribeChanges: callback => { changes.add(callback); return () => { counts.changesCleanup++; changes.delete(callback); }; },
    conversationsChanged: () => { counts.changed++; },
  };
  const owner = createAgentChatJournalConsumer(ports);
  return { owner, ports, journals, changes, effects, saved, counts, afterPublish(callback: () => void) { onPublish = callback; },
    setState(next: typeof state) { state = next; }, emit(entry: AgentRuntimeJournalEntry) { for (const callback of journals) callback(entry); } };
}

export function runAgentJournalScenarios() {
  let sequence = 0;
  const entry = (event: AgentRuntimeEvent, conversationId: string | undefined = 'first'): AgentRuntimeJournalEntry => ({ schemaVersion: 1,
    sessionId: 'synthetic-session', turnId: 'synthetic-turn', route: { kind: 'chat', projectId: 'synthetic-project', conversationId },
    seq: ++sequence, eventId: `synthetic-turn:${String(sequence).padStart(8, '0')}`, wallTimeMs: 1_700_000_000_000 + sequence, event });
  const text = () => entry({ type: 'text_delta', iteration: 1, text: 'Synthetic tail' });
  const checks: Array<{ id: string; passed: true }> = [];
  const check = (id: string, passed: boolean) => { if (!passed) throw new Error(`Agent journal owner: ${id}`); checks.push({ id, passed: true }); };

  let cyclesClean = true;
  for (let cycle = 0; cycle < 100; cycle++) {
    const f = fixture();
    for (let mount = 0; mount < 20; mount++) f.owner.ensureConnected();
    const journal = [...f.journals][0]; const changed = [...f.changes][0];
    f.owner.registerTurn('synthetic-turn', 'first');
    f.emit(text()); const before = f.ports.read();
    f.owner.dispose(); f.owner.dispose(); journal(text()); changed({ projectId: 'synthetic-project', conversationIds: ['first'] });
    cyclesClean &&= f.counts.journalConnections === 1 && f.counts.journalCleanup === 1 && f.counts.changesCleanup === 1
      && !f.journals.size && !f.changes.size && f.ports.read() === before && f.counts.changed === 0 && !f.owner.ensureConnected();
  }
  check('one-connection-and-no-late-work-after-100-disposals', cyclesClean);

  const routed = fixture(); routed.owner.ensureConnected(); routed.owner.registerTurn('synthetic-turn', 'first');
  try {
    const before = routed.ports.read(); const event = text();
    routed.emit({ ...event, route: { kind: 'chat', projectId: 'foreign-project', conversationId: 'first' } });
    routed.emit({ ...event, route: { kind: 'test', projectId: 'synthetic-project' } });
    routed.emit({ ...event, route: { kind: 'chat', projectId: 'synthetic-project', conversationId: 'second' } });
    check('foreign-project-kind-and-conflicting-route-rejected', routed.ports.read() === before && routed.effects.length === 0);
    routed.emit({ ...event, route: { kind: 'chat', projectId: 'synthetic-project' } });
    check('registered-turn-routes-without-visible-conversation', routed.ports.read().runs.first.transcript.length === 1);
    const accepted = routed.ports.read(); routed.emit(event);
    check('duplicate-keeps-state-and-effects', routed.ports.read() === accepted && routed.effects.length === 1);
    routed.owner.releaseTurn('synthetic-turn');
    routed.emit(entry({ type: 'text_delta', iteration: 1, text: 'Sibling' }, 'second'));
    check('released-mapping-allows-explicit-sibling-route', routed.ports.read().runs.second.transcript.length === 1);
  } finally { routed.owner.dispose(); }

  const terminal = fixture(); terminal.owner.ensureConnected();
  terminal.setState({ ...terminal.ports.read(), boundProjectId: 'another-project' });
  terminal.emit(text());
  terminal.emit(entry({ type: 'tool_call_ready', iteration: 1, callId: 'read', name: 'read_node', arguments: {}, rawArguments: '{}' }));
  check('background-project-does-not-pulse-visible-activity', !terminal.effects.includes('tool-ready'));
  terminal.effects.length = 0;
  terminal.afterPublish(() => terminal.owner.dispose());
  const done = entry({ type: 'turn_finished', outcome: 'completed', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, modelIterations: 1, durationMs: 10 });
  terminal.emit(done);
  check('accepted-terminal-finishes-effects-during-disposal', terminal.effects.join(',') === 'publish:first,plan:first,turn-end,finish:first,persist:first');
  check('terminal-persistence-sees-final-array', terminal.saved.length === 1 && terminal.saved[0][0].kind === 'assistant'
    && terminal.saved[0][0].streaming === false && terminal.saved[0][1].kind === 'usage' && !terminal.ports.read().runningTurns.first);

  const failed = fixture(); const subscribe = failed.ports.subscribeJournal; let rejected: ((entry: AgentRuntimeJournalEntry) => void) | undefined;
  failed.ports.subscribeJournal = callback => { rejected = callback; return { ok: false, code: 'synthetic-unavailable', error: 'Synthetic unavailable' }; };
  check('unavailable-connection-is-retryable', !failed.owner.ensureConnected());
  failed.ports.subscribeJournal = subscribe; failed.owner.ensureConnected(); const beforeRetry = failed.ports.read(); rejected!(text());
  check('failed-connection-callback-cannot-enter-new-generation', failed.ports.read() === beforeRetry);
  failed.emit(text()); check('retried-connection-receives-new-events', failed.ports.read().runs.first.transcript.length === 1); failed.owner.dispose();

  const changesFailure = fixture(); const subscribeChanges = changesFailure.ports.subscribeChanges;
  changesFailure.ports.subscribeChanges = () => { throw new Error('Synthetic changes subscription failed'); };
  let threw = false; try { changesFailure.owner.ensureConnected(); } catch { threw = true; }
  check('second-subscription-failure-releases-journal', threw && changesFailure.journals.size === 0 && changesFailure.counts.journalCleanup === 1);
  changesFailure.ports.subscribeChanges = subscribeChanges;
  check('second-subscription-failure-can-retry', changesFailure.owner.ensureConnected()); changesFailure.owner.dispose();

  const synchronous = fixture(); const syncSubscribe = synchronous.ports.subscribeJournal;
  synchronous.ports.subscribeJournal = callback => { const subscription = syncSubscribe(callback); synchronous.owner.dispose(); return subscription; };
  check('disposal-during-journal-connection-cleans-returned-listener', !synchronous.owner.ensureConnected() && synchronous.journals.size === 0 && synchronous.counts.journalCleanup === 1);
  const syncChanges = fixture(); const secondSubscribe = syncChanges.ports.subscribeChanges;
  syncChanges.ports.subscribeChanges = callback => { const cleanup = secondSubscribe(callback); syncChanges.owner.dispose(); return cleanup; };
  check('disposal-during-changes-connection-cleans-both-listeners', !syncChanges.owner.ensureConnected() && syncChanges.journals.size === 0 && syncChanges.changes.size === 0
    && syncChanges.counts.journalCleanup === 1 && syncChanges.counts.changesCleanup === 1);
  return { cycles: 100, checks, boundary: 'Real journal-consumer factory with synthetic synchronous store, transport and effect ports. No SQLite IO, model execution, heap measurement or physical device acceptance.' };
}
