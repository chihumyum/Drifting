import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListPlus, MessageSquarePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  commentBelongsToEntity,
  commentIdsRelatedToEntity,
  createPlainCommentDoc,
  type Comment,
  type CommentTargetKind,
} from '../../domain/comment';
import { genericAssociationRelationTypeId } from '../../domain/entity-relation-type';
import { isStructuralEntityKind } from '../../domain/entity-kinds';
import { ReviewItemCard } from '../../features/comments/ReviewItemCard';
import { ComposeTodoDialog } from '../../features/library/LibraryDialogs';
import type { FocusedEntity } from '../../features/library/LibraryPanel';
import { useWorkspaceNavigator } from '../../features/workspace/navigation/WorkspaceNavigationContext';
import {
  addCommentToStickyNoteRail,
  commentStickyNoteRailTarget,
  removeCommentFromStickyNoteRail,
  useStickyNoteRailRegistryRevision,
} from '../../hooks/useEntityStickyNoteRail';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { useComment } from '../../usecase/useComment';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { EmptyState } from '../ui/EmptyState';
import { FilterChip } from '../ui/FilterChip';
import { GhostIconButton } from '../ui/GhostIconButton';
import type { RelationTarget } from './EntityRelationPicker';

type ReviewTypeFilter = 'all' | 'comment' | 'todo';
type ReviewScope = 'current' | 'project';
type ComposeKind = 'note' | 'todo';

interface ReviewPanelProps {
  focused: FocusedEntity;
}

function reviewItemRank(
  comment: Comment,
  focused: FocusedEntity,
  relatedIds: ReadonlySet<string>,
): number {
  const direct = comment.targetKind === focused.kind && comment.targetId === focused.id;
  if (direct && comment.targetBlockId === null) return 0;
  if (direct) return 1;
  return relatedIds.has(comment.id) ? 2 : 3;
}

function canOwnEditorRail(kind: string | null): kind is Exclude<CommentTargetKind, 'patch'> {
  return kind === 'node' || kind === 'element' || kind === 'category' || kind === 'storyline';
}

