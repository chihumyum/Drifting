/**
 * Agent panel — the interactive Drifting agent, rendered in the right sidebar's
 * "agent" tab group. Styled after the VS Code Claude Code plugin: a chat that
 * streams assistant text token-by-token, renders it as markdown, shows the
 * agent's tool calls, keeps a local history of past conversations, and exposes
 * a quick model switcher under the input.
 *
 * The conversation state + the agent-event subscription live in a module-level
 * store (useAgentChatStore), so this view survives the panel unmounting on tab
 * switches and streaming keeps flowing while it's not mounted. This component is
 * a thin projection: render + local UI concerns (scroll, history dropdown).
 *
 * Provider/model/reasoning selection lives in this composer. API keys are
 * managed once in Settings → 模型与 API; a missing selected-provider key links
 * there instead of creating another credential form in the chat surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useSettingsStore,
} from '../../../store/settings-store';
import {
  useAgentChatStore,
  selectAutomaticContinuation,
  selectAgentTaskContinuationReason,
  selectContextUsage,
  selectControlStatus,
  selectMessages,
  selectPendingControl,
  selectRunning,
} from '../../../store/agent-chat-store';
import { useAgentActivityStore } from '../../../store/agent-activity-store';
import { useWorkspaceNavigator } from '../../workspace/navigation/WorkspaceNavigationContext';
import { useAutosizeTextArea } from '../../../hooks/useAutosizeTextArea';
import {
  collectTurnEntityRefs,
  type ToolEntityRef,
} from '../../../lib/agent/tool-entity-ref';
import { events } from '../../../lib/events';
import type { GeneralAgentAuthStatus } from '../../../lib/agent/protocol';
import { generalAgentTransport } from '../../../lib/agent/transport';
import type { AgentConversationSummary } from '../../../domain/agent-conversation';
import { AnchoredPopover } from '../../../components/ui/AnchoredPopover';
import { AgentContextIndicator } from '../../../components/agent/AgentContextIndicator';
import '../../../../styles/agent-panel.css';
import {
  EntityLinkChip,
  MessageView,
  PendingRow,
  RuntimeControlCard,
  STREAM_FOLLOW_BOTTOM_THRESHOLD_PX,
  fmtCost,
  fmtTokens,
  relTime,
} from '../../../features/agent/AgentMessageViews';
import { AgentComposerConfig } from '../../../features/agent/AgentComposerConfig';
import { AgentWorkingMemoryView } from '../../../features/agent/AgentWorkingMemoryView';
import { VoiceDictationButton } from '../../../features/agent/VoiceDictationButton';

export function DesktopAgentPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = generalAgentTransport;
  const agentAuth = useSettingsStore((s) => s.agentAuth);

  // Chat state + actions live in the module store so they persist across the
  // panel unmounting (tab switches) and streaming keeps flowing while unmounted.
  const messages = useAgentChatStore(selectMessages);
  const prompt = useAgentChatStore((s) => s.prompt);
  // Every conversation owns at most one turn; sibling conversations may run in
  // parallel and remain visible through history-row indicators.
  const running = useAgentChatStore(selectRunning);
  const starting = useAgentChatStore((s) => s.starting);
  const controlStatus = useAgentChatStore(selectControlStatus);
  const pendingControl = useAgentChatStore(selectPendingControl);
  const continuationReason = useAgentChatStore(selectAgentTaskContinuationReason);
  const automaticContinuation = useAgentChatStore(selectAutomaticContinuation);
  const contextUsage = useAgentChatStore(selectContextUsage);
  const runningTurns = useAgentChatStore((s) => s.runningTurns);
  const convList = useAgentChatStore((s) => s.convList);
  const activeConvId = useAgentChatStore((s) => s.activeConvId);
  const setPrompt = useAgentChatStore((s) => s.setPrompt);
  const send = useAgentChatStore((s) => s.send);
  const continueTask = useAgentChatStore((s) => s.continueTask);
  const respondPermission = useAgentChatStore((s) => s.respondPermission);
  const stopAfterTool = useAgentChatStore((s) => s.stopAfterTool);
  const cancelRecoveredControl = useAgentChatStore((s) => s.cancelRecoveredControl);
  const newConversation = useAgentChatStore((s) => s.newConversation);
  const loadConversation = useAgentChatStore((s) => s.loadConversation);
  const deleteConversation = useAgentChatStore((s) => s.deleteConversation);
  const renameConversation = useAgentChatStore((s) => s.renameConversation);
  const bindProject = useAgentChatStore((s) => s.bindProject);

  const [status, setStatus] = useState<GeneralAgentAuthStatus | null>(null);
  const [panelView, setPanelView] = useState<'chat' | 'working-memory'>('chat');
  const [showHistory, setShowHistory] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  // Inline rename: the header edits the active conversation; a history row edits
  // whichever entry is `editingItemId`.
  const [editingHeaderId, setEditingHeaderId] = useState<string | null>(null);
  const [headerDraft, setHeaderDraft] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  // Auto-grow the composer from one line up to the CSS max-height (then it scrolls
  // internally). A ref-callback + ResizeObserver (not a one-shot [prompt] effect)
  // so the height is re-measured every mount AND when the textarea regains a real
  // size — e.g. when the right column is switched away and back, which unmounts +
  // remounts this panel. The old [prompt]-only effect re-ran once on remount before
  // the panel had settled its width, so a multi-line draft collapsed to one row.
  const taRef = useAutosizeTextArea(prompt);
  // Whether to keep pinning the view to the bottom during streaming. The user
  // scrolling up sets this false (breaks free); scrolling back to the bottom
  // re-engages it.
  const stickRef = useRef(true);

  const refreshStatus = useCallback(() => {
    if (!api.capability.available) return;
    void api
      .authStatus()
      .then((result) => {
        setStatus(
          result.ok
            ? result.value
            : { byokConnected: false, apiKeyConnected: false, hostedAvailable: false },
        );
      })
      .catch(() =>
        setStatus({ byokConnected: false, apiKeyConnected: false, hostedAvailable: false }),
      );
  }, [api]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Re-check after the user connects/disconnects in Settings.
  useEffect(() => {
    events.on('agent:auth-changed', refreshStatus);
    return () => events.off('agent:auth-changed', refreshStatus);
  }, [refreshStatus]);

  // Bind the active project: loads its history, and resets the live chat only
  // if the project actually changed (a remount with the same project keeps it).
  useEffect(() => {
    bindProject(projectId);
  }, [projectId, bindProject]);

  // Auto-follow the stream only while pinned to the bottom.
  useEffect(() => {
    if (stickRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, pendingControl, controlStatus]);

  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const bottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STREAM_FOLLOW_BOTTOM_THRESHOLD_PX;
    stickRef.current = bottom;
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setAtBottom(true);
  }, []);

  const handleSend = useCallback(() => {
    stickRef.current = true; // sending re-engages auto-follow
    setAtBottom(true);
    void send();
  }, [send]);

  const handleNew = useCallback(() => {
    newConversation();
    setShowHistory(false);
    setEditingHeaderId(null);
    setEditingItemId(null);
    stickRef.current = true;
    setAtBottom(true);
  }, [newConversation]);

  const handleLoad = useCallback(
    (id: string) => {
      void loadConversation(id);
      setShowHistory(false);
      setEditingHeaderId(null);
      setEditingItemId(null);
      stickRef.current = true;
      setAtBottom(true);
    },
    [loadConversation],
  );

  const handleDelete = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void deleteConversation(id);
    },
    [deleteConversation],
  );

  // The active conversation's summary (gives the current session's title). Null
  // until the first turn persists a row — a fresh chat has no name to rename.
  const activeConv = convList.find((c) => c.id === activeConvId) ?? null;
  const sessionName = activeConv
    ? activeConv.title || t('common.untitled')
    : t('agentPanel.newConversation');
  const editingHeader = editingHeaderId !== null && editingHeaderId === activeConvId;
  const automaticContinuationActive =
    automaticContinuation?.status === 'armed' ||
    automaticContinuation?.status === 'evaluating' ||
    automaticContinuation?.status === 'scheduled';

  // Show a "思考中…" placeholder whenever the agent is running but nothing is
  // actively streaming — i.e. the dead-air gaps (right after send, and between a
  // tool finishing and the next token), where there was previously no feedback.
  const lastMsg = messages[messages.length - 1];
  const busyTail =
    !!lastMsg &&
    (((lastMsg.kind === 'assistant' || lastMsg.kind === 'thinking') && lastMsg.streaming) ||
      (lastMsg.kind === 'tool' && lastMsg.status === 'running'));
  const waiting = (running || starting) && !busyTail && !pendingControl;

  // Session totals — summed across the conversation's per-turn usage rows (which
  // persist in the transcript), plus a tool-call count. Drives the footer.
  const sessionUsage = useMemo(() => {
    let inTok = 0;
    let outTok = 0;
    let cost = 0;
    let tools = 0;
    for (const m of messages) {
      if (m.kind === 'usage') {
        inTok += m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens;
        outTok += m.outputTokens;
        cost += m.costUsd;
      } else if (m.kind === 'tool') {
        tools += 1;
      }
    }
    return { inTok, outTok, cost, tools };
  }, [messages]);

  // Entities the agent created/edited this turn → clickable "本轮改动" links.
  const { open: openEntity } = useWorkspaceNavigator();
  const turnRefs = useMemo(
    () => (running ? [] : collectTurnEntityRefs(messages)),
    [messages, running],
  );
  const openRef = useCallback(
    (ref: ToolEntityRef) => {
      openEntity({ entityType: ref.entityType, id: ref.id });
      useAgentActivityStore.getState().clearTouched(ref.entityType, ref.id);
    },
    [openEntity],
  );

  const beginHeaderRename = useCallback(() => {
    if (!activeConv) return;
    setHeaderDraft(activeConv.title || '');
    setEditingHeaderId(activeConv.id);
  }, [activeConv]);

  const commitHeaderRename = useCallback(() => {
    setEditingHeaderId(null);
    const text = headerDraft.trim();
    if (editingHeaderId && text) void renameConversation(editingHeaderId, text);
  }, [editingHeaderId, headerDraft, renameConversation]);

  const beginItemRename = useCallback((c: AgentConversationSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingItemId(c.id);
    setItemDraft(c.title || '');
  }, []);

  const commitItemRename = useCallback(
    (id: string) => {
      setEditingItemId(null);
      const text = itemDraft.trim();
      if (text) void renameConversation(id, text);
    },
    [itemDraft, renameConversation],
  );

  if (!api.capability.available) {
    return (
      <div style={hintBox} role="status">
        <div style={hintTitle}>{t('agentPanel.unavailableTitle')}</div>
        <div style={hintText}>{t('agentPanel.unavailableReason')}</div>
        <div style={hintText}>{t('agentPanel.unavailableFuture')}</div>
      </div>
    );
  }
  if (status === null) {
    return <div style={hintBox}>{t('agentPanel.checking')}</div>;
  }

  const usable =
    agentAuth === 'hosted'
      ? status.hostedAvailable
      : agentAuth === 'apikey'
        ? status.apiKeyConnected
        : status.byokConnected;

  // ---- Not set up → point to Settings (connect / subscribe lives there) ----
  if (!usable) {
    const notConnectedText =
      agentAuth === 'hosted'
        ? t('agentPanel.setup.hosted')
        : agentAuth === 'apikey'
          ? t('agentPanel.setup.apiKey')
          : t('agentPanel.setup.byok');
    return (
      <div style={fillStyle}>
        <style>{panelCss}</style>
        <div className="agt-panel-toolbar workspace-panel-header-row">
          <strong className="agt-toolbar-view-title">
            {t(panelView === 'working-memory' ? 'agentPanel.workingMemory.title' : 'agentPanel.setup.title')}
          </strong>
          <button
            type="button"
            className="agt-toolbar-action"
            onClick={() =>
              setPanelView((view) => (view === 'chat' ? 'working-memory' : 'chat'))
            }
          >
            {t(panelView === 'chat' ? 'agentPanel.toolbar.workingMemory' : 'agentPanel.toolbar.chat')}
          </button>
        </div>
        {panelView === 'working-memory' ? (
          <AgentWorkingMemoryView key={projectId} projectId={projectId} />
        ) : (
          <div style={hintBox}>
            <div style={hintText}>{notConnectedText}</div>
            <button
              type="button"
              style={primaryBtn}
              onClick={() => events.emit('settings:open', { railId: 'models' })}
            >
              {t('agentPanel.setup.openSettings')}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---- Chat ----
  return (
    <div style={fillStyle}>
      <style>{panelCss}</style>
      <div className="agt-panel-toolbar workspace-panel-header-row">
        {panelView === 'working-memory' ? (
          <strong className="agt-toolbar-view-title">{t('agentPanel.workingMemory.title')}</strong>
        ) : editingHeader ? (
          <input
            className="agt-toolbar-title-input"
            value={headerDraft}
            autoFocus
            onChange={(e) => setHeaderDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commitHeaderRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitHeaderRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditingHeaderId(null);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="agt-name agt-toolbar-title"
            onClick={beginHeaderRename}
            disabled={!activeConv}
            title={activeConv ? t('agentPanel.toolbar.renameTitle') : undefined}
          >
            {sessionName}
          </button>
        )}
        <div className="agt-panel-toolbar__right">
          <button
            type="button"
            className="agt-toolbar-action"
            onClick={() =>
              setPanelView((view) => (view === 'chat' ? 'working-memory' : 'chat'))
            }
          >
            {panelView === 'chat'
              ? t('agentPanel.toolbar.workingMemory')
              : t('agentPanel.toolbar.chat')}
          </button>
          {panelView === 'chat' && (
            <>
              <AgentContextIndicator snapshot={contextUsage} />
              <button
                ref={historyTriggerRef}
                type="button"
                className="agt-toolbar-action"
                onClick={() => {
                  setShowHistory((s) => !s);
                }}
                title={t('agentPanel.toolbar.historyTitle')}
                aria-expanded={showHistory}
                aria-haspopup="dialog"
              >
                ☰ {t('agentPanel.toolbar.history')}
                {convList.length ? ` · ${convList.length}` : ''}
              </button>
              <button
                type="button"
                className="agt-toolbar-action"
                onClick={handleNew}
                title={t('agentPanel.toolbar.newTitle')}
              >
                ＋ {t('agentPanel.newConversation')}
              </button>
            </>
          )}
        </div>
      </div>

      {panelView === 'working-memory' && (
        <AgentWorkingMemoryView key={projectId} projectId={projectId} />
      )}

      {panelView === 'chat' && (
        <>

      <AnchoredPopover
        anchorRef={historyTriggerRef}
        open={showHistory}
        onClose={() => setShowHistory(false)}
        placement="bottom-end"
        role="dialog"
        ariaLabel={t('agentPanel.toolbar.historyTitle')}
        maxHeight={280}
        className="menu-surface menu-surface--rich menu-surface--panel agt-history-menu"
        style={historyPanel}
        autoFocus={false}
        restoreFocus={false}
      >
        {convList.length === 0 ? (
          <div style={{ padding: 12, opacity: 0.5, fontSize: 12 }}>
            {t('agentPanel.history.empty')}
          </div>
        ) : (
          convList.map((c) =>
            editingItemId === c.id ? (
              <div key={c.id} style={historyItem} onClick={(e) => e.stopPropagation()}>
                <input
                  style={historyInput}
                  value={itemDraft}
                  autoFocus
                  onChange={(e) => setItemDraft(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onBlur={() => commitItemRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitItemRename(c.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingItemId(null);
                    }
                  }}
                />
              </div>
            ) : (
              <div
                key={c.id}
                style={{ ...historyItem, ...(c.id === activeConvId ? historyItemActive : null) }}
              >
                <button type="button" style={historyLoadButton} onClick={() => handleLoad(c.id)}>
                  <span style={historyTitle}>
                    {runningTurns[c.id] && <span className="agt-history__running-dot" />}
                    {c.title || t('agentPanel.history.untitled')}
                  </span>
                  <span style={historyTime}>{relTime(c.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  style={historyAct}
                  title={t('agentPanel.history.rename')}
                  onClick={(e) => beginItemRename(c, e)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  style={historyAct}
                  title={t('agentPanel.history.delete')}
                  onClick={(e) => handleDelete(c.id, e)}
                >
                  ×
                </button>
              </div>
            ),
          )
        )}
      </AnchoredPopover>

      <div style={logWrap}>
        <div ref={logRef} style={logStyle} onScroll={onScroll}>
          {messages.length === 0 ? (
            <div className="agt-panel-empty">{t('agentPanel.empty.start')}</div>
          ) : (
            messages.map((m, i) => <MessageView key={i} msg={m} />)
          )}
          {waiting && <PendingRow status={controlStatus} />}
          {pendingControl && (
            <RuntimeControlCard
              pending={pendingControl}
              onPermission={(decision, scope) => {
                void respondPermission(decision, scope);
              }}
              onCancelRecovered={() => {
                void cancelRecoveredControl();
              }}
            />
          )}
          {continuationReason && (
            <div className="agt-control-card" role="status">
              <strong>
                {automaticContinuation?.stopReason === 'waiting_review'
                  ? t('agentPanel.autoContinue.waitingReviewTitle')
                  : automaticContinuation?.stopReason === 'no_progress'
                    ? t('agentPanel.autoContinue.noProgressTitle')
                    : continuationReason === 'budget_exceeded'
                      ? t('agentPanel.budget.title', {
                          defaultValue: '本次上下文需要续接',
                        })
                      : t('agentPanel.longTask.title', {
                          defaultValue: '任务计划尚未完成',
                        })}
              </strong>
              <span>
                {automaticContinuation?.stopReason === 'waiting_review'
                  ? t('agentPanel.autoContinue.waitingReviewBody')
                  : automaticContinuation?.stopReason === 'no_progress'
                    ? t('agentPanel.autoContinue.noProgressBody')
                    : continuationReason === 'budget_exceeded'
                      ? t('agentPanel.budget.body', {
                          defaultValue:
                            '已完成的进度会保留。继续后，Agent 会从持久化状态恢复并接着处理。',
                        })
                      : t('agentPanel.longTask.body', {
                          defaultValue:
                            '本轮已正常结束，但同一会话的持久化任务计划仍有未完成内容。你可以继续执行下一步。',
                        })}
              </span>
              <div className="agt-control-card__actions">
                <button
                  type="button"
                  className="agt-control-card__allow"
                  onClick={() => void continueTask()}
                >
                  {t('agentPanel.budget.continue', {
                    defaultValue: '继续此任务',
                  })}
                </button>
              </div>
            </div>
          )}
          {turnRefs.length > 0 && (
            <div className="agt-entity-links">
              <span style={{ opacity: 0.55, fontSize: 11 }}>{t('agentPanel.turnChanges')}</span>
              {turnRefs.map((r) => (
                <EntityLinkChip key={`${r.entityType}:${r.id}`} refItem={r} onOpen={openRef} />
              ))}
            </div>
          )}
        </div>
        {!atBottom && (
          <button
            type="button"
            style={jumpBtn}
            onClick={jumpToBottom}
            title={t('agentPanel.jumpLatest')}
          >
            ↓
          </button>
        )}
      </div>

      {(sessionUsage.outTok > 0 || sessionUsage.tools > 0) && (
        <div style={usageFooter} title={t('agentPanel.usage.sessionTitle')}>
          <span style={{ opacity: 0.7 }}>{t('agentPanel.usage.session')}</span>
          <span>
            ↑{fmtTokens(sessionUsage.inTok)} ↓{fmtTokens(sessionUsage.outTok)}
          </span>
          {sessionUsage.cost > 0 && <span>{fmtCost(sessionUsage.cost)}</span>}
          <span>{t('agentPanel.usage.toolsCount', { count: sessionUsage.tools })}</span>
        </div>
      )}

      <div style={inputArea}>
        <div className="agt-composer">
          <textarea
            ref={taRef}
            className="agt-composer__text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              pendingControl?.status === 'waiting_user' && !pendingControl.requiresContinuation
                ? t('agentPanel.composer.answerPlaceholder')
                : running
                  ? t('agentPanel.composer.steerPlaceholder')
                  : t('agentPanel.composer.placeholder')
            }
            disabled={starting || Boolean(pendingControl?.requiresContinuation)}
            rows={1}
          />
          <div className="agt-composer__bar">
            <AgentComposerConfig />
            <VoiceDictationButton
              projectId={projectId}
              onNeedsSetup={() => events.emit('settings:open', { railId: 'models' })}
            />
            <div className="agt-composer__spacer" />
            {running || automaticContinuationActive ? (
              <>
                <button
                  type="button"
                  className="agt-send agt-send--stop"
                  onClick={() => void stopAfterTool()}
                  disabled={starting}
                  title={t('agentPanel.composer.stopAfterToolTitle')}
                >
                  {t('agentPanel.composer.stop')}
                </button>
                {running && (
                  <button
                    type="button"
                    className="agt-send"
                    onClick={handleSend}
                    disabled={
                      !prompt.trim() ||
                      starting ||
                      controlStatus === 'waiting_permission' ||
                      controlStatus === 'cancelling' ||
                      controlStatus === 'committing'
                    }
                    title={t('agentPanel.composer.steerTitle')}
                  >
                    {pendingControl?.status === 'waiting_user'
                      ? t('agentPanel.composer.answer')
                      : t('agentPanel.composer.steer')}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="agt-send"
                onClick={handleSend}
                disabled={starting || Boolean(pendingControl?.requiresContinuation)}
              >
                {t('agentPanel.composer.send')}
              </button>
            )}
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
}

const fillStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  position: 'relative',
  color: 'hsl(var(--ink-1))',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  lineHeight: 1.5,
};

const historyPanel: React.CSSProperties = {
  maxHeight: 280,
  overflowY: 'auto',
  zIndex: 'var(--z-popover)',
  padding: 4,
};

const historyItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderRadius: 0,
  cursor: 'pointer',
  fontSize: 12,
};

const historyItemActive: React.CSSProperties = {
  background: 'hsl(var(--accent) / 0.12)',
};

const historyTitle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const historyLoadButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 1,
  minWidth: 0,
  border: 0,
  padding: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

const historyTime: React.CSSProperties = {
  fontSize: 10.5,
  opacity: 0.5,
  flexShrink: 0,
};

const historyAct: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  opacity: 0.4,
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
  padding: '0 2px',
  flexShrink: 0,
};

const historyInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: 'inherit',
  fontSize: 12,
  padding: '2px 6px',
  border: '1px solid hsl(var(--accent) / 0.5)',
  borderRadius: 1,
  background: 'hsl(var(--paper))',
  color: 'inherit',
  outline: 'none',
};

const logWrap: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
};

const logStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px 12px 12px',
  fontSize: 12,
  lineHeight: 1.5,
  minHeight: 120,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const jumpBtn: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  right: 12,
  width: 28,
  height: 28,
  borderRadius: 2,
  border: '1px solid hsl(var(--rule))',
  background: 'hsl(var(--paper))',
  color: 'hsl(var(--ink-1))',
  cursor: 'pointer',
  boxShadow: '0 2px 10px hsl(var(--ink-1) / 0.2)',
  fontSize: 14,
  lineHeight: 1,
  zIndex: 10,
};

const inputArea: React.CSSProperties = {
  padding: 10,
  flexShrink: 0,
};

const usageFooter: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  padding: '4px 12px',
  fontSize: 11,
  opacity: 0.6,
  flexShrink: 0,
  borderTop: '1px solid hsl(var(--rule))',
  fontVariantNumeric: 'tabular-nums',
};

const primaryBtn: React.CSSProperties = {
  background: 'hsl(var(--accent))',
  color: 'white',
  border: 'none',
  borderRadius: 2,
  padding: '4px 8px',
  fontSize: 10.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const hintBox: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 12px',
  fontSize: 11.5,
  alignItems: 'flex-start',
};

const hintTitle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.04em',
  color: 'hsl(var(--ink-1))',
};

const hintText: React.CSSProperties = {
  fontSize: 11.5,
  opacity: 0.8,
  lineHeight: 1.5,
};

// Markdown element styling + streaming caret. Scoped under .agent-md so it only
// touches assistant bubbles. Descendant selectors can't be expressed as inline
// styles, hence a small stylesheet rendered with the panel.
const panelCss = `
.agt-name { transition: color 0.12s ease; }
.agt-name:hover:not(:disabled) { color: hsl(var(--ink-1)); }
.agt-name:disabled { cursor: default; opacity: 0.75; }
.agent-md > :first-child { margin-top: 0; }
.agent-md > :last-child { margin-bottom: 0; }
.agent-md p { margin: 0 0 8px; }
.agent-md ul, .agent-md ol { margin: 0 0 8px; padding-left: 20px; }
.agent-md li { margin: 2px 0; }
.agent-md h1, .agent-md h2, .agent-md h3, .agent-md h4 { margin: 10px 0 6px; font-size: 13.5px; font-weight: 600; }
.agent-md code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; background: hsl(var(--ink-1) / 0.08); padding: 1px 4px; border-radius: 3px; }
.agent-md pre { margin: 0 0 8px; padding: 8px; background: hsl(var(--ink-1) / 0.06); border-radius: 1px; overflow: auto; }
.agent-md pre code { background: none; padding: 0; }
.agent-md blockquote { margin: 0 0 8px; padding: 6px 10px; border-radius: var(--radius-xs); background: hsl(var(--ink-1) / 0.035); opacity: 0.85; }
.agent-md a { color: hsl(var(--accent)); text-decoration: underline; }
.agent-md table { border-collapse: collapse; margin: 0 0 8px; }
.agent-md th, .agent-md td { border: 1px solid hsl(var(--rule)); padding: 3px 6px; }
.agent-caret { display: inline-block; width: 0; opacity: 0.6; animation: agentBlink 1s steps(1) infinite; }
@keyframes agentBlink { 50% { opacity: 0; } }
.agt-pending { display: flex; align-items: center; gap: 5px; padding: 4px 2px; font-size: 12px; opacity: 0.6; }
.agt-pending__dot { width: 5px; height: 5px; border-radius: 50%; background: hsl(var(--ink-1)); animation: agtPendingPulse 1.2s ease-in-out infinite; }
.agt-pending__dot:nth-child(2) { animation-delay: 0.15s; }
.agt-pending__dot:nth-child(3) { animation-delay: 0.3s; }
.agt-pending span:last-child { margin-left: 2px; }
@keyframes agtPendingPulse { 0%, 100% { opacity: 0.25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
.agt-entity-links { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 2px 2px; }
.agt-entity-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: 1px solid hsl(var(--rule)); border-radius: 1px; background: hsl(var(--surface)); color: hsl(var(--ink-1)); font-size: 11.5px; cursor: pointer; transition: background 0.12s, border-color 0.12s; }
.agt-entity-chip:hover { background: hsl(var(--accent) / 0.08); border-color: hsl(var(--accent) / 0.5); }
.agt-entity-chip__glyph { color: hsl(var(--accent)); font-family: var(--font-sans); font-style: italic; }
.agt-entity-chip__op { font-size: 9.5px; opacity: 0.55; }
.agt-history__running-dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: hsl(var(--accent)); flex-shrink: 0; animation: agtHistoryRunPulse 1.4s ease-in-out infinite; }
@keyframes agtHistoryRunPulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1); } }
`;
