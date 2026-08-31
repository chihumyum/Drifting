import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  EyeOff,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  commentColorKey,
  createPlainCommentDoc,
  extractTextFromCommentBody,
  getBlockSnapshotsFromAnchor,
  type Comment,
} from '../../domain/comment';
import { decodeCopilotMetadata } from '../../domain/copilot-suggestion';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { getActiveEditor } from '../../lib/active-editor';
import {
  getCopilotCapabilityForMetadataKind,
  type CopilotServices,
} from '../../lib/copilot/capability';
import { copilotRuntime } from '../../lib/copilot/runtime';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import { useAuthStore } from '../../store/auth';
import { useBookElement } from '../../usecase/useBookElement';
import { useComment } from '../../usecase/useComment';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import { Button } from '../../components/ui/Button';
import { ContextMenuSurface } from '../../components/ui/ContextMenuSurface';
import { GhostIconButton } from '../../components/ui/GhostIconButton';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { CommentSnapshotModal } from './CommentSnapshotModal';

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
}

function ReviewActionMenuItem({
  icon,
  label,
  onSelect,
  disabled = false,
  danger = false,
  checked,
}: {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      className={`menu-surface__item${danger ? ' menu-surface__item--danger' : ''}`}
      disabled={disabled}
      aria-checked={checked}
      onClick={onSelect}
    >
      <span className="review-card-menu__icon" aria-hidden>
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function itemIcon(comment: Comment) {
  if (comment.kind === 'todo') return <ListTodo size={12} />;
  if (comment.source === 'copilot') return <Sparkles size={12} />;
  return <MessageSquare size={12} />;
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
}: ReviewItemCardProps) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id) ?? 'local';
  const navigator = useWorkspaceNavigator();
  const commentUsecases = useComment({ projectId, userId });
  const { createElement } = useBookElement({ projectId, userId });
  const services = useMemo<CopilotServices>(() => ({ createElement }), [createElement]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => extractTextFromCommentBody(comment.bodyJson));
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number } | null>(null);
  const selectedRelations = useMemo(
    () => new Set(relations.map((relation) => `${relation.toKind}:${relation.toId}`)),
    [relations],
  );
  const text = extractTextFromCommentBody(comment.bodyJson);
  const snapshots = getBlockSnapshotsFromAnchor(comment.anchorJson);
  const color = commentColorKey(comment);
  const isTodo = comment.kind === 'todo';
  const isException = comment.kind === 'exception';
  const isResolved = comment.status === 'resolved';
  const isConverted = comment.status === 'converted';
  const metadata = comment.source === 'copilot' ? decodeCopilotMetadata(comment.metadataJson) : null;
  const capability = metadata ? getCopilotCapabilityForMetadataKind(metadata.kind) : null;
  const summary = capability && metadata ? capability.renderSummary?.(metadata) : null;
  const canJump = Boolean(
    comment.targetKind &&
      comment.targetKind !== 'patch' &&
      comment.targetId &&
      comment.targetBlockId,
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
      !comment.targetId ||
      !comment.targetBlockId
    ) {
      return;
    }
    navigator.open({ entityType: comment.targetKind, id: comment.targetId });
    scrollToBlockWhenReady(comment.targetId, comment.targetBlockId);
  };

  const saveBody = async () => {
    const body = draft.trim();
    if (!body || body === text) {
      setDraft(text);
      setEditing(false);
      return;
    }
    await run(() => commentUsecases.updateCommentBody(comment.id, createPlainCommentDoc(body)));
    setEditing(false);
  };

  const acceptSuggestion = async () => {
    if (!metadata || !capability) return;
    const result = await capability.accept({
      runtime: copilotRuntime,
      services,
      comment,
      metadata,
      projectId,
      userId,
      editor: getActiveEditor(),
    });
    await commentUsecases.acceptCopilotSuggestion(comment.id, result);
  };

  const openActionMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setActionMenu({ x: rect.right, y: rect.bottom + 4 });
  }, []);

  const openContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    setActionMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const selectMenuAction = (action: () => void) => {
    setActionMenu(null);
    action();
  };

  return (
    <>
      <article
        className={`review-card review-card--${presentation} review-card--${color}${presentation === 'panel' ? ' workspace-list-row' : ''}${isResolved || isConverted ? ' review-card--resolved' : ''}`}
        data-comment-id={comment.id}
        onContextMenu={openContextMenu}
      >
      <header className="review-card__header">
        <span className="review-card__kind">
          {itemIcon(comment)}
          {comment.source === 'copilot' && capability
            ? capability.displayName
            : isTodo
              ? 'TODO'
              : isException
                ? t('reviewPanel.exception')
                : t('reviewPanel.comment')}
          {presentation === 'panel' && canJump && (
            <button
              type="button"
              className="review-card__text-link-button"
              onClick={jumpToAnchor}
              title={t('reviewPanel.jumpToText')}
              aria-label={t('reviewPanel.jumpToText')}
            >
              <ArrowLeft size={10} strokeWidth={1.8} aria-hidden />
            </button>
          )}
        </span>
        <span className="review-card__status">
          {isConverted
            ? t('reviewPanel.completed')
            : isResolved
              ? t('commentRail.status.resolved')
              : t('commentRail.status.open')}
        </span>
        {presentation === 'panel' && mountedInStickyRail && (
          <span className="review-card__sticky-state" title={t('reviewPanel.inSticky')}>
            <StickyNote size={11} />
          </span>
        )}
        <GhostIconButton
          size="sm"
          className="review-card__menu-button"
          icon={<MoreHorizontal size={13} />}
          onClick={openActionMenu}
          title={t('common.more')}
          aria-label={t('common.more')}
          aria-haspopup="menu"
          aria-expanded={actionMenu !== null}
        />
        {presentation === 'sticky' && onRemoveFromStickyRail && (
          <GhostIconButton
            size="sm"
            className="review-card__close-button"
            icon={<X size={13} />}
            onClick={onRemoveFromStickyRail}
            title={t('reviewPanel.removeSticky')}
            aria-label={t('reviewPanel.removeSticky')}
          />
        )}
      </header>

      {editing ? (
        <div className="review-card__editor">
          <textarea
            autoFocus
            value={draft}
            rows={4}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(text);
                setEditing(false);
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void saveBody();
              }
            }}
          />
          <div className="review-card__editor-actions">
            <Button size="sm" variant="ghost" onClick={() => { setDraft(text); setEditing(false); }}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" disabled={!draft.trim() || busy} onClick={() => void saveBody()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      ) : canJump ? (
        <button type="button" className="review-card__body review-card__body--link" onClick={jumpToAnchor}>
          {text || t('commentRail.card.emptyComment')}
        </button>
      ) : (
        <div className="review-card__body">{text || t('commentRail.card.emptyComment')}</div>
      )}

      {summary?.subtitle && <div className="review-card__meta">{summary.subtitle}</div>}
      {summary?.evidence && <div className="review-card__evidence">{summary.evidence}</div>}

      {onAddRelation && onRemoveRelation && (
        <div className="review-card__relations">
          <EntityRelationPicker
            selected={selectedRelations}
            selectedChipMode="toggle"
            onAdd={(target) => onAddRelation?.(target)}
            onRemove={(target) => onRemoveRelation?.(target)}
          />
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

      {actionMenu && (
        <ContextMenuSurface
          x={actionMenu.x}
          y={actionMenu.y}
          onClose={() => setActionMenu(null)}
          className="menu-surface--standard review-card-menu"
          dismissOnScroll
          ariaLabel={t('common.more')}
        >
          {presentation === 'panel' && onToggleStickyRail && (
            <ReviewActionMenuItem
              icon={mountedInStickyRail ? <X size={12} /> : <StickyNote size={12} />}
              label={mountedInStickyRail ? t('reviewPanel.removeSticky') : t('reviewPanel.addSticky')}
              checked={mountedInStickyRail}
              onSelect={() => selectMenuAction(onToggleStickyRail)}
            />
          )}
          <ReviewActionMenuItem
            icon={<Pencil size={12} />}
            label={t('common.edit')}
            onSelect={() =>
              selectMenuAction(() => {
                setDraft(text);
                setEditing(true);
              })
            }
          />
          {snapshots.length > 0 && (
            <ReviewActionMenuItem
              icon={<MessageSquare size={12} />}
              label={t('reviewPanel.source')}
              onSelect={() => selectMenuAction(() => setSnapshotOpen(true))}
            />
          )}
          {comment.status === 'open' && comment.source === 'copilot' && !isTodo && capability && (
            <>
              <div className="menu-surface__divider" />
              <ReviewActionMenuItem
                icon={<Check size={12} />}
                label={summary?.actionLabel ?? t('commentRail.actions.accept')}
                disabled={busy}
                onSelect={() => selectMenuAction(() => void run(acceptSuggestion))}
              />
              <ReviewActionMenuItem
                icon={<X size={12} />}
                label={t('commentRail.actions.reject')}
                disabled={busy}
                onSelect={() =>
                  selectMenuAction(() =>
                    void run(() => commentUsecases.rejectCopilotSuggestion(comment.id)),
                  )
                }
              />
            </>
          )}
          {!isConverted && (
            <>
              <div className="menu-surface__divider" />
              <ReviewActionMenuItem
                icon={isResolved ? <RotateCcw size={12} /> : <Check size={12} />}
                label={
                  isResolved ? t('commentRail.actions.reopen') : t('commentRail.actions.resolve')
                }
                disabled={busy}
                onSelect={() =>
                  selectMenuAction(() =>
                    void run(() =>
                      isResolved
                        ? commentUsecases.reopenComment(comment.id)
                        : commentUsecases.resolveComment(comment.id),
                    ),
                  )
                }
              />
              <ReviewActionMenuItem
                icon={<ListTodo size={12} />}
                label={isTodo ? t('commentRail.actions.toNote') : t('commentRail.actions.toTodo')}
                disabled={busy}
                onSelect={() =>
                  selectMenuAction(() =>
                    void run(() =>
                      isTodo
                        ? commentUsecases.revertToNote(comment.id)
                        : commentUsecases.convertToTodo(comment.id),
                    ),
                  )
                }
              />
              {comment.source === 'manual' && (
                <ReviewActionMenuItem
                  icon={<EyeOff size={12} />}
                  label={
                    isException
                      ? t('commentRail.actions.unmarkException')
                      : t('commentRail.actions.markException')
                  }
                  disabled={busy}
                  onSelect={() =>
                    selectMenuAction(() =>
                      void run(() =>
                        commentUsecases.setCommentKind(
                          comment.id,
                          isException ? 'note' : 'exception',
                        ),
                      ),
                    )
                  }
                />
              )}
            </>
          )}
          <div className="menu-surface__divider" />
          <ReviewActionMenuItem
            icon={<Trash2 size={12} />}
            label={t('common.delete')}
            danger
            disabled={busy}
            onSelect={() =>
              selectMenuAction(() => void run(() => commentUsecases.deleteComment(comment.id)))
            }
          />
        </ContextMenuSurface>
      )}
    </>
  );
}
