import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { DesktopAgentPanel } from '../features/agent/desktop/DesktopAgentPanel';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import { useAgentChatStore, selectMessages } from '../store/agent-chat-store';
import { useSettingsStore } from '../store/settings-store';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../lib/agent/transport';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { AGENT_RUNTIME_SCHEMA_VERSION, type AgentRuntimeEvent, type AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';
import type { AgentChatMessage } from '../domain/agent-conversation';
import { agentPanelRenders, resetAgentPanelRenders } from './agent-panel-counters';
import { events } from '../lib/events';

export async function runAgentPanelScenarios() {
  const before = useAgentChatStore.getState(); const settings = useSettingsStore.getState();
  const initialAuthListeners = events.all.get('agent:auth-changed')?.length ?? 0;
  const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  const restore = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
    capability: { ...unsupportedGeneralAgentTransport.capability, available: true },
    authStatus: async () => ({ ok: true, value: { byokConnected: false, apiKeyConnected: true, hostedAvailable: false } }),
    subscribeJournal: listener => { listeners.add(listener); return { ok: true, value: () => { listeners.delete(listener); } }; },
  });
  const i18n = createInstance(); await i18n.init({ lng: 'en', resources: {}, initImmediate: false });
  const host = document.createElement('div'); host.style.cssText = 'width:480px;height:640px;position:relative'; document.body.append(host);
  const root = createRoot(host); const projectId = 'synthetic-panel-project'; const conversationId = 'synthetic-panel-conversation';
  const sessionId = 'synthetic-panel-session'; let seq = 0;
  const history: AgentChatMessage[] = Array.from({ length: 150 }, (_, index) => [
    { kind: 'user' as const, text: `Synthetic author ${index}` },
    { kind: 'assistant' as const, text: `**Synthetic history ${index}**\n\nA stable paragraph for selection and scroll acceptance.`, streaming: false },
  ]).flat();
  const checks: string[] = []; const check = (name: string, valid: unknown) => { if (!valid) throw new Error(`Agent panel: ${name}`); checks.push(name); };
  const frame = async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const emit = (event: AgentRuntimeEvent) => {
    seq++;
    const entry: AgentRuntimeJournalEntry = { schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION, sessionId,
      turnId: 'synthetic-panel-turn', route: { kind: 'chat', projectId, conversationId }, seq,
      eventId: `synthetic-panel:${seq}`, wallTimeMs: 1_700_000_000_000 + seq, event };
    flushSync(() => { for (const listener of listeners) listener(entry); });
  };
  const render = (mounted = true) => flushSync(() => root.render(mounted ? createElement(I18nextProvider, { i18n },
    createElement(WorkspaceNavigationProvider, { navigator: { projectId, open() {}, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} },
      children: createElement(DesktopAgentPanel, { projectId }) })) : null));
  const log = () => host.querySelector<HTMLDivElement>('[style*="overflow-y: auto"]')!;
  const bottom = () => log().scrollHeight - log().scrollTop - log().clientHeight < 2;
  try {
    useSettingsStore.setState({ agentAuth: 'apikey' });
    useAgentChatStore.setState({ boundProjectId: projectId, activeConvId: conversationId, prompt: 'Synthetic draft stays in the composer',
      refreshList: () => undefined, convList: [{ id: conversationId, title: 'Synthetic current conversation', mode: 'byok', updatedAt: '2026-01-01T00:00:00.000Z' }], starting: false, runningTurns: { [conversationId]: 'synthetic-panel-turn' },
      runs: { [conversationId]: { projectId, runtimeSessionId: sessionId, messages: history, journalScope: createAgentChatJournalScope(),
        controlStatus: 'running', pendingControl: null, lastTerminal: null, longTaskPlanState: null, contextUsage: null,
        automaticContinuation: createInactiveAgentAutomaticContinuation() } } });
    render(); await frame();
    check('full authenticated desktop panel mounts all 300 historical messages', host.querySelectorAll('.agent-md').length === 150 && Boolean(host.querySelector('textarea')));
    const initialBottom = bottom(); check('asynchronous authentication mounts history at the bottom', initialBottom);
    emit({ type: 'text_delta', iteration: 1, text: 'Streaming tail\n\n' }); await frame();
    const stable = host.querySelector('.agent-md'); const composer = host.querySelector('textarea')!;
    composer.focus(); composer.setSelectionRange(3, 9);
    resetAgentPanelRenders();
    for (let batch = 0; batch < 20; batch++) {
      for (let delta = 0; delta < 20; delta++) emit({ type: 'text_delta', iteration: 1, text: '流式输出 ' });
      await frame();
    }
    const streaming = { ...agentPanelRenders };
    check('stream display updates only the transcript and newest message', streaming.panel === 0 && streaming.composer === 0 && streaming.message === 20 && streaming.transcript === 20);
    check('streaming preserves composer DOM focus draft and selection', host.querySelector('textarea') === composer && document.activeElement === composer && composer.value === 'Synthetic draft stays in the composer' && composer.selectionStart === 3 && composer.selectionEnd === 9);
    check('streaming preserves historical message DOM', host.querySelector('.agent-md') === stable);
    check('streaming follows the latest displayed text at bottom', bottom() && log().textContent?.includes('流式输出'));
    check('canonical journal contains every streamed delta', JSON.stringify(selectMessages(useAgentChatStore.getState())).includes('流式输出 '.repeat(400)));
    resetAgentPanelRenders();
    for (let index = 0; index < 20; index++) flushSync(() => useAgentChatStore.getState().setPrompt(`Synthetic changed draft ${index}`));
    const drafting = { ...agentPanelRenders };
    check('composer draft updates do not render the transcript or historical messages', drafting.panel === 20 && drafting.transcript === 0 && drafting.message === 0 && composer.value === 'Synthetic changed draft 19');
    flushSync(() => useAgentChatStore.getState().setPrompt('Synthetic draft stays in the composer'));
    log().scrollTop = 100; flushSync(() => log().dispatchEvent(new Event('scroll', { bubbles: true })));
    const scrolled = log().scrollTop;
    const selected = stable!.querySelector('strong')!.firstChild!; const range = document.createRange(); range.setStart(selected, 0); range.setEnd(selected, 9);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    emit({ type: 'text_delta', iteration: 1, text: '\n\nNew tail while reading history.' }); await frame();
    check('reading history keeps scroll and selected text during a new tail', log().scrollTop === scrolled && document.getSelection()?.toString() === 'Synthetic');
    const jump = host.querySelector<HTMLButtonElement>('[title="agentPanel.jumpLatest"]')!;
    check('scrolling away exposes latest control', Boolean(jump));
    flushSync(() => jump.click()); await frame(); check('latest control reengages bottom follow', bottom());
    log().scrollTop = 100; flushSync(() => log().dispatchEvent(new Event('scroll', { bubbles: true })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[title="agentPanel.toolbar.historyTitle"]')!.click());
    const historyDialog = document.querySelector('.agt-history-menu')!;
    check('history is an anchored portal outside the panel', Boolean(historyDialog) && !host.contains(historyDialog));
    flushSync(() => historyDialog.querySelector<HTMLButtonElement>('button')!.click()); await frame();
    check('selecting the already active conversation reengages follow', bottom());
    flushSync(() => useAgentChatStore.getState().setPrompt('Synthetic draft stays in the composer'));
    emit({ type: 'tool_call_started', iteration: 1, callId: 'synthetic-inspect', name: 'synthetic_inspect' });
    emit({ type: 'tool_call_ready', iteration: 1, callId: 'synthetic-inspect', name: 'synthetic_inspect', arguments: { synthetic: true }, rawArguments: '{"synthetic":true}' });
    emit({ type: 'tool_result', callId: 'synthetic-inspect', name: 'synthetic_inspect', ok: true, content: 'Synthetic tool result.', source: 'executor' });
    await frame(); const toolDetail = host.querySelector<HTMLDetailsElement>('details')!; toolDetail.open = true;
    emit({ type: 'text_delta', iteration: 1, text: 'After tool result.' }); await frame();
    check('completed tool detail remains expanded across subsequent streaming', host.querySelector('details') === toolDetail && toolDetail.open && toolDetail.textContent?.includes('Synthetic tool result.'));
    check('session usage footer retains the tool count', host.querySelector('[title="agentPanel.usage.sessionTitle"]')?.textContent?.includes('agentPanel.usage.toolsCount'));
    emit({ type: 'text_delta', iteration: 1, text: 'Permission tail' });
    emit({ type: 'permission_requested', request: { requestId: 'synthetic-permission', sessionId, turnId: 'synthetic-panel-turn', callId: 'synthetic-write', toolName: 'write_node', access: 'write', arguments: {}, argumentsHash: `sha256:${'b'.repeat(64)}`, revision: null, allowedScopes: ['once'] } });
    check('permission boundary displays pending card and full tail immediately', Boolean(host.querySelector('.agt-control-card')) && log().textContent?.includes('Permission tail'));
    emit({ type: 'cancellation_requested', reason: 'synthetic-author' });
    check('cancellation control disables steering without erasing the draft', Array.from(host.querySelectorAll<HTMLButtonElement>('.agt-send')).some(button => button.disabled) && composer.value === 'Synthetic draft stays in the composer');
    emit({ type: 'model_iteration_completed', iteration: 1, stopReason: 'end_turn' }); await frame();
    render(false); emit({ type: 'text_delta', iteration: 2, text: 'Stream survived panel closure.' }); render(); await frame();
    check('panel remount reads current canonical stream and retains draft', log().textContent?.includes('Stream survived panel closure.') && host.querySelector('textarea')?.value === 'Synthetic draft stays in the composer');
    const returningBottom = bottom(); check('panel remount positions the current transcript at bottom', returningBottom);
    const oldRun = useAgentChatStore.getState().runs[conversationId];
    const otherId = 'synthetic-panel-other';
    flushSync(() => useAgentChatStore.setState(state => ({ activeConvId: otherId, runs: { ...state.runs,
      [otherId]: { ...oldRun, messages: [{ kind: 'assistant', text: 'Other conversation only.', streaming: false }],
        runtimeSessionId: 'synthetic-panel-other-session', journalScope: createAgentChatJournalScope(), controlStatus: null, pendingControl: null } } })));
    check('conversation switch synchronously replaces the old transcript', log().textContent?.includes('Other conversation only.') && !log().textContent?.includes('Synthetic history'));
    resetAgentPanelRenders(); emit({ type: 'text_delta', iteration: 2, text: 'Background continuation.' }); await frame();
    check('background sibling events do not render the active panel or transcript', Object.values(agentPanelRenders).every(count => count === 0) && !log().textContent?.includes('Background continuation.'));
    flushSync(() => useAgentChatStore.setState({ activeConvId: conversationId })); await frame();
    check('returning to a running conversation includes its background tail and resets follow', log().textContent?.includes('Background continuation.') && bottom());
    const originalMessages = selectMessages(useAgentChatStore.getState());
    flushSync(() => useAgentChatStore.setState(state => ({ runs: { ...state.runs, [conversationId]: { ...state.runs[conversationId],
      messages: [{ kind: 'thinking', text: 'Old conversation detail.', streaming: false }, ...originalMessages] } } })));
    const details = host.querySelector<HTMLDetailsElement>('details')!; details.open = true;
    flushSync(() => useAgentChatStore.setState({ activeConvId: otherId }));
    flushSync(() => useAgentChatStore.setState(state => ({ runs: { ...state.runs, [otherId]: { ...state.runs[otherId], messages: [
      { kind: 'thinking', text: 'New conversation detail.', streaming: false }, { kind: 'assistant', text: 'Other conversation only.', streaming: false } ] } } })));
    check('conversation ownership prevents expanded details leaking to another session', host.querySelector('details') !== details && host.querySelector<HTMLDetailsElement>('details')?.open === false);
    for (let cycle = 0; cycle < 100; cycle++) {
      render(false); render(); await frame();
      if (!host.querySelector('textarea') || (events.all.get('agent:auth-changed')?.length ?? 0) !== initialAuthListeners + 1) throw new Error(`Agent panel owner duplicated or missing at cycle ${cycle}`);
    }
    render(false);
    const remainingAuthListeners = (events.all.get('agent:auth-changed')?.length ?? 0) - initialAuthListeners;
    check('repeated panel closure releases its authentication listener', remainingAuthListeners === 0);
    return { checks, historyMessages: history.length, displayBatches: 20, streamEvents: 400, streaming, drafting, initialBottom, returningBottom, cycles: 100, remainingAuthListeners,
      scope: 'Actual desktop panel and composer, production React, canonical synthetic journal and no persistence/model calls. Desktop Chromium scroll and selection; mobile and native acceptance remain separate.' };
  } finally {
    document.getSelection()?.removeAllRanges(); flushSync(() => root.unmount()); host.remove();
    useAgentChatStore.setState(before, true); useSettingsStore.setState({ agentAuth: settings.agentAuth }); restore();
  }
}
