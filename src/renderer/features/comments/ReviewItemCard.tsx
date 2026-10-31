import { readAgentChatView } from '../../lib/agent/runtime/chat-view-state';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  commentColorKey,
  agentTaskConversationId,
  createPlainCommentDoc,
  extractTextFromCommentBody,
  getBlockSnapshotsFromAnchor,
  isNoteTaskTodo,
  type Comment,
} from '../../domain/comment';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { getPlatformRuntime } from '../../platform/runtime';
import { clearActiveCommentHighlight, selectCommentHighlight, setActiveCommentHighlight } from '../../lib/comment-highlight';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import { useAuthStore } from '../../store/auth';
import { useAgentChatStore } from '../../store/agent-chat-store';
import { useDataStore } from '../../store/data-store';
import { useComment } from '../../usecase/useComment';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import { GhostIconButton } from '../../components/ui/GhostIconButton';
import type { HoverActionGroup } from '../../components/ui/HoverCard';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { CommentSnapshotModal } from './CommentSnapshotModal';
import { CommentBodyEditor } from './CommentBodyEditor';
import { TodoStatusToggle } from './TodoStatusToggle';
import { CommentSourceHoverCard } from './CommentSourceHoverCard';
import { useCommentSourceHover } from './use-comment-source-hover';
import { buildTodoAgentTask } from './todo-agent-task';
import { BrushIcon } from '../../components/ui/BrushIcon';

const launchingTodoTasks = new Set<string>();

function todoTargetName(comment: Comment): string | null {
  const data = useDataStore.getState();
  switch (comment.targetKind) {
    case 'node': return data.bookNodes.find((node) => node.id === comment.targetId)?.title ?? null;
    case 'element': return data.bookElements.find((element) => element.id === comment.targetId)?.name ?? null;
    case 'storyline': return data.storylines.find((storyline) => storyline.id === comment.targetId)?.name ?? null;
    case 'category': return data.bookElementCategories.find((category) => category.id === comment.targetId)?.name ?? null;
    case 'library_item': return data.libraryItems.find((item) => item.id === comment.targetId)?.title ?? null;
    default: return null;
  }
}

export interface ReviewItemRelation {
  id: string;
  toKind: EntityKind;
  toId: string;
}

export interface ReviewItemCardProps {
  comment: Comment;
  projectId: string;
  presentation: 'panel' | 'sticky';
  mountedInStickyRail?: boolean;
  relations?: ReviewItemRelation[];
  onToggleStickyRail?: () => void;
  onRemoveFromStickyRail?: () => void;
  onAddRelation?: (target: RelationTarget) => void;
  onRemoveRelation?: (target: RelationTarget) => void;
  onOpenAgentTask?: () => string | void;
}

function itemIcon(comment: Comment) {
  if (comment.kind === 'todo') return <BrushIcon name="checklist" size={12} />;
  if (comment.source === 'copilot') return <BrushIcon name="shikigami" size={12} />;
  return <BrushIcon name="comment" size={12} />;
}