export function ReviewPanel({ focused }: ReviewPanelProps) {
  const { t } = useTranslation();
  const navigator = useWorkspaceNavigator();
  const projectId = navigator.projectId;
  const userId = useAuthStore((state) => state.user?.id) ?? 'local';
  const comments = useDataStore((state) => state.comments);
  const entityRelations = useDataStore((state) => state.entityRelations);
  const commentUsecases = useComment({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });
  const [typeFilter, setTypeFilter] = useState<ReviewTypeFilter>('all');
  const [scope, setScope] = useState<ReviewScope>('current');
  const [composeKind, setComposeKind] = useState<ComposeKind | null>(null);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const [compactToolbar, setCompactToolbar] = useState(false);
  useStickyNoteRailRegistryRevision();
  const hasCurrentScope = isStructuralEntityKind(focused.kind) && Boolean(focused.id);
  const effectiveScope: ReviewScope = hasCurrentScope ? scope : 'project';

  useEffect(() => {
    const node = toolbarRef.current;
    if (!node) return;
    const update = () => setCompactToolbar(node.clientWidth < 330);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const genericRelationTypeId = genericAssociationRelationTypeId(projectId);
  const genericRelations = useMemo(
    () =>
      entityRelations.filter(
        (relation) => relation.relationTypeId === genericRelationTypeId,
      ),
    [entityRelations, genericRelationTypeId],
  );
  const refsByComment = useMemo(() => {
    const map = new Map<string, typeof genericRelations>();
    for (const relation of genericRelations) {
      if (relation.fromKind !== 'comment') continue;
      const list = map.get(relation.fromId) ?? [];
      list.push(relation);
      map.set(relation.fromId, list);
    }
    return map;
  }, [genericRelations]);
  const relatedIds = useMemo(
    () =>
      commentIdsRelatedToEntity(
        genericRelations,
        projectId,
        isStructuralEntityKind(focused.kind) ? focused.kind : null,
        focused.id,
      ),
    [focused.id, focused.kind, genericRelations, projectId],
  );

  const matchesType = useCallback(
    (comment: Comment) =>
      typeFilter === 'all' ||
      (typeFilter === 'todo' ? comment.kind === 'todo' : comment.kind !== 'todo'),
    [typeFilter],
  );
  const matchesScope = useCallback(
    (comment: Comment) => {
      if (effectiveScope === 'project' || !isStructuralEntityKind(focused.kind) || !focused.id) {
        return true;
      }
      return commentBelongsToEntity(comment, focused.kind, focused.id, relatedIds);
    },
    [effectiveScope, focused.id, focused.kind, relatedIds],
  );
  const filtered = useMemo(
    () =>
      comments
        .filter(
          (comment) =>
            comment.projectId === projectId &&
            comment.status !== 'converted' &&
            matchesType(comment) &&
            matchesScope(comment),
        )
        .sort((a, b) => {
          const rank =
            reviewItemRank(a, focused, relatedIds) -
            reviewItemRank(b, focused, relatedIds);
          if (rank !== 0) return rank;
          return b.updatedAt.localeCompare(a.updatedAt);
        }),
    [comments, focused, matchesScope, matchesType, projectId, relatedIds],
  );
  const openItems = filtered.filter((comment) => comment.status === 'open');
  const resolvedItems = filtered.filter((comment) => comment.status === 'resolved');

  const railTargetFor = (comment: Comment) => {
    if (canOwnEditorRail(comment.targetKind) && comment.targetId) {
      return { kind: comment.targetKind, id: comment.targetId };
    }
    const structuralRelations = (refsByComment.get(comment.id) ?? []).filter(
      (relation) => canOwnEditorRail(relation.toKind),
    );
    const relationTarget =
      structuralRelations.find(
        (relation) => relation.toKind === focused.kind && relation.toId === focused.id,
      ) ?? structuralRelations[0];
    if (relationTarget && canOwnEditorRail(relationTarget.toKind)) {
      return { kind: relationTarget.toKind, id: relationTarget.toId };
    }
    if (canOwnEditorRail(focused.kind) && focused.id) {
      return { kind: focused.kind, id: focused.id };
    }
    return null;
  };

  const toggleSticky = (comment: Comment) => {
    const mounted = commentStickyNoteRailTarget(comment.id);
    if (mounted) {
      removeCommentFromStickyNoteRail(mounted.kind, mounted.id, comment.id);
      return;
    }
    const target = railTargetFor(comment);
    if (!target) return;
    addCommentToStickyNoteRail(target.kind, target.id, comment.id);
    navigator.open({ entityType: target.kind, id: target.id });
  };

  const createItem = async (body: string, relations: RelationTarget[]) => {
    if (!composeKind) return;
    const directTarget =
      composeKind === 'note' && isStructuralEntityKind(focused.kind) && focused.id
        ? { targetKind: focused.kind, targetId: focused.id }
        : {};
    const created = await commentUsecases.createComment({
      ...directTarget,
      kind: composeKind,
      bodyJson: createPlainCommentDoc(body),
    });
    for (const relation of relations) {
      if (
        created.targetKind === relation.kind &&
        created.targetId === relation.id
      ) {
        continue;
      }
      await relationUsecases.addGenericAssociation(
        'comment',
        created.id,
        relation.kind,
        relation.id,
      );
    }
    setComposeKind(null);
  };

  const renderCard = (comment: Comment) => {
    const relations = refsByComment.get(comment.id) ?? [];
    const mounted = commentStickyNoteRailTarget(comment.id) !== null;
    return (
      <ReviewItemCard
        key={comment.id}
        comment={comment}
        projectId={projectId}
        presentation="panel"
        mountedInStickyRail={mounted}
        relations={relations.map((relation) => ({
          id: relation.id,
          toKind: relation.toKind,
          toId: relation.toId,
        }))}
        onToggleStickyRail={railTargetFor(comment) !== null || mounted ? () => toggleSticky(comment) : undefined}
        onAddRelation={(target) =>
          relationUsecases.addGenericAssociation('comment', comment.id, target.kind, target.id)
        }
        onRemoveRelation={(target) => {
          const relation = relations.find(
            (candidate) =>
              candidate.toKind === target.kind && candidate.toId === target.id,
          );
          if (relation) void relationUsecases.removeRelation(relation.id);
        }}
      />
    );
  };

  return (
    <section className="review-panel" aria-label={t('reviewPanel.title')}>
      <header ref={toolbarRef} className="review-panel__toolbar workspace-panel-header-row">
        <div
          className="review-panel__type-filters"
          role="group"
          aria-label={t('reviewPanel.type')}
        >
          {(['all', 'comment', 'todo'] as const).map((filter) => (
            <FilterChip
              key={filter}
              active={typeFilter === filter}
              shape="square"
              size="sm"
              onClick={() => setTypeFilter(filter)}
            >
              {t(`reviewPanel.${compactToolbar ? 'filtersCompact' : 'filters'}.${filter}`)}
            </FilterChip>
          ))}
        </div>

        <button
          type="button"
          className="review-panel__scope-toggle"
          aria-label={`${t('reviewPanel.scope')}: ${t(`reviewPanel.scopes.${effectiveScope}`)}`}
          aria-pressed={effectiveScope === 'current'}
          disabled={!hasCurrentScope}
          onClick={() => setScope(effectiveScope === 'current' ? 'project' : 'current')}
        >
          {t(`reviewPanel.scopes.${effectiveScope}`)}
        </button>

        <span className="review-panel__toolbar-spacer" />
        <div className="review-panel__create-actions">
          <GhostIconButton
            size="sm"
            icon={<MessageSquarePlus size={12} strokeWidth={1.6} />}
            onClick={() => setComposeKind('note')}
            title={t('reviewPanel.newComment')}
            aria-label={t('reviewPanel.newComment')}
          />
          <GhostIconButton
            size="sm"
            icon={<ListPlus size={12} strokeWidth={1.6} />}
            onClick={() => setComposeKind('todo')}
            title={t('todoPanel.newTodo')}
            aria-label={t('todoPanel.newTodo')}
          />
        </div>
      </header>

      <div className="review-panel__list scroll-no-bar workspace-list">
        {openItems.length === 0 && <EmptyState density="compact" message={t('reviewPanel.empty')} />}
        {openItems.map(renderCard)}
        {resolvedItems.length > 0 && (
          <details className="review-panel__resolved">
            <summary>{t('reviewPanel.resolved', { count: resolvedItems.length })}</summary>
            <div className="review-panel__resolved-list">{resolvedItems.map(renderCard)}</div>
          </details>
        )}
      </div>

      {composeKind && (
        <ComposeTodoDialog
          focused={focused}
          kind={composeKind}
          onCancel={() => setComposeKind(null)}
          onCreate={createItem}
        />
      )}
    </section>
  );
}
