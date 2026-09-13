import { forwardRef, memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentMessageBlocks, type AgentMessageBlock } from '../useAgentMessageBlocks';
import { useAgentChatTranscript } from '../useAgentChatMessages';
import { selectAutomaticContinuation, selectAgentTaskContinuationReason, selectControlStatus, selectPendingControl, selectRunning, useAgentChatStore } from '../../../store/agent-chat-store';
import { useAgentActivityStore } from '../../../store/agent-activity-store';
import { useWorkspaceNavigator } from '../../workspace/navigation/WorkspaceNavigationContext';
import { collectTurnEntityRefs, type ToolEntityRef } from '../../../lib/agent/tool-entity-ref';
import { EntityLinkChip, MessageView, PendingRow, RuntimeControlCard, STREAM_FOLLOW_BOTTOM_THRESHOLD_PX, fmtCost, fmtTokens } from '../AgentMessageViews';

const DesktopMessageBlock = memo(function DesktopMessageBlock({ block }: { block: AgentMessageBlock }) {
  return <>{block.messages.map((m, i) => <MessageView key={i} msg={m} />)}</>;
});

export interface AgentTranscriptHandle { follow(): void }

/** The visible transcript owns display subscriptions and scroll state. The
 * canonical run continues independently when this view is unmounted. */
export const DesktopAgentTranscript = memo(forwardRef<AgentTranscriptHandle>(function DesktopAgentTranscript(_props, ref) {
  const { t } = useTranslation();
  const messages = useAgentChatTranscript();
  const messageBlocks = useAgentMessageBlocks(messages);
  const running = useAgentChatStore(selectRunning);
  const starting = useAgentChatStore(s => s.starting);
  const controlStatus = useAgentChatStore(selectControlStatus);
  const pendingControl = useAgentChatStore(selectPendingControl);
  const continuationReason = useAgentChatStore(selectAgentTaskContinuationReason);
  const automaticContinuation = useAgentChatStore(selectAutomaticContinuation);
  const continueTask = useAgentChatStore(s => s.continueTask);
  const respondPermission = useAgentChatStore(s => s.respondPermission);
  const cancelRecoveredControl = useAgentChatStore(s => s.cancelRecoveredControl);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Runs on the actual log mount, including after authentication or returning
  // from working memory. A parent effect can run before this DOM exists.
  useLayoutEffect(() => {
    if (stickRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, pendingControl, controlStatus]);
  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STREAM_FOLLOW_BOTTOM_THRESHOLD_PX;
    if (stickRef.current === bottom) return;
    stickRef.current = bottom;
    setAtBottom(bottom);
  }, []);
  const jumpToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (!stickRef.current) { stickRef.current = true; setAtBottom(true); }
  }, []);
  useImperativeHandle(ref, () => ({ follow: jumpToBottom }), [jumpToBottom]);

  // Show a "思考中…" placeholder whenever the agent is running but nothing is
  // actively streaming — i.e. the dead-air gaps (right after send, and between a
  // tool finishing and the next token), where there was previously no feedback.
  const lastMsg = messages.at(messages.length - 1);
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
    () => (running ? [] : collectTurnEntityRefs(messages.toArray())),
    [messages, running],
  );
  const openRef = useCallback(
    (ref: ToolEntityRef) => {
      openEntity({ entityType: ref.entityType, id: ref.id });
      useAgentActivityStore.getState().clearTouched(ref.entityType, ref.id);
    },
    [openEntity],
  );

  return (<>
      <div style={logWrap}>
        <div ref={logRef} style={logStyle} onScroll={onScroll}>
          {messages.length === 0 ? (
            <div className="agt-panel-empty">{t('agentPanel.empty.start')}</div>
          ) : (
            messageBlocks.map(block => <DesktopMessageBlock key={block.start} block={block} />)
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

  </>);
}));

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
