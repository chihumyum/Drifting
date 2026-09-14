import { forwardRef, memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v7 as uuidv7 } from 'uuid';
import type { AgentChatMessage } from '../../../domain/agent-conversation';
import { createPlainCommentDoc } from '../../../domain/comment';
import { useAgentMessageBlocks, type AgentMessageBlock } from '../../../features/agent/useAgentMessageBlocks';
import { useAgentTranscriptSummary } from '../../../features/agent/useAgentTranscriptSummary';
import { useAgentChatTranscript } from '../../../features/agent/useAgentChatMessages';
import { useWorkspaceNavigator } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import { MessageView, PendingRow, RuntimeControlCard, STREAM_FOLLOW_BOTTOM_THRESHOLD_PX } from '../../../features/agent/AgentMessageViews';
import { useAuthStore } from '../../../store/auth';
import { useDataStore } from '../../../store/data-store';
import { selectControlStatus, selectPendingControl, selectRunning, useAgentChatStore } from '../../../store/agent-chat-store';
import { useBookNode } from '../../../usecase/useBookNode';
import { useComment } from '../../../usecase/useComment';
import { scrollToBlockWhenReady } from '../../../lib/scroll-to-block';
import { collectMobileAgentEvidence, mobileAgentContextBefore, mobileAgentOutputProseJson, mobileAgentOutputTitle,
  mobileAgentTodoAnchor, openMobileAgentEvidence, type MobileAgentEvidenceRef } from './mobile-agent-model';
import { ContextChips } from './MobileAgentContextChips';

type OutputAction = 'copy' | 'inspiration' | 'todo';
interface OutputFeedback { owner: OutputOwner; message: AgentChatMessage; text: string; pending: boolean }
interface OutputOwner { projectId: string; conversationId: string | null; userId: string; alive: boolean; pending: Map<AgentChatMessage, object> }
export interface MobileAgentTranscriptHandle { follow(): void }

const MobileAgentMessage = memo(function MobileAgentMessage({ message, index, feedback, onAction }: {
  message: AgentChatMessage; index: number; feedback?: OutputFeedback;
  onAction(index: number, action: OutputAction, message: AgentChatMessage): Promise<void>;
}) {
  const { t } = useTranslation();
  return <div className="m-agent__message" data-kind={message.kind}>
    {message.kind === 'user' && message.context && <ContextChips refs={message.context} />}
    <MessageView msg={message} />
    {message.kind === 'assistant' && !message.streaming && message.text.trim() && (
      <div className="m-agent-output-actions" aria-label={t('agentPanel.mobile.actionsAria')}>
        <button type="button" disabled={feedback?.pending} onClick={() => void onAction(index, 'copy', message)}>{t('agentPanel.mobile.action.copy')}</button>
        <button type="button" disabled={feedback?.pending} onClick={() => void onAction(index, 'inspiration', message)}>{t('agentPanel.mobile.action.inspiration')}</button>
        <button type="button" disabled={feedback?.pending} onClick={() => void onAction(index, 'todo', message)}>{t('agentPanel.mobile.action.todo')}</button>
        {feedback && <span role="status">{feedback.text}</span>}
      </div>
    )}
  </div>;
});

const MobileMessageBlock = memo(function MobileMessageBlock({ block, actionState, owner, onAction }: {
  block: AgentMessageBlock; actionState: Record<number, OutputFeedback>; owner: OutputOwner;
  onAction(index: number, action: OutputAction, message: AgentChatMessage): Promise<void>;
}) {
  return <>{block.messages.map((message, offset) => {
    const index = block.start + offset;
    const feedback = actionState[index];
    return <MobileAgentMessage key={index} message={message} index={index}
      feedback={feedback?.owner === owner && feedback.message === message ? feedback : undefined} onAction={onAction} />;
  })}</>;
});

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

/** Mobile output actions and scroll state belong to the displayed conversation.
 * Canonical ingestion and already-started local writes outlive this view. */