export function ReviewItemCard({
  comment,
  projectId,
  presentation,
  mountedInStickyRail = false,
  relations = [],
  onToggleStickyRail,
  onRemoveFromStickyRail,
  onAddRelation,
  onRemoveRelation,
  onOpenAgentTask,
}: ReviewItemCardProps) {
  const { t } = useTranslation();
  // The desktop card wears the resting glass line; the paused mobile shell
  // keeps its plate (docs/design-system/components.md, Review 卡).
  const glass = !getPlatformRuntime().isMobileShell;
  const userId = useAuthStore((state) => state.user?.id) ?? 'local';
  const commentActions = useDataStore((state) => state.commentActions);
  const taskConversationId = agentTaskConversationId(commentActions, comment.id);
  const [launchedConversationId, setLaunchedConversationId] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const taskChatId = taskConversationId ?? launchedConversationId;
  const taskRunning = useAgentChatStore((state) => Boolean(taskChatId && state.runningTurns[taskChatId]));
  const navigator = useWorkspaceNavigator();
  const commentUsecases = useComment({ projectId, userId });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const ownedByNote = isNoteTaskTodo(comment);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  // The source card doubles as the item's action card (there is no
  // right-click menu); the ⋯ button shows it at once and hands it the focus.
  const sourceHover = useCommentSourceHover(!editing && !snapshotOpen);
  const [cardRequested, setCardRequested] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  // A card removed under the pointer never receives mouseleave.
  useEffect(() => () => clearActiveCommentHighlight(comment.id), [comment.id]);
  const selectedRelations = useMemo(
    () => new Set(relations.map((relation) => `${relation.toKind}:${relation.toId}`)),
    [relations],
  );
  const text = extractTextFromCommentBody(comment.bodyJson);
  const snapshots = getBlockSnapshotsFromAnchor(comment.anchorJson);
  const color = commentColorKey(comment);
  const isTodo = comment.kind === 'todo';
  const isResolved = comment.status === 'resolved';
  const isConverted = comment.status === 'converted';
  // A reader's comment from a share link (features/share-links) names its reader.
  const readerName = comment.authorKind === 'external' ? comment.authorName?.trim() || null : null;
  const canJump = Boolean(
    comment.targetKind &&
      comment.targetKind !== 'patch' &&
      comment.targetId,
  );

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const jumpToAnchor = () => {
    if (
      !comment.targetKind ||
      comment.targetKind === 'patch' ||
      !comment.targetId
    ) {
      return;
    }
    navigator.open({ entityType: comment.targetKind, id: comment.targetId });
    // The desktop draws the anchor again in sand rather than flashing its block.
    const sand = !getPlatformRuntime().isMobileShell;
    if (sand) selectCommentHighlight(comment.id);
    if (comment.targetBlockId) scrollToBlockWhenReady(comment.targetId, comment.targetBlockId, { flash: !sand });
  };

  const handleTodoTask = async () => {
    if (busy || launchingTodoTasks.has(comment.id)) return;
    setTaskError(null);
    if (taskChatId) {
      try {
        const chat = useAgentChatStore.getState();
        if (chat.boundProjectId !== projectId) chat.bindProject(projectId, { restoreLastConversation: false });
        const viewId = onOpenAgentTask?.() ?? useAgentChatStore.getState().focusedViewId;
        await useAgentChatStore.getState().loadConversation(taskChatId, viewId);
        if (readAgentChatView(useAgentChatStore.getState(), viewId).activeConvId !== taskChatId) {
          setTaskError(t('reviewPanel.agentTaskUnavailable'));
          return;
        }
      } catch {
        setTaskError(t('reviewPanel.agentTaskUnavailable'));
      }
      return;
    }
    const task = buildTodoAgentTask(comment, todoTargetName(comment));
    if (!task) {
      setTaskError(t('reviewPanel.agentTaskUnavailable'));
      return;
    }
    const chat = useAgentChatStore.getState();
    if (chat.boundProjectId !== projectId) chat.bindProject(projectId, { restoreLastConversation: false });
    launchingTodoTasks.add(comment.id);
    setBusy(true);
    try {
      let conversationId: string | null = null;
      await useAgentChatStore.getState().send({
        runtimePrompt: task.prompt,
        background: { title: task.title },
        toolAccess: 'read_write',
        onStarted: (id) => { conversationId = id; },
      });
      if (!conversationId) throw new Error(t('reviewPanel.agentTaskStartFailed'));
      setLaunchedConversationId(conversationId);
      await commentUsecases.recordAgentTaskLaunch(comment.id, conversationId);
    } catch {
      setTaskError(t('reviewPanel.agentTaskStartFailed'));
    } finally {
      launchingTodoTasks.delete(comment.id);
      setBusy(false);
    }
  };

  const startEditing = () => {
    // A note's checklist line owns its text: edit it there.
    if (ownedByNote) jumpToAnchor();
    else setEditing(true);
  };

  const actions: HoverActionGroup[] = [
    {
      key: 'item',
      actions: [
        ...(presentation === 'panel' && onToggleStickyRail
          ? [{
              key: 'sticky',
              label: mountedInStickyRail ? t('reviewPanel.removeSticky') : t('reviewPanel.addSticky'),
              icon: { brush: 'sticky-note' as const },
              onSelect: onToggleStickyRail,
            }]
          : []),
        {
          key: 'edit',
          label: ownedByNote ? t('reviewPanel.editInNote') : t('common.edit'),
          icon: { brush: 'edit' },
          disabled: busy,
          onSelect: startEditing,
        },
        ...(snapshots.length > 0
          ? [{ key: 'source', label: t('reviewPanel.source'), icon: { brush: 'file-text' as const }, onSelect: () => setSnapshotOpen(true) }]
          : []),
      ],
    },
    {
      key: 'status',
      actions: isConverted
        ? []
        : [
            {
              key: 'resolve',
              label: isResolved ? t('commentRail.actions.reopen') : t('commentRail.actions.resolve'),
              icon: { brush: isResolved ? 'rotate' : 'check' },
              disabled: busy,
              onSelect: () => void run(() => isResolved
                ? commentUsecases.reopenComment(comment.id)
                : commentUsecases.resolveComment(comment.id)),
            },
            {
              key: 'convert',
              label: isTodo ? t('commentRail.actions.toNote') : t('commentRail.actions.toTodo'),
              icon: { brush: isTodo ? 'comment' : 'checklist-plus' },
              disabled: busy,
              onSelect: () => void run(() => isTodo
                ? commentUsecases.revertToNote(comment.id)
                : commentUsecases.convertToTodo(comment.id)),
            },
          ],
    },
    {
      key: 'delete',
      actions: [{
        key: 'delete',
        label: t('common.delete'),
        icon: { brush: 'trash' },
        danger: true,
        disabled: busy,
        onSelect: () => void run(() => commentUsecases.deleteComment(comment.id)),
      }],
    },
  ];

  // Hover-only text beside the resolve ring; clicking it hands the TODO to
  // the Agent (or reopens that conversation). No persistent row; on the
  // desktop it is a text button that turns the loader while the Agent works.
  const agentHint = isTodo && !isConverted && (!isResolved || taskChatId) ? (
    <button
      type="button"
      className={`review-card__agent-hint${busy ? ' review-card__agent-hint--busy' : ''}`}
      disabled={busy}
      onClick={() => void handleTodoTask()}
    >
      {glass && (busy || taskRunning) && <BrushIcon name="loader" size={11} className="control-spinner" />}
      {busy
        ? t('reviewPanel.agentTaskStarting')
        : taskChatId
          ? taskRunning
            ? t('reviewPanel.agentTaskRunning')
            : t('reviewPanel.agentTaskOpen')
          : t('reviewPanel.agentTaskStart')}
    </button>
  ) : null;

  const statusToggle = isTodo && !isConverted ? (
    <span className="review-card__status-actions">
      {agentHint}
      <TodoStatusToggle
        resolved={isResolved}
        disabled={busy}
        onToggle={() => void run(() => isResolved
          ? commentUsecases.reopenComment(comment.id)
          : commentUsecases.resolveComment(comment.id))}
      />
    </span>
  ) : null;

  return (
    <>
      <article
        ref={articleRef}
        className={`review-card review-card--${presentation} review-card--${color}${
          glass ? ' review-card--glass glass glass--rest glass--surface' : presentation === 'panel' ? ' workspace-list-row glass glass--surface' : ''
        }${isResolved || isConverted ? ' review-card--resolved' : ''}`}
        data-comment-id={comment.id}
        aria-describedby={sourceHover.anchor ? sourceHover.id : undefined}
        onMouseEnter={(event) => {
          setCardRequested(false);
          sourceHover.onEnter(event.currentTarget);
          setActiveCommentHighlight(comment.id);
        }}
        onMouseLeave={() => {
          sourceHover.onLeave();
          clearActiveCommentHighlight(comment.id);
        }}
        onPointerDownCapture={sourceHover.dismiss}
        onKeyDownCapture={sourceHover.dismiss}
        onContextMenuCapture={sourceHover.dismiss}
      >
      <header className="review-card__header">
        <span className="review-card__kind">
          {itemIcon(comment)}
          {isTodo
              ? 'TODO'
              : readerName
                ? `${t('shareLink.readerBadge')} · ${readerName}`
                : t('reviewPanel.comment')}
        </span>
        {canJump && (
          <button
            type="button"
            className="review-card__text-link-button"
            onClick={jumpToAnchor}
            title={t('reviewPanel.jumpToText')}
            aria-label={t('reviewPanel.jumpToText')}
          >
            <BrushIcon name="arrow-back" size={10} />
          </button>
        )}
        <span className="review-card__status">
          {isConverted
            ? t('reviewPanel.completed')
            : isResolved
              ? t('commentRail.status.resolved')
              : t('commentRail.status.open')}
        </span>
        {presentation === 'panel' && mountedInStickyRail && (
          <span className="review-card__sticky-state" title={t('reviewPanel.inSticky')}>
            <BrushIcon name="sticky-note" size={11} />
          </span>
        )}
        <GhostIconButton
          size="sm"
          className="review-card__menu-button"
          icon={<BrushIcon name="more" size={13} />}
          onClick={(event) => {
            event.stopPropagation();
            setCardRequested(true);
            if (articleRef.current) sourceHover.open(articleRef.current);
          }}
          title={t('common.more')}
          aria-label={t('common.more')}
          aria-expanded={Boolean(sourceHover.anchor)}
          aria-controls={sourceHover.anchor ? sourceHover.id : undefined}
        />
        {presentation === 'sticky' && onRemoveFromStickyRail && (
          <GhostIconButton
            size="sm"
            className="review-card__close-button"
            icon={<BrushIcon name="close" size={13} />}
            onClick={onRemoveFromStickyRail}
            title={t('reviewPanel.removeSticky')}
            aria-label={t('reviewPanel.removeSticky')}
          />
        )}
      </header>

      {editing ? (
        <CommentBodyEditor
          text={text}
          busy={busy}
          onSave={(body) => run(() => commentUsecases.updateCommentBody(comment.id, createPlainCommentDoc(body)))}
          onClose={() => setEditing(false)}
        />
      ) : (
        <div
          className="review-card__body"
          title={ownedByNote ? t('reviewPanel.noteTaskHint') : undefined}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (busy) return;
            sourceHover.dismiss();
            startEditing();
          }}
        >
          {text || t('commentRail.card.emptyComment')}
        </div>
      )}

      {taskError && (
        <div className="review-card__agent-task-error" role="alert">
          {taskError}
        </div>
      )}

      {((onAddRelation && onRemoveRelation) || statusToggle) && (
        <div className="review-card__relations">
          {onAddRelation && onRemoveRelation ? (
            <EntityRelationPicker
              selected={selectedRelations}
              selectedChipMode="toggle"
              onAdd={(target) => onAddRelation?.(target)}
              onRemove={(target) => onRemoveRelation?.(target)}
              trailingAction={statusToggle}
            />
          ) : (
            <div className="todo-card__footer" style={{ justifyContent: 'flex-end' }}>{statusToggle}</div>
          )}
        </div>
      )}

      {snapshotOpen && snapshots.length > 0 && (
        <CommentSnapshotModal
          snapshots={snapshots}
          liveBlockIds={new Set<string>()}
          onClose={() => setSnapshotOpen(false)}
        />
      )}
      </article>

      {sourceHover.anchor && (
        <CommentSourceHoverCard
          comment={comment}
          relations={relations}
          anchor={sourceHover.anchor}
          id={sourceHover.id}
          pointer={sourceHover.card}
          actions={actions}
          onDismiss={sourceHover.dismiss}
          autoFocus={cardRequested}
        />
      )}
    </>
  );
}
