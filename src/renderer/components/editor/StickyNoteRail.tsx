import { revealDesktopAgentView } from '../../store/desktop-agent-navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createPlainCommentDoc, extractTextFromCommentBody, type CommentTargetKind } from '../../domain/comment';
import { genericAssociationRelationTypeId } from '../../domain/entity-relation-type';
import { ReviewItemCard } from '../../features/comments/ReviewItemCard';
import type { EditorCommentRequest } from '../../hooks/useEntityEditor';
import { useEntityStickyNoteRail } from '../../hooks/useEntityStickyNoteRail';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { selectCommentHighlight } from '../../lib/comment-highlight';
import { useComment } from '../../usecase/useComment';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { getPlatformRuntime } from '../../platform/runtime';
import { Button } from '../ui/Button';
import { GhostIconButton } from '../ui/GhostIconButton';
import { BrushIcon } from '../ui/BrushIcon';

interface StickyNoteRailProps {
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  pendingRequest: EditorCommentRequest | null;
  onPendingRequestChange: (request: EditorCommentRequest | null) => void;
}

function StickyNoteComposer({
  request,
  glass,
  onCancel,
  onCreate,
}: {
  request: EditorCommentRequest;
  glass: boolean;
  onCancel: () => void;
  onCreate: (body: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      textareaRef.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = async () => {
    if (creating || !draft.trim()) return;
    setCreating(true);
    try {
      await onCreate(draft.trim());
    } finally {
      setCreating(false);
    }
  };

  const field = (
    <textarea
      ref={textareaRef}
      value={draft}
      rows={4}
      placeholder={t('commentRail.composer.placeholder')}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void submit();
        }
      }}
    />
  );

  return (
    <div className={`review-card review-card--sticky review-card--manual${glass ? ' review-card--glass glass glass--rest' : ''} sticky-note-composer`}>
      <header className="review-card__header">
        <span className="review-card__kind">
          <BrushIcon name="comment-plus" size={12} />
          {t('commentRail.composer.newComment')}
        </span>
        <GhostIconButton
          size="sm"
          className="review-card__close-button"
          icon={<BrushIcon name="close" size={13} />}
          onClick={onCancel}
          aria-label={t('commentRail.actions.cancelComment')}
        />
      </header>
      <div className="review-card__quote">{request.selectedText}</div>
      {/* Desktop: the Agent composer's page-coloured slip and the primary
          glass to add; mobile keeps its old add button. */}
      {glass ? <div className="review-card__slip glass glass--rest glass--field">{field}</div> : field}
      <div className="review-card__editor-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant={glass ? 'primary' : 'default'} disabled={!draft.trim() || creating} onClick={() => void submit()}>
          {t('commentRail.actions.add')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Editor sticky-note rail. Unlike the retired margin projection, this surface
 * never discovers comments by target/relation on its own: it renders only the
 * review items the author explicitly mounted into this editor session.
 */
export function StickyNoteRail({
  projectId,
  targetKind,
  targetId,
  pendingRequest,
  onPendingRequestChange,
}: StickyNoteRailProps) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id) ?? 'local';
  const comments = useDataStore((state) => state.comments);
  const entityRelations = useDataStore((state) => state.entityRelations);
  const commentUsecases = useComment({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });
  const rail = useEntityStickyNoteRail(targetKind, targetId);
  // Desktop notes are floating glass and the toolbar round glass buttons;
  // the paused mobile shell keeps its white cards (components.md, 便笺).
  const glass = !getPlatformRuntime().isMobileShell;
  const stacked = rail.layout === 'stacked';

  const items = useMemo(() => {
    const byId = new Map(
      comments
        .filter((comment) => comment.projectId === projectId)
        .map((comment) => [comment.id, comment]),
    );
    return rail.itemIds.flatMap((id) => {
      const comment = byId.get(id);
      return comment ? [comment] : [];
    });
  }, [comments, projectId, rail.itemIds]);
  const genericRelationTypeId = genericAssociationRelationTypeId(projectId);
  const relationsByComment = useMemo(() => {
    const map = new Map<string, typeof entityRelations>();
    for (const relation of entityRelations) {
      if (
        relation.projectId !== projectId ||
        relation.relationTypeId !== genericRelationTypeId ||
        relation.fromKind !== 'comment'
      ) {
        continue;
      }
      const list = map.get(relation.fromId) ?? [];
      list.push(relation);
      map.set(relation.fromId, list);
    }
    return map;
  }, [entityRelations, genericRelationTypeId, projectId]);

  const relevantPending =
    pendingRequest &&
    pendingRequest.projectId === projectId &&
    pendingRequest.sourceKind === targetKind &&
    pendingRequest.sourceId === targetId
      ? pendingRequest
      : null;

  const createComment = async (body: string) => {
    if (!relevantPending) return;
    const created = await commentUsecases.createComment({
      targetKind,
      targetId,
      targetBlockId: relevantPending.targetBlockId,
      targetBlockIds: relevantPending.targetBlockIds,
      anchorJson: relevantPending.anchorJson,
      bodyJson: createPlainCommentDoc(body),
      authorKind: 'user',
      authorId: userId,
      source: 'manual',
    });
    rail.add(created.id);
    onPendingRequestChange(null);
    // Writing a note is the author's own trace: its anchor is drawn in.
    if (glass) selectCommentHighlight(created.id);
  };

  if (!relevantPending && items.length === 0) return null;

  const first = items[0];
  return (
    <aside
      className={`editor__margin sticky-note-rail sticky-note-rail--${rail.layout}${glass ? ' sticky-note-rail--glass' : ''}`}
      aria-label={t('reviewPanel.stickyRail')}
    >
      <div className="sticky-note-rail__toolbar">
        <span>{t('reviewPanel.stickyCount', { count: items.length })}</span>
        {items.length > 0 && (glass ? (
          // Stacking is a switch with one word; stacked is its selected glass.
          <GhostIconButton
            size="lg"
            glass="round"
            className="glass--rest"
            icon={<BrushIcon name="layers" />}
            onClick={() => rail.setLayout(stacked ? 'expanded' : 'stacked')}
            aria-pressed={stacked}
            title={t('reviewPanel.stackSticky')}
            aria-label={t('reviewPanel.stackSticky')}
          />
        ) : (
          <GhostIconButton
            size="sm"
            icon={stacked ? <BrushIcon name="layers" size={13} /> : <BrushIcon name="chevron-down" size={13} />}
            onClick={() => rail.setLayout(stacked ? 'expanded' : 'stacked')}
            aria-expanded={!stacked}
            title={stacked ? t('reviewPanel.expandSticky') : t('reviewPanel.stackSticky')}
          />
        ))}
        {items.length > 0 && (
          <GhostIconButton
            size={glass ? 'lg' : 'sm'}
            glass={glass ? 'round' : undefined}
            className={glass ? 'glass--rest' : undefined}
            icon={<BrushIcon name="close" size={glass ? undefined : 12} />}
            onClick={rail.clear}
            title={t('reviewPanel.clearSticky')}
            aria-label={t('reviewPanel.clearSticky')}
          />
        )}
      </div>

      {relevantPending && (
        <StickyNoteComposer
          key={`${relevantPending.sourceId}:${relevantPending.targetBlockIds.join(':')}`}
          request={relevantPending}
          glass={glass}
          onCancel={() => onPendingRequestChange(null)}
          onCreate={createComment}
        />
      )}

      {stacked && first ? (
        <button
          type="button"
          className={`sticky-note-stack${glass ? ' sticky-note-stack--glass glass glass--rest glass--surface' : ''}`}
          onClick={() => rail.setLayout('expanded')}
          aria-expanded={false}
          aria-label={t('reviewPanel.expandSticky')}
        >
          {/* Desktop: the notes beneath are only their resting glass lines,
              offset; the top note carries the floating plate. */}
          <span className="sticky-note-stack__layers" aria-hidden="true">
            {glass && <><i className="glass glass--rest" /><i className="glass glass--rest" /></>}
          </span>
          {glass && <span className="sticky-note-stack__plate" aria-hidden="true" />}
          <span className="sticky-note-stack__kind">
            {first.kind === 'todo' ? 'TODO' : t('reviewPanel.comment')}
          </span>
          <span className="sticky-note-stack__body">
            {extractTextFromCommentBody(first.bodyJson) || t('commentRail.card.emptyComment')}
          </span>
          <span className="sticky-note-stack__count">{items.length}</span>
        </button>
      ) : (
        <div className="sticky-note-rail__list scroll-no-bar">
          {items.map((comment) => (
            <ReviewItemCard
              key={comment.id}
              comment={comment}
              projectId={projectId}
              presentation="sticky"
              onOpenAgentTask={() => revealDesktopAgentView()}
              relations={(relationsByComment.get(comment.id) ?? []).map((relation) => ({
                id: relation.id,
                toKind: relation.toKind,
                toId: relation.toId,
              }))}
              onRemoveFromStickyRail={() => rail.remove(comment.id)}
              onAddRelation={(relation) =>
                relationUsecases.addGenericAssociation(
                  'comment',
                  comment.id,
                  relation.kind,
                  relation.id,
                )
              }
              onRemoveRelation={(target) => {
                const relation = (relationsByComment.get(comment.id) ?? []).find(
                  (candidate) =>
                    candidate.toKind === target.kind && candidate.toId === target.id,
                );
                if (relation) void relationUsecases.removeRelation(relation.id);
              }}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
