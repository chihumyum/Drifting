import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Layers3, MessageSquarePlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { createPlainCommentDoc, extractTextFromCommentBody, type CommentTargetKind } from '../../domain/comment';
import { genericAssociationRelationTypeId } from '../../domain/entity-relation-type';
import { ReviewItemCard } from '../../features/comments/ReviewItemCard';
import type { EditorCommentRequest } from '../../hooks/useEntityEditor';
import { useEntityStickyNoteRail } from '../../hooks/useEntityStickyNoteRail';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { useComment } from '../../usecase/useComment';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { Button } from '../ui/Button';
import { GhostIconButton } from '../ui/GhostIconButton';

interface StickyNoteRailProps {
  projectId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  pendingRequest: EditorCommentRequest | null;
  onPendingRequestChange: (request: EditorCommentRequest | null) => void;
}

function StickyNoteComposer({
  request,
  onCancel,
  onCreate,
}: {
  request: EditorCommentRequest;
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

  return (
    <div className="review-card review-card--sticky review-card--manual sticky-note-composer">
      <header className="review-card__header">
        <span className="review-card__kind">
          <MessageSquarePlus size={12} />
          {t('commentRail.composer.newComment')}
        </span>
        <GhostIconButton
          size="sm"
          className="review-card__close-button"
          icon={<X size={13} />}
          onClick={onCancel}
          aria-label={t('commentRail.actions.cancelComment')}
        />
      </header>
      <div className="review-card__quote">{request.selectedText}</div>
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
      <div className="review-card__editor-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" disabled={!draft.trim() || creating} onClick={() => void submit()}>
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
  };

  if (!relevantPending && items.length === 0) return null;

  const first = items[0];
  return (
    <aside
      className={`editor__margin sticky-note-rail sticky-note-rail--${rail.layout}`}
      aria-label={t('reviewPanel.stickyRail')}
    >
      <div className="sticky-note-rail__toolbar">
        <span>{t('reviewPanel.stickyCount', { count: items.length })}</span>
        {items.length > 0 && (
          <GhostIconButton
            size="sm"
            icon={rail.layout === 'stacked' ? <Layers3 size={13} /> : <ChevronDown size={13} />}
            onClick={() => rail.setLayout(rail.layout === 'stacked' ? 'expanded' : 'stacked')}
            aria-expanded={rail.layout === 'expanded'}
            title={
              rail.layout === 'stacked'
                ? t('reviewPanel.expandSticky')
                : t('reviewPanel.stackSticky')
            }
          />
        )}
        {items.length > 0 && (
          <GhostIconButton
            size="sm"
            icon={<X size={12} />}
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
          onCancel={() => onPendingRequestChange(null)}
          onCreate={createComment}
        />
      )}

      {rail.layout === 'stacked' && first ? (
        <button
          type="button"
          className="sticky-note-stack"
          onClick={() => rail.setLayout('expanded')}
          aria-expanded={false}
          aria-label={t('reviewPanel.expandSticky')}
        >
          <span className="sticky-note-stack__layers" aria-hidden="true" />
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
