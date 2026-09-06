import { useInputPreservingActions } from '../../../hooks/useInputPreservingActions';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MobilePaperAgentComposer } from './MobilePaperAgentComposer';
import { useTouchScrollFence } from './useTouchScrollFence';
import type { MobilePaperAgentBinding } from './mobile-paper-agent-session';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { v7 as uuidv7 } from 'uuid';
import type { AgentConversationContextRef } from '../../../domain/agent-conversation';
import { createPlainCommentDoc } from '../../../domain/comment';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useWorkspaceNavigator } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import {
  MessageView,
  PendingRow,
  RuntimeControlCard,
  STREAM_FOLLOW_BOTTOM_THRESHOLD_PX,
  relTime,
} from '../../../features/agent/AgentMessageViews';
import { AgentComposerConfig } from '../../../features/agent/AgentComposerConfig';
import { AgentWorkingMemoryView } from '../../../features/agent/AgentWorkingMemoryView';
import { VoiceDictationButton } from '../../../features/agent/VoiceDictationButton';
import { AgentContextIndicator } from '../../../components/agent/AgentContextIndicator';
import { useAutosizeTextArea } from '../../../hooks/useAutosizeTextArea';
import { events } from '../../../lib/events';
import { getActiveEditor, subscribeActiveEditor } from '../../../lib/active-editor';
import { scrollToBlockWhenReady } from '../../../lib/scroll-to-block';
import {
  isGeneralAgentUsable,
  type GeneralAgentAuthStatus,
} from '../../../lib/agent/protocol';
import { generalAgentTransport } from '../../../lib/agent/transport';
import {
  selectContextUsage,
  selectControlStatus,
  selectMessages,
  selectPendingControl,
  selectRunning,
  useAgentChatStore,
} from '../../../store/agent-chat-store';
import { useAuthStore } from '../../../store/auth';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { useSettingsStore } from '../../../store/settings-store';
import { useBookNode } from '../../../usecase/useBookNode';
import { useComment } from '../../../usecase/useComment';
import {
  buildMobileAgentTurnContext,
  collectMobileAgentEvidence,
  mobileAgentContextBefore,
  mobileAgentOutputProseJson,
  mobileAgentOutputTitle,
  mobileAgentTodoAnchor,
  openMobileAgentEvidence,
  selectedMobileAgentBlockId,
  type MobileAgentEvidenceRef,
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

function ContextChips({ refs }: { refs: readonly AgentConversationContextRef[] }) {
  const { t } = useTranslation();
  const { open } = useWorkspaceNavigator();
  return (
    <div className="m-agent-context-chips" aria-label={t('agentPanel.mobile.contextAria')}>
      {refs.map((ref) => {
        const key = `${ref.kind}:${ref.entityType ?? ''}:${ref.entityId ?? ''}:${ref.blockId ?? ''}`;
        if (ref.kind === 'project' || !ref.entityType || !ref.entityId) {
          return <span key={key}>{t('agentPanel.mobile.contextProject')} · {ref.label}</span>;
        }
        const entityType = ref.entityType;
        const entityId = ref.entityId;
        const handleOpen = () => {
          const target: WorkspaceTarget =
            entityType === 'all-chapters'
              ? { entityType: 'all-chapters', id: 'self' }
              : { entityType, id: entityId };
          open(target);
          if (ref.blockId) scrollToBlockWhenReady(entityId, ref.blockId);
        };
        return (
          <button key={key} type="button" onClick={handleOpen}>
            {ref.blockId ? t('agentPanel.mobile.contextParagraph') : t('agentPanel.mobile.contextCurrent')} · {ref.label}
          </button>
        );
      })}
    </div>
  );
}

function evidenceLabel(evidence: MobileAgentEvidenceRef, deletedLabel: string): string {
  const data = useDataStore.getState();
  const label =
    evidence.entityType === 'node'
      ? data.bookNodes.find((item) => item.id === evidence.entityId)?.title
      : evidence.entityType === 'element'
        ? data.bookElements.find((item) => item.id === evidence.entityId)?.name
        : evidence.entityType === 'storyline'
          ? data.storylines.find((item) => item.id === evidence.entityId)?.name
          : data.bookElementCategories.find((item) => item.id === evidence.entityId)?.name;
  return `${label || deletedLabel}${evidence.blockId ? ` · ${evidence.blockId.slice(0, 8)}` : ''}`;
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
  const userId = useAuthStore((state) => state.user?.id) ?? '';
  const projectName = useProjectStore((state) => state.currentProject?.name) ?? t('agentPanel.mobile.currentProject');
  const agentAuth = useSettingsStore((state) => state.agentAuth);
  const messages = useAgentChatStore(selectMessages);
  const prompt = useAgentChatStore((state) => state.prompt);
  const running = useAgentChatStore(selectRunning);
  const starting = useAgentChatStore((state) => state.starting);
  const pendingControl = useAgentChatStore(selectPendingControl);
  const controlStatus = useAgentChatStore(selectControlStatus);
  const contextUsage = useAgentChatStore(selectContextUsage);
  const convList = useAgentChatStore((state) => state.convList);
  const activeConvId = useAgentChatStore((state) => state.activeConvId);
  const runningTurns = useAgentChatStore((state) => state.runningTurns);
  const setPrompt = useAgentChatStore((state) => state.setPrompt);
  const send = useAgentChatStore((state) => state.send);
  const abort = useAgentChatStore((state) => state.abort);
  const respondPermission = useAgentChatStore((state) => state.respondPermission);
  const cancelRecoveredControl = useAgentChatStore((state) => state.cancelRecoveredControl);
  const newConversation = useAgentChatStore((state) => state.newConversation);
  const loadConversation = useAgentChatStore((state) => state.loadConversation);
  const deleteConversation = useAgentChatStore((state) => state.deleteConversation);
  const bindProject = useAgentChatStore((state) => state.bindProject);
  const { open } = useWorkspaceNavigator();
  const bookNode = useBookNode({ projectId, userId });
  const comment = useComment({ projectId, userId });
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
  const evidence = useMemo(() => collectMobileAgentEvidence(messages), [messages]);
  const [status, setStatus] = useState<GeneralAgentAuthStatus | null>(null);
  const [view, setView] = useState<'chat' | 'memory'>('chat');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [actionState, setActionState] = useState<Record<number, string>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
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
  useEffect(() => {
    if (stickRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [controlStatus, messages, pendingControl]);

  const usable = isGeneralAgentUsable(agentAuth, status);
  const lastMessage = messages[messages.length - 1];
  const waiting =
    (running || starting) &&
    !pendingControl &&
    !(
      lastMessage &&
      ((lastMessage.kind === 'assistant' && lastMessage.streaming) ||
        (lastMessage.kind === 'thinking' && lastMessage.streaming) ||
        (lastMessage.kind === 'tool' && lastMessage.status === 'running'))
    );
  const retryable = !running && messages.some((message) => message.kind === 'error');
  const activeConversation = convList.find((conversation) => conversation.id === activeConvId);
  const historyUnavailable = !running && Boolean(activeConversation?.syncState && activeConversation.syncState !== 'ready');

  const handleSend = () => {
    stickRef.current = true;
    setAtBottom(true);
    void send(paperBinding ? { toolAccess: 'read_write' } : { turnContext, toolAccess: 'read_write' });
  };
  const handleRetry = () => {
    const previous = [...messages].reverse().find((message) => message.kind === 'user');
    if (!previous || previous.kind !== 'user') return;
    setPrompt(previous.text);
    void send(paperBinding ? { toolAccess: 'read_write' } : { turnContext: previous.context ?? turnContext, toolAccess: 'read_write' });
  };

  const runOutputAction = async (
    index: number,
    action: 'copy' | 'inspiration' | 'todo',
    text: string,
    context: readonly AgentConversationContextRef[],
  ) => {
    setActionState((current) => ({ ...current, [index]: t('agentPanel.mobile.action.pending') }));
    try {
      if (action === 'copy') {
        await navigator.clipboard.writeText(text);
        setActionState((current) => ({ ...current, [index]: t('agentPanel.mobile.action.copied') }));
        return;
      }
      if (action === 'inspiration') {
        const created = await bookNode.createNode({
          kind: 'drift',
          title: mobileAgentOutputTitle(text),
          initialContentJson: mobileAgentOutputProseJson(text, uuidv7),
        });
        setActionState((current) => ({ ...current, [index]: t('agentPanel.mobile.action.inspirationDone') }));
        open({ entityType: 'node', id: created.id });
        return;
      }
      const anchor = mobileAgentTodoAnchor(context);
      await comment.createComment({
        kind: 'todo',
        bodyJson: createPlainCommentDoc(text),
        ...anchor,
        ...(anchor.targetBlockId ? { targetBlockIds: [anchor.targetBlockId] } : {}),
      });
      setActionState((current) => ({ ...current, [index]: t('agentPanel.mobile.action.todoDone') }));
    } catch (error) {
      setActionState((current) => ({
        ...current,
        [index]: error instanceof Error ? error.message : t('agentPanel.mobile.action.failed'),
      }));
    }
  };

  const chooseConversation = (id: string | null) => {
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

          <div className="m-agent__log-wrap">
            <div
              ref={logRef}
              className="m-agent__log"
              onScroll={(event) => {
                const element = event.currentTarget;
                const bottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight <
                  STREAM_FOLLOW_BOTTOM_THRESHOLD_PX;
                stickRef.current = bottom;
                setAtBottom(bottom);
              }}
            >
              {messages.length === 0 && <div className="m-tool-empty">{t('agentPanel.mobile.empty')}</div>}
              {messages.map((message, index) => (
                <div key={index} className="m-agent__message" data-kind={message.kind}>
                  {message.kind === 'user' && message.context && <ContextChips refs={message.context} />}
                  <MessageView msg={message} />
                  {message.kind === 'assistant' && !message.streaming && message.text.trim() && (
                    <div className="m-agent-output-actions" aria-label={t('agentPanel.mobile.actionsAria')}>
                      <button type="button" onClick={() => void runOutputAction(index, 'copy', message.text, mobileAgentContextBefore(messages, index))}>
                        {t('agentPanel.mobile.action.copy')}
                      </button>
                      <button type="button" onClick={() => void runOutputAction(index, 'inspiration', message.text, mobileAgentContextBefore(messages, index))}>
                        {t('agentPanel.mobile.action.inspiration')}
                      </button>
                      <button type="button" onClick={() => void runOutputAction(index, 'todo', message.text, mobileAgentContextBefore(messages, index))}>
                        {t('agentPanel.mobile.action.todo')}
                      </button>
                      {actionState[index] && <span role="status">{actionState[index]}</span>}
                    </div>
                  )}
                </div>
              ))}
              {waiting && <PendingRow status={controlStatus} />}
              {pendingControl && (
                <RuntimeControlCard
                  pending={pendingControl}
                  onPermission={(decision, scope) => void respondPermission(decision, scope)}
                  onCancelRecovered={() => void cancelRecoveredControl()}
                />
              )}
              {evidence.length > 0 && (
                <section className="m-agent-evidence" aria-label={t('agentPanel.mobile.evidenceAria')}>
                  <strong>{t('agentPanel.mobile.evidenceTitle')}</strong>
                  <div>
                    {evidence.map((item) => (
                      <button
                        key={`${item.entityType}:${item.entityId}:${item.blockId ?? ''}`}
                        type="button"
                        onClick={() =>
                          openMobileAgentEvidence(item, {
                            open,
                            scrollToBlock: scrollToBlockWhenReady,
                          })
                        }
                      >
                        {evidenceLabel(item, t('agentPanel.mobile.target.deleted'))}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
            {!atBottom && (
              <button
                className="m-agent__latest"
                data-debug-id="mobile-agent-latest"
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
                  stickRef.current = true;
                  setAtBottom(true);
                }}
              >
                {t('agentPanel.mobile.latest')}
              </button>
            )}
          </div>

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
