import { MobileAgentTranscript, type MobileAgentTranscriptHandle } from './MobileAgentTranscript';
import { ContextChips } from './MobileAgentContextChips';
import { useInputPreservingActions } from '../../../hooks/useInputPreservingActions';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MobilePaperAgentComposer } from './MobilePaperAgentComposer';
import { useTouchScrollFence } from './useTouchScrollFence';
import type { MobilePaperAgentBinding } from './mobile-paper-agent-session';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AgentChatMessage } from '../../../domain/agent-conversation';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { relTime } from '../../../features/agent/AgentMessageViews';
import { AgentComposerConfig } from '../../../features/agent/AgentComposerConfig';
import { AgentWorkingMemoryView } from '../../../features/agent/AgentWorkingMemoryView';
import { VoiceDictationButton } from '../../../features/agent/VoiceDictationButton';
import { AgentContextIndicator } from '../../../components/agent/AgentContextIndicator';
import { useAutosizeTextArea } from '../../../hooks/useAutosizeTextArea';
import { events } from '../../../lib/events';
import { getActiveEditor, subscribeActiveEditor } from '../../../lib/active-editor';
import {
  isGeneralAgentUsable,
  type GeneralAgentAuthStatus,
} from '../../../lib/agent/protocol';
import { generalAgentTransport } from '../../../lib/agent/transport';
import {
  selectContextUsage,
  selectMessages,
  selectPendingControl,
  selectRunning,
  useAgentChatStore,
} from '../../../store/agent-chat-store';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { useSettingsStore } from '../../../store/settings-store';
import {
  buildMobileAgentTurnContext,
  selectedMobileAgentBlockId,
} from './mobile-agent-model';

function targetLabel(target: WorkspaceTarget | null, t: (key: string) => string): string {
  const data = useDataStore.getState();
  if (!target) return t('agentPanel.mobile.target.dashboard');
  if (target.entityType === 'all-chapters') return t('agentPanel.mobile.target.allChapters');
  if (target.entityType === 'node') {
    return data.bookNodes.find((item) => item.id === target.id)?.title || t('agentPanel.mobile.target.untitledNode');
  }
  if (target.entityType === 'storyline') {
    return data.storylines.find((item) => item.id === target.id)?.name || t('agentPanel.mobile.target.untitledStoryline');
  }
  if (target.entityType === 'element') {
    return data.bookElements.find((item) => item.id === target.id)?.name || t('agentPanel.mobile.target.untitledElement');
  }
  return data.bookElementCategories.find((item) => item.id === target.id)?.name || t('agentPanel.mobile.target.untitledCategory');
}

function useSelectedBlockId(target: WorkspaceTarget | null, enabled = true): string | undefined {
  const [blockId, setBlockId] = useState(() => enabled ? selectedMobileAgentBlockId(getActiveEditor()) : undefined);
  useEffect(() => {
    if (!enabled) return;
    let editor = getActiveEditor();
    const update = () => setBlockId(selectedMobileAgentBlockId(editor));
    const bind = (next: typeof editor) => {
      editor?.off('selectionUpdate', update);
      editor = next;
      editor?.on('selectionUpdate', update);
      update();
    };
    bind(editor);
    const unsubscribe = subscribeActiveEditor(bind);
    return () => {
      unsubscribe();
      editor?.off('selectionUpdate', update);
    };
  }, [enabled, target?.entityType, target?.id]);
  return blockId;
}

// Only immutable transcript arrays are cached; background sibling events do
// not rescan an idle conversation's history to derive one retry boolean.
const retryableMessages = new WeakMap<AgentChatMessage[], boolean>();
function selectRetryable(state: ReturnType<typeof useAgentChatStore.getState>) {
  if (selectRunning(state)) return false;
  const messages = selectMessages(state);
  let retryable = retryableMessages.get(messages);
  if (retryable === undefined) { retryable = messages.some(message => message.kind === 'error'); retryableMessages.set(messages, retryable); }
  return retryable;
}

