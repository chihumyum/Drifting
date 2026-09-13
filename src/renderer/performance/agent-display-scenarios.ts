import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useAgentChatMessages } from '../features/agent/useAgentChatMessages';
import { MessageView } from '../features/agent/AgentMessageViews';
import { selectMessages, useAgentChatStore } from '../store/agent-chat-store';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../lib/agent/transport';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { AGENT_RUNTIME_SCHEMA_VERSION, type AgentRuntimeEvent, type AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';

export async function runAgentDisplayScenarios() {
  const before = useAgentChatStore.getState();
  const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  const restore = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
    subscribeJournal: (listener) => { listeners.add(listener); return { ok: true, value: () => { listeners.delete(listener); } }; },
  });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const counts = { immediate: 0, batched: 0 };
  const checks: { id: string; passed: true }[] = [];
  const check = (id: string, valid: boolean) => {
    if (!valid) throw new Error(`Agent display acceptance failed: ${id}`);
    checks.push({ id, passed: true });
  };
  const projectId = 'synthetic-display-project'; const conversationId = 'synthetic-display-conversation';
  const sessionId = 'synthetic-display-session';
  let seq = 0;
  const emit = (event: AgentRuntimeEvent) => {
    seq++;
    const entry: AgentRuntimeJournalEntry = { schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      sessionId, turnId: 'synthetic-display-turn', route: { kind: 'chat', projectId, conversationId },
      seq, eventId: `synthetic-display:${seq}`, wallTimeMs: 1_700_000_000_000 + seq, event };
    flushSync(() => { for (const listener of listeners) listener(entry); });
  };
  function Immediate() {
    const messages = useAgentChatStore(selectMessages);
    useLayoutEffect(() => { counts.immediate++; });
    return createElement('div', { 'data-display-group': 'immediate' }, messages.map((msg, index) => createElement(MessageView, { key: index, msg })));
  }
  function Batched() {
    const messages = useAgentChatMessages();
    useLayoutEffect(() => { counts.batched++; });
    return createElement('div', { 'data-display-group': 'batched' }, messages.map((msg, index) => createElement(MessageView, { key: index, msg })));
  }
  try {
    useAgentChatStore.setState({ boundProjectId: projectId, activeConvId: conversationId,
      refreshList: () => undefined, runningTurns: {}, runs: { [conversationId]: {
        projectId, runtimeSessionId: sessionId, transcript: AgentChatTranscript.from([]), journalScope: createAgentChatJournalScope(),
        controlStatus: null, pendingControl: null, lastTerminal: null, longTaskPlanState: null, contextUsage: null,
        automaticContinuation: createInactiveAgentAutomaticContinuation(),
      } } });
    useAgentChatStore.getState().bindProject(projectId);
    check('one-canonical-subscriber', listeners.size === 1);
    flushSync(() => root.render(createElement('div', {}, Array.from({ length: 20 }, (_, index) => [
      createElement(Immediate, { key: `immediate-${index}` }), createElement(Batched, { key: `batched-${index}` }),
    ]))));
    counts.immediate = 0; counts.batched = 0;
    for (let index = 0; index < 100; index++) emit({ type: 'text_delta', iteration: 1, text: '字' });
    const burst = { ...counts };
    check('canonical-text-current-before-display-frame', JSON.stringify(selectMessages(useAgentChatStore.getState())) === JSON.stringify([{ kind: 'assistant', text: '字'.repeat(100), streaming: true }]));
    check('burst-notifications-coalesced', burst.immediate === 2_000 && burst.batched === 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const displayCommitsAfterFrame = counts.batched;
    check('one-display-commit-per-consumer', displayCommitsAfterFrame === 20);
    check('actual-message-markdown-renders-latest-text', Array.from(host.querySelectorAll('[data-display-group="batched"]')).every((element) => element.textContent?.includes('字'.repeat(100))));

    emit({ type: 'text_delta', iteration: 1, text: '权限前尾部' });
    emit({ type: 'permission_requested', request: { requestId: 'permission', sessionId, turnId: 'synthetic-display-turn', callId: 'write', toolName: 'write_node', access: 'write', arguments: {}, argumentsHash: `sha256:${'a'.repeat(64)}`, revision: null, allowedScopes: ['once'] } });
    check('permission-flushes-tail-synchronously', host.querySelector('[data-display-group="batched"]')?.textContent?.includes('权限前尾部') === true);
    emit({ type: 'text_delta', iteration: 1, text: '取消前尾部' });
    emit({ type: 'cancellation_requested', reason: 'synthetic-author' });
    check('cancellation-flushes-tail-synchronously', host.querySelector('[data-display-group="batched"]')?.textContent?.includes('取消前尾部') === true);
    emit({ type: 'text_delta', iteration: 1, text: '最后尾部' });
    emit({ type: 'model_iteration_completed', iteration: 1, stopReason: 'end_turn' });
    check('non-stream-boundary-flushes-final-tail', host.querySelector('[data-display-group="batched"]')?.textContent?.includes('最后尾部') === true);
    return { consumers: 20, streamEvents: 100, burst, displayCommitsAfterFrame, checks,
      boundary: 'Real React hook, chat-store ingress and MessageView rendering; synthetic burst. Full panel scrolling, native UI and durable terminal writes remain separate.' };
  } finally {
    flushSync(() => root.unmount()); host.remove();
    useAgentChatStore.setState(before, true); restore();
  }
}
