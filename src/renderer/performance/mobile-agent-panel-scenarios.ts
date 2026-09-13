import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MobileAgentPanel } from '../shells/mobile/workspace/MobileAgentPanel';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import { useAgentChatStore, selectMessages } from '../store/agent-chat-store';
import { useSettingsStore } from '../store/settings-store';
import { useAuthStore } from '../store/auth';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../lib/agent/transport';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import { AGENT_RUNTIME_SCHEMA_VERSION, type AgentRuntimeEvent, type AgentRuntimeJournalEntry } from '../lib/agent/runtime/types';
import type { AgentChatMessage } from '../domain/agent-conversation';
import { agentPanelRenders, agentMobileRows, resetAgentPanelRenders } from './agent-panel-counters';
import { mobileAgentOutputs } from './mobile-agent-output-services';
import { events } from '../lib/events';
import mobileCss from '../../styles/mobile-workspace.css?inline';

export async function runMobileAgentPanelScenarios({ verifyRenders = true } = {}) {
  const before = useAgentChatStore.getState(); const settings = useSettingsStore.getState();
  const originalUser = useAuthStore.getState().user;
  const focusedBefore = document.activeElement;
  const authListenersBefore = events.all.get('agent:auth-changed')?.length ?? 0;
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => mobileAgentOutputs.copy(text) } });
  const listeners = new Set<(entry: AgentRuntimeJournalEntry) => void>();
  const restore = installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
    capability: { ...unsupportedGeneralAgentTransport.capability, available: true },
    authStatus: async () => ({ ok: true, value: { byokConnected: false, apiKeyConnected: true, hostedAvailable: false } }),
    subscribeJournal: listener => { listeners.add(listener); return { ok: true, value: () => { listeners.delete(listener); } }; },
  });
  const i18n = createInstance(); await i18n.init({ lng: 'en', resources: {}, initImmediate: false });
  const style = document.createElement('style'); style.textContent = mobileCss; document.head.append(style);
  const host = document.createElement('div'); host.style.cssText = 'width:390px;height:640px;position:fixed;top:12px;left:12px;z-index:2147483000'; document.body.append(host);
  const root = createRoot(host); const projectId = 'synthetic-mobile-project'; const conversationId = 'synthetic-mobile-conversation'; const otherId = 'synthetic-mobile-other';
  const opened: string[] = []; const navigation = { projectId, open: (target: { id: string }) => { opened.push(target.id); }, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} };
  const history: AgentChatMessage[] = Array.from({ length: 150 }, (_, index) => [
    { kind: 'user' as const, text: `Synthetic author ${index}`, context: [{ kind: 'workspace' as const, projectId, entityType: 'node' as const, entityId: `synthetic-node-${index}`, label: `Synthetic chapter ${index}`, blockId: `synthetic-block-${index}` }] },
    { kind: 'assistant' as const, text: `**Synthetic mobile history ${index}**\n\nA stable synthetic paragraph.`, streaming: false },
  ]).flat();
  let seq = 0;
  const emit = (event: AgentRuntimeEvent) => {
    seq++;
    const entry: AgentRuntimeJournalEntry = { schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION, sessionId: 'synthetic-mobile-session',
      turnId: 'synthetic-mobile-turn', route: { kind: 'chat', projectId, conversationId }, seq,
      eventId: `synthetic-mobile:${seq}`, wallTimeMs: 1_700_000_000_000 + seq, event };
    flushSync(() => { for (const listener of listeners) listener(entry); });
  };
  const frame = async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const paperBinding = { loading: false, error: false, setPrompt: before.setPrompt, select: async (id: string | null) => { useAgentChatStore.setState({ activeConvId: id }); } };
  const render = (mode: 'sidebar' | 'paper' | null) => flushSync(() => root.render(mode ? createElement(I18nextProvider, { i18n }, createElement(MemoryRouter, {},
    createElement(WorkspaceNavigationProvider, { navigator: navigation, children: createElement(MobileAgentPanel, { projectId, target: null, ...(mode === 'paper' ? { paperBinding } : {}) }) }))) : null));
  const log = () => host.querySelector<HTMLDivElement>('.m-agent__log')!;
  const rows = () => host.querySelectorAll<HTMLElement>('.m-agent-output-actions');
  const click = (element: HTMLElement) => flushSync(() => element.click());
  const switchTo = (id: string) => flushSync(() => useAgentChatStore.setState({ activeConvId: id }));
  const checks: string[] = []; const check = (name: string, valid: unknown) => { if (!valid) throw new Error(`Mobile Agent: ${name}`); checks.push(name); };
  const measurements = [];
  try {
    useSettingsStore.setState({ agentAuth: 'apikey' });
    for (const mode of ['sidebar', 'paper'] as const) {
      useAgentChatStore.setState({ boundProjectId: projectId, activeConvId: conversationId, prompt: 'Synthetic mobile draft',
        refreshList: () => undefined, convList: [], starting: false, runningTurns: { [conversationId]: 'synthetic-mobile-turn' },
        runs: { [conversationId]: { projectId, runtimeSessionId: 'synthetic-mobile-session', transcript: AgentChatTranscript.from(history),
          journalScope: createAgentChatJournalScope(), controlStatus: 'running', pendingControl: null, lastTerminal: null,
          longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() } } });
      render(mode); if (mode === 'paper') useAgentChatStore.getState().bindProject(projectId); await frame();
      check(`${mode}: actual panel mounts history, output actions and composer`, host.querySelectorAll('.m-agent__message').length === 300 && rows().length === 150 && Boolean(host.querySelector('textarea')));
      const composer = host.querySelector('textarea')!; composer.focus(); composer.setSelectionRange(2, 8);
      emit({ type: 'text_delta', iteration: 1, text: 'Mobile tail\n\n' }); await frame(); resetAgentPanelRenders(); agentMobileRows.renders = 0;
      for (let batch = 0; batch < 20; batch++) {
        for (let delta = 0; delta < 20; delta++) emit({ type: 'text_delta', iteration: 1, text: '移动输出 ' });
        await frame();
      }
      const streaming = verifyRenders ? { ...agentPanelRenders } : null;
      const messageRows = verifyRenders ? agentMobileRows.renders : null;
      if (streaming) check(`${mode}: streaming updates only the transcript and latest row`, streaming.panel === 0 && streaming.composer === 0 && streaming.message === 20 && streaming.transcript === 20 && messageRows === 20);
      check(`${mode}: streaming retains composer focus draft and selection`, composer === host.querySelector('textarea') && document.activeElement === composer && composer.value === 'Synthetic mobile draft' && composer.selectionStart === 2 && composer.selectionEnd === 8);
      check(`${mode}: canonical transcript contains every delta`, JSON.stringify(selectMessages(useAgentChatStore.getState())).includes('移动输出 '.repeat(400)));
      resetAgentPanelRenders(); agentMobileRows.renders = 0;
      for (let index = 0; index < 20; index++) flushSync(() => useAgentChatStore.getState().setPrompt(`Synthetic mobile draft ${index}`));
      const drafting = verifyRenders ? { ...agentPanelRenders } : null;
      if (drafting) check(`${mode}: drafting does not reconcile the transcript or its rows`, drafting.panel === 20 && drafting.transcript === 0 && drafting.message === 0 && agentMobileRows.renders === 0);
      flushSync(() => useAgentChatStore.getState().setPrompt('Synthetic mobile draft'));
      log().scrollTop = 100; flushSync(() => log().dispatchEvent(new Event('scroll', { bubbles: true }))); const top = log().scrollTop;
      emit({ type: 'text_delta', iteration: 1, text: '\n\nReading old messages.' }); await frame();
      check(`${mode}: reading history keeps its scroll position`, log().scrollTop === top);
      const jump = host.querySelector<HTMLButtonElement>('.m-agent__latest')!; check(`${mode}: latest control appears`, Boolean(jump)); click(jump); await frame();
      check(`${mode}: latest control returns to bottom`, log().scrollHeight - log().scrollTop - log().clientHeight < 2);
      emit({ type: 'model_iteration_completed', iteration: 1, stopReason: 'end_turn' });
      const oldRun = useAgentChatStore.getState().runs[conversationId];
      flushSync(() => useAgentChatStore.setState(state => ({ runs: { ...state.runs, [otherId]: { ...oldRun,
        transcript: AgentChatTranscript.from([{ kind: 'user', text: 'Other author' }, { kind: 'assistant', text: 'Other answer', streaming: false }]),
        journalScope: createAgentChatJournalScope(), runtimeSessionId: 'synthetic-mobile-other-session', controlStatus: null } } })));
      click(rows()[0].querySelectorAll<HTMLButtonElement>('button')[1]); const late = mobileAgentOutputs.nodes[mobileAgentOutputs.nodes.length - 1];
      switchTo(otherId); const opensBefore = opened.length; late.resolve({ id: 'synthetic-late-node' }); await frame();
      const lateFeedbackCrossedSession = Boolean(rows()[0].textContent?.includes('agentPanel.mobile.action.inspirationDone'));
      const lateNavigation = opened.length - opensBefore;
      check(`${mode}: retired output results do not publish into or navigate a different session`, !lateFeedbackCrossedSession && lateNavigation === 0);
      switchTo(conversationId); const create = rows()[0].querySelectorAll<HTMLButtonElement>('button')[1]; const writesBefore = mobileAgentOutputs.nodes.length;
      click(create); click(create); const duplicateWrites = mobileAgentOutputs.nodes.length - writesBefore;
      check(`${mode}: repeated pending action starts one local write`, duplicateWrites === 1);
      mobileAgentOutputs.nodes.slice(writesBefore).forEach((call, index) => call.resolve({ id: `synthetic-current-node-${index}` })); await frame();
      check(`${mode}: current inspiration result publishes and opens the created drift`, opened[opened.length - 1] === 'synthetic-current-node-0' && rows()[0].textContent?.includes('agentPanel.mobile.action.inspirationDone'));
      const action = (row: number, column: number) => rows()[row].querySelectorAll<HTMLButtonElement>('button')[column];
      click(action(0, 2)); const todo = mobileAgentOutputs.comments[mobileAgentOutputs.comments.length - 1];
      check(`${mode}: todo uses the original message project and block anchor`, todo.projectId === projectId && todo.input.kind === 'todo' && todo.input.targetKind === 'node' && todo.input.targetId === 'synthetic-node-0' && todo.input.targetBlockId === 'synthetic-block-0' && todo.input.targetBlockIds?.[0] === 'synthetic-block-0');
      todo.resolve(); await frame(); check(`${mode}: current todo result releases action controls`, !action(0, 2).disabled && rows()[0].textContent?.includes('agentPanel.mobile.action.todoDone'));
      click(action(0, 0)); const copy = mobileAgentOutputs.copies[mobileAgentOutputs.copies.length - 1];
      check(`${mode}: copy captures the exact selected output`, copy.text === (history[1] as Extract<AgentChatMessage, { kind: 'assistant' }>).text);
      copy.resolve(); await frame(); check(`${mode}: completed copy feedback belongs to its message`, rows()[0].textContent?.includes('agentPanel.mobile.action.copied'));
      click(action(0, 2)); const failed = mobileAgentOutputs.comments[mobileAgentOutputs.comments.length - 1]; failed.reject(new Error('Synthetic write failure')); await frame();
      check(`${mode}: current failure is visible and permits retry`, rows()[0].textContent?.includes('Synthetic write failure') && !action(0, 2).disabled);
      click(action(0, 2)); const oldFailure = mobileAgentOutputs.comments[mobileAgentOutputs.comments.length - 1]; switchTo(otherId); oldFailure.reject(new Error('Synthetic retired failure')); await frame();
      check(`${mode}: retired failure does not appear in the incoming conversation`, !log().textContent?.includes('Synthetic retired failure'));
      switchTo(conversationId);
      click(action(0, 1)); const removed = mobileAgentOutputs.nodes[mobileAgentOutputs.nodes.length - 1]; const openedBeforeReturn = opened.length;
      switchTo(otherId); switchTo(conversationId); removed.resolve({ id: 'synthetic-retired-return' }); await frame();
      check(`${mode}: returning to the same conversation does not revive a closed action owner`, opened.length === openedBeforeReturn && !rows()[0].querySelector('[role="status"]'));
      click(action(0, 0)); const replaced = mobileAgentOutputs.copies[mobileAgentOutputs.copies.length - 1]; const savedMessages = selectMessages(useAgentChatStore.getState());
      flushSync(() => useAgentChatStore.setState(state => ({ runs: { ...state.runs, [conversationId]: { ...state.runs[conversationId], transcript: AgentChatTranscript.from(savedMessages.map((message, index) => index === 1 ? { kind: 'assistant', text: 'Replacement output.', streaming: false } : message)) } } })));
      click(action(0, 0)); const replacement = mobileAgentOutputs.copies[mobileAgentOutputs.copies.length - 1]; replaced.resolve(); await frame();
      check(`${mode}: old message completion cannot release or label its replacement action`, replacement !== replaced && action(0, 0).disabled && !rows()[0].textContent?.includes('agentPanel.mobile.action.copied'));
      replacement.resolve(); await frame(); check(`${mode}: replacement action completes independently`, !action(0, 0).disabled && rows()[0].textContent?.includes('agentPanel.mobile.action.copied'));
      if (verifyRenders) {
        // Browser-only actor rebind: the native App must retain its actual
        // synthetic workspace/user lifecycle for the surrounding control run.
        click(action(0, 0)); const oldActor = mobileAgentOutputs.copies[mobileAgentOutputs.copies.length - 1];
        flushSync(() => useAuthStore.setState({ user: { id: 'synthetic-output-actor', email: 'synthetic@example.invalid', name: 'Synthetic actor', emailVerified: false, createdAt: new Date(0), updatedAt: new Date(0) } }));
        oldActor.resolve(); await frame();
        check(`${mode}: actor rebind clears pending feedback and ignores its old completion`, !action(0, 0).disabled && !rows()[0].querySelector('[role="status"]'));
        click(action(0, 0)); mobileAgentOutputs.copies[mobileAgentOutputs.copies.length - 1].resolve(); await frame();
        check(`${mode}: incoming actor can own the next action on the same message`, rows()[0].textContent?.includes('agentPanel.mobile.action.copied'));
        flushSync(() => useAuthStore.setState({ user: originalUser }));
      }
      click(action(0, 1)); const closed = mobileAgentOutputs.nodes[mobileAgentOutputs.nodes.length - 1]; const openedBeforeClose = opened.length;
      render(null); closed.resolve({ id: 'synthetic-closed-node' }); await frame(); render(mode); await frame();
      check(`${mode}: unmounted panel cannot publish or navigate after an existing write finishes`, opened.length === openedBeforeClose && !rows()[0].querySelector('[role="status"]'));
      click(action(0, 1)); const foreign = mobileAgentOutputs.nodes[mobileAgentOutputs.nodes.length - 1]; const openedBeforeProject = opened.length;
      flushSync(() => useAgentChatStore.setState({ boundProjectId: 'synthetic-foreign-project' })); foreign.resolve({ id: 'synthetic-foreign-node' }); await frame();
      check(`${mode}: project guard suppresses results even before the surface unmounts`, opened.length === openedBeforeProject);
      flushSync(() => useAgentChatStore.setState({ boundProjectId: projectId }));
      switchTo(otherId);
      resetAgentPanelRenders(); agentMobileRows.renders = 0;
      emit({ type: 'text_delta', iteration: 2, text: 'Synthetic background continuation.' }); await frame();
      const background = verifyRenders ? { ...agentPanelRenders } : null;
      check(`${mode}: background streaming leaves the incoming transcript unchanged`, !log().textContent?.includes('Synthetic background continuation.') && (!background || Object.values(background).every(count => count === 0)));
      for (let cycle = 0; cycle < 100; cycle++) {
        render(null); render(mode); await frame();
        if (!host.querySelector('textarea') || (events.all.get('agent:auth-changed')?.length ?? 0) !== authListenersBefore + 1) throw new Error(`Mobile ${mode} owner duplicated or missing at cycle ${cycle}`);
      }
      measurements.push({ mode, streaming, drafting, background, messageRows, lateFeedbackCrossedSession, lateNavigation, duplicateWrites, cycles: 100 });
      render(null);
      check(`${mode}: repeated unmount releases the auth subscription`, (events.all.get('agent:auth-changed')?.length ?? 0) === authListenersBefore);
    }
    return { checks, measurements, historyMessages: 300, displayBatches: 20, streamEventsPerMode: 400, verifyRenders,
      scope: 'Actual mobile sidebar and paper dock components at 390px with synthetic journal and deferred write ports. Host engine is recorded by the runner. No real clipboard, SQLite writes, model, touch device or keyboard viewport acceptance.' };
  } finally {
    flushSync(() => root.unmount()); host.remove(); style.remove();
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard); else Reflect.deleteProperty(navigator, 'clipboard');
    useAgentChatStore.setState(before, true); useSettingsStore.setState({ agentAuth: settings.agentAuth }); restore();
    useAuthStore.setState({ user: originalUser });
    if (focusedBefore instanceof HTMLElement && focusedBefore.isConnected) focusedBefore.focus({ preventScroll: true });
  }
}