export function MobileAgentPanel({
  projectId,
  target,
  paperBinding,
  onClose,
  focusComposer = false,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
  paperBinding?: MobilePaperAgentBinding;
  onClose?: () => void;
  focusComposer?: boolean;
}) {
  const { t } = useTranslation();
  const api = generalAgentTransport;
  const navigate = useNavigate();
  const location = useLocation();
  const projectName = useProjectStore((state) => state.currentProject?.name) ?? t('agentPanel.mobile.currentProject');
  const agentAuth = useSettingsStore((state) => state.agentAuth);
  const prompt = useAgentChatStore((state) => state.prompt);
  const running = useAgentChatStore(selectRunning);
  const starting = useAgentChatStore((state) => state.starting);
  const pendingControl = useAgentChatStore(selectPendingControl);
  const contextUsage = useAgentChatStore(selectContextUsage);
  const convList = useAgentChatStore((state) => state.convList);
  const activeConvId = useAgentChatStore((state) => state.activeConvId);
  const runningTurns = useAgentChatStore((state) => state.runningTurns);
  const setPrompt = useAgentChatStore((state) => state.setPrompt);
  const send = useAgentChatStore((state) => state.send);
  const abort = useAgentChatStore((state) => state.abort);
  const newConversation = useAgentChatStore((state) => state.newConversation);
  const loadConversation = useAgentChatStore((state) => state.loadConversation);
  const deleteConversation = useAgentChatStore((state) => state.deleteConversation);
  const bindProject = useAgentChatStore((state) => state.bindProject);
  const blockId = useSelectedBlockId(target, !paperBinding);
  const label = useDataStore(() => targetLabel(target, t));
  const turnContext = useMemo(
    () =>
      paperBinding ? [] : buildMobileAgentTurnContext({
        projectId,
        projectName,
        target,
        targetLabel: label,
        blockId,
      }),
    [blockId, label, paperBinding, projectId, projectName, target],
  );
  const [status, setStatus] = useState<GeneralAgentAuthStatus | null>(null);
  const [view, setView] = useState<'chat' | 'memory'>('chat');
  const [historyOpen, setHistoryOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<MobileAgentTranscriptHandle>(null);
  const textAreaRef = useAutosizeTextArea(prompt);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const setComposerRef = useCallback((element: HTMLTextAreaElement | null) => { composerRef.current = element; textAreaRef(element); }, [textAreaRef]);

  const refreshStatus = useCallback(() => {
    if (!api.capability.available) {
      setStatus({ byokConnected: false, apiKeyConnected: false, hostedAvailable: false });
      return;
    }
    void api.authStatus().then(
      (result) =>
        setStatus(
          result.ok
            ? result.value
            : { byokConnected: false, apiKeyConnected: false, hostedAvailable: false },
        ),
      () => setStatus({ byokConnected: false, apiKeyConnected: false, hostedAvailable: false }),
    );
  }, [api]);

  useEffect(() => { if (!paperBinding) bindProject(projectId); }, [bindProject, projectId, paperBinding]);
  useLayoutEffect(() => {
    if (focusComposer) composerRef.current?.focus({ preventScroll: true });
  }, [focusComposer, textAreaRef]);
  useEffect(refreshStatus, [refreshStatus]);
  useEffect(() => {
    events.on('agent:auth-changed', refreshStatus);
    return () => events.off('agent:auth-changed', refreshStatus);
  }, [refreshStatus]);
  const usable = isGeneralAgentUsable(agentAuth, status);
  const retryable = useAgentChatStore(selectRetryable);
  const activeConversation = convList.find((conversation) => conversation.id === activeConvId);
  const historyUnavailable = !running && Boolean(activeConversation?.syncState && activeConversation.syncState !== 'ready');

  const handleSend = () => {
    transcriptRef.current?.follow();
    void send(paperBinding ? { toolAccess: 'read_write' } : { turnContext, toolAccess: 'read_write' });
  };
  const handleRetry = () => {
    const previous = [...selectMessages(useAgentChatStore.getState())].reverse().find((message) => message.kind === 'user');
    if (!previous || previous.kind !== 'user') return;
    transcriptRef.current?.follow();
    setPrompt(previous.text);
    void send(paperBinding ? { toolAccess: 'read_write' } : { turnContext: previous.context ?? turnContext, toolAccess: 'read_write' });
  };

  const chooseConversation = (id: string | null) => {
    transcriptRef.current?.follow();
    if (paperBinding && document.activeElement instanceof HTMLInputElement) {
      composerRef.current?.focus({ preventScroll: true });
    }
    setView('chat');
    setHistoryOpen(false);
    if (paperBinding) void paperBinding.select(id);
    else if (id) void loadConversation(id);
    else newConversation();
  };
  const [historyQuery, setHistoryQuery] = useState('');
  useEffect(() => {
    if (!historyOpen) return;
    const closeHistory = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); setHistoryOpen(false);
    };
    window.addEventListener('keydown', closeHistory, true);
    return () => window.removeEventListener('keydown', closeHistory, true);
  }, [historyOpen]);
  const composerControls = (<>
                <AgentComposerConfig preserveInputFocus={Boolean(paperBinding)} />
                <VoiceDictationButton
                  projectId={projectId}
                  onNeedsSetup={() =>
                    navigate('/settings', { state: { from: location.pathname } })
                  }
                />
                <span className="agt-composer__spacer" />
                {running && !prompt.trim() ? (
                  <button type="button" className="agt-send agt-send--stop" onClick={abort}>
                    {t('agentPanel.composer.stop')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="agt-send"
                    disabled={historyUnavailable || !usable || starting || Boolean(paperBinding?.loading) || Boolean(pendingControl?.requiresContinuation) || !prompt.trim()}
                    onClick={handleSend}
                  >
                    {running ? t('mobileWorkspace.paperAgent.steer') : t('agentPanel.composer.send')}
                  </button>
                )}
  </>);
  const composerFeedback = (<>
            {paperBinding?.loading && <div role="status">{t('common.loading')}</div>}
            {paperBinding?.error && <div role="alert">{t('mobileWorkspace.paperAgent.loadFailed')}</div>}
            {retryable && !running && (
              <button className="m-agent__retry" type="button" disabled={historyUnavailable || !usable} onClick={handleRetry}>
                {t('agentPanel.mobile.retry')}
              </button>
            )}

  </>);
  const expanded = !paperBinding || Boolean(activeConvId) || historyOpen;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!paperBinding || !expanded || !panel) return;
    if (historyOpen && document.activeElement !== composerRef.current) panel.querySelector<HTMLElement>('.m-agent-history header button')?.focus({ preventScroll: true });
    else if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  }, [paperBinding, expanded, historyOpen]);
  const inputActions = useInputPreservingActions<HTMLDivElement>(Boolean(paperBinding));
  // The dock floats over the prose: a pan that starts on it must never reach
  // the prose or drag WebKit's keyboard viewport.
  useTouchScrollFence(panelRef, Boolean(paperBinding));
  return (
    <div {...inputActions} ref={panelRef} tabIndex={paperBinding ? -1 : undefined} className="m-agent" role={paperBinding && expanded ? 'dialog' : undefined} aria-modal={paperBinding && expanded ? true : undefined} aria-label={paperBinding ? 'Agent' : undefined}
      onKeyDown={(event) => {
        if (!paperBinding || !expanded || event.key !== 'Tab') return;
        const scope = historyOpen ? panelRef.current?.querySelector('.m-agent-history') : panelRef.current;
        const controls = Array.from(scope?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }} data-paper-agent={paperBinding ? 'true' : undefined} data-expanded={expanded} data-session-selected={paperBinding ? Boolean(activeConvId) : undefined} data-mobile-agent="read-write">
      <header className="m-agent__header">
        <button type="button" aria-current={view === 'chat' ? 'page' : undefined} onClick={() => { if (paperBinding) setHistoryOpen(true); else setView('chat'); }}>
          {activeConversation?.title || t('agentPanel.newConversation')}{paperBinding && <ChevronDown size={14} />}{activeConversation?.branchLabel ? ` · ${activeConversation.branchLabel}` : ''}
        </button>
        <button type="button" aria-current={view === 'memory' ? 'page' : undefined} onClick={() => setView('memory')}>
          {t('agentPanel.toolbar.workingMemory')}
        </button>
        <span />
        {view === 'chat' && <AgentContextIndicator snapshot={contextUsage} />}
        {view === 'chat' && (
          <button type="button" onClick={() => setHistoryOpen(true)}>
            {t('agentPanel.toolbar.history')} · {convList.length}
          </button>
        )}
      </header>

      {view === 'memory' ? (
        <AgentWorkingMemoryView key={projectId} projectId={projectId} />
      ) : (
        <>
          {!paperBinding && <ContextChips refs={turnContext} />}
          {paperBinding && !expanded && <div className="m-paper-agent__recent" aria-label={t('mobileWorkspace.paperAgent.recent')}>
            <div><span>{t('mobileWorkspace.paperAgent.recent')}</span><button type="button" onClick={() => setHistoryOpen(true)}>{t('mobileWorkspace.paperAgent.allSessions')}</button></div>
            {convList.slice(0, 3).map((conversation) => <button type="button" key={conversation.id} disabled={paperBinding.loading} onClick={() => chooseConversation(conversation.id)}>{runningTurns[conversation.id] ? '● ' : ''}{conversation.title || t('agentPanel.history.untitled')}</button>)}
          </div>}
          {!usable && (
            <div className="m-agent__provider-state" data-state={status === null ? 'loading' : 'error'}>
              <span>
                {status === null
                  ? t('agentPanel.checking')
                  : api.capability.available
                    ? t('agentPanel.setup.title')
                    : t('agentPanel.unavailableTitle')}
              </span>
              {status !== null && (
                <button
                  type="button"
                  onClick={() => navigate('/settings', { state: { from: location.pathname } })}
                >
                  {t('agentPanel.setup.openSettings')}
                </button>
              )}
            </div>
          )}

          <MobileAgentTranscript key={`${projectId}:${activeConvId ?? 'new'}`} projectId={projectId} conversationId={activeConvId} ref={transcriptRef} />

          {paperBinding ? (
            <MobilePaperAgentComposer value={prompt} onChange={paperBinding.setPrompt} textAreaRef={setComposerRef}
              onBack={onClose ?? (() => undefined)} disabled={historyUnavailable || Boolean(pendingControl?.requiresContinuation)} readOnly={starting}
              placeholder={historyUnavailable ? t(`agentPanel.historySync.${activeConversation?.syncState}`) : t('mobileWorkspace.paperAgent.placeholder')}
              feedback={composerFeedback} controls={composerControls} />
          ) : (
            <div className="m-agent__composer">
              {composerFeedback}
              <div className="agt-composer">
                <textarea ref={setComposerRef} className="agt-composer__text" aria-label={t('agentPanel.composer.placeholder')}
                  data-debug-id="mobile-agent-composer" value={prompt} rows={1}
                  disabled={historyUnavailable || !usable || starting || Boolean(pendingControl?.requiresContinuation)}
                  placeholder={historyUnavailable ? t(`agentPanel.historySync.${activeConversation?.syncState}`) : usable ? t('agentPanel.composer.placeholder') : t('agentPanel.setup.title')}
                  onChange={(event) => setPrompt(event.target.value)} />
                <div className="agt-composer__bar">{composerControls}</div>
              </div>
            </div>
          )}
        </>
      )}

      {historyOpen && (
        <div className="m-agent-history" role="dialog" aria-label={t('agentPanel.toolbar.historyTitle')}>
          <header>
            <strong>{t('agentPanel.toolbar.history')}</strong>
            <button type="button" onClick={() => chooseConversation(null)}>
              ＋ {t('agentPanel.newConversation')}
            </button>
            <button type="button" onClick={() => setHistoryOpen(false)} aria-label={t('common.close')}>
              ×
            </button>
          </header>
          <div>
            {convList.length === 0 && <div className="m-tool-empty">{t('agentPanel.history.empty')}</div>}
            <input type="search" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder={t('mobileWorkspace.paperAgent.searchSessions')} aria-label={t('mobileWorkspace.paperAgent.searchSessions')} />
            {convList.filter((conversation) => !historyQuery || conversation.title.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase())).map((conversation) => (
              <article key={conversation.id} data-active={conversation.id === activeConvId || undefined}>
                <button type="button" disabled={paperBinding?.loading} onClick={() => chooseConversation(conversation.id)}>
                  <strong>{runningTurns[conversation.id] ? '● ' : ''}{conversation.title || t('agentPanel.history.untitled')}{conversation.branchLabel ? ` · ${conversation.branchLabel}` : ''}</strong>
                  <span>{relTime(conversation.updatedAt)}</span>
                </button>
                <button type="button" aria-label={t('agentPanel.history.delete')} onClick={() => void deleteConversation(conversation.id)}>
                  ×
                </button>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