export const MobileAgentTranscript = memo(forwardRef<MobileAgentTranscriptHandle, { projectId: string; conversationId: string | null }>(function MobileAgentTranscript({ projectId, conversationId }, ref) {
  const { t } = useTranslation();
  const messages = useAgentChatTranscript();
  const messageBlocks = useAgentMessageBlocks(messages);
  const summary = useAgentTranscriptSummary(messageBlocks);
  const running = useAgentChatStore(selectRunning);
  const starting = useAgentChatStore(state => state.starting);
  const pendingControl = useAgentChatStore(selectPendingControl);
  const controlStatus = useAgentChatStore(selectControlStatus);
  const respondPermission = useAgentChatStore(state => state.respondPermission);
  const cancelRecoveredControl = useAgentChatStore(state => state.cancelRecoveredControl);
  const userId = useAuthStore(state => state.user?.id) ?? '';
  const { createNode } = useBookNode({ projectId, userId });
  const { createComment } = useComment({ projectId, userId });
  const { open } = useWorkspaceNavigator();
  // Tool targets resolve against current workspace state on each display update.
  // Only immutable message classification is cached, not entity IDs or results.
  const evidence = useMemo(() => messages.length ? collectMobileAgentEvidence(summary.successfulTools) : [], [messages, summary]);
  const [actionState, setActionState] = useState<Record<number, OutputFeedback>>({});
  const owner = useMemo<OutputOwner>(() => ({ projectId, conversationId, userId, alive: false, pending: new Map() }), [projectId, conversationId, userId]);
  useLayoutEffect(() => {
    owner.alive = true;
    return () => { owner.alive = false; owner.pending.clear(); };
  }, [owner]);
  const runOutputAction = useCallback(async (index: number, action: OutputAction, message: AgentChatMessage) => {
    const sourceCurrent = () => {
      const state = useAgentChatStore.getState();
      return state.boundProjectId === owner.projectId && state.activeConvId === owner.conversationId
        && (useAuthStore.getState().user?.id ?? '') === owner.userId
        && owner.conversationId !== null && state.runs[owner.conversationId]?.transcript.at(index) === message;
    };
    if (!owner.alive || owner.pending.has(message) || !sourceCurrent() || message.kind !== 'assistant' || message.streaming || !message.text.trim()) return;
    const token = {}; owner.pending.set(message, token);
    const isCurrent = () => owner.alive && owner.pending.get(message) === token && sourceCurrent();
    const show = (text: string, pending = false) => {
      if (isCurrent()) setActionState(current => ({ ...current, [index]: { owner, message, text, pending } }));
    };
    show(t('agentPanel.mobile.action.pending'), true);
    try {
      if (action === 'copy') {
        await navigator.clipboard.writeText(message.text);
        show(t('agentPanel.mobile.action.copied'));
      } else if (action === 'inspiration') {
        const created = await createNode({ kind: 'drift', title: mobileAgentOutputTitle(message.text), initialContentJson: mobileAgentOutputProseJson(message.text, uuidv7) });
        show(t('agentPanel.mobile.action.inspirationDone'));
        if (isCurrent()) open({ entityType: 'node', id: created.id });
      } else {
        const context = mobileAgentContextBefore(useAgentChatStore.getState().runs[owner.conversationId!].transcript.toArray(), index);
        const anchor = mobileAgentTodoAnchor(context);
        await createComment({ kind: 'todo', bodyJson: createPlainCommentDoc(message.text), ...anchor,
          ...(anchor.targetBlockId ? { targetBlockIds: [anchor.targetBlockId] } : {}) });
        show(t('agentPanel.mobile.action.todoDone'));
      }
    } catch (error) {
      show(error instanceof Error ? error.message : t('agentPanel.mobile.action.failed'));
    } finally {
      if (owner.pending.get(message) === token) owner.pending.delete(message);
    }
  }, [owner, createNode, createComment, open, t]);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => {
    if (stickRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [controlStatus, messages, pendingControl]);
  const onScroll = useCallback(() => {
    const el = logRef.current; if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STREAM_FOLLOW_BOTTOM_THRESHOLD_PX;
    if (stickRef.current === bottom) return;
    stickRef.current = bottom; setAtBottom(bottom);
  }, []);
  const jumpToBottom = useCallback(() => {
    const el = logRef.current; if (el) el.scrollTop = el.scrollHeight;
    if (!stickRef.current) { stickRef.current = true; setAtBottom(true); }
  }, []);
  useImperativeHandle(ref, () => ({ follow: jumpToBottom }), [jumpToBottom]);
  const lastMessage = messages.at(messages.length - 1);
  const waiting =
    (running || starting) &&
    !pendingControl &&
    !(
      lastMessage &&
      ((lastMessage.kind === 'assistant' && lastMessage.streaming) ||
        (lastMessage.kind === 'thinking' && lastMessage.streaming) ||
        (lastMessage.kind === 'tool' && lastMessage.status === 'running'))
    );
  return (
          <div className="m-agent__log-wrap">
            <div
              ref={logRef}
              className="m-agent__log"
              onScroll={onScroll}
            >
              {messages.length === 0 && <div className="m-tool-empty">{t('agentPanel.mobile.empty')}</div>}
              {messageBlocks.map(block => <MobileMessageBlock key={block.start} block={block} actionState={actionState} owner={owner} onAction={runOutputAction} />)}
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
                onClick={jumpToBottom}
              >
                {t('agentPanel.mobile.latest')}
              </button>
            )}
          </div>

  );
}));
