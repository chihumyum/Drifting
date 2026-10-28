import { useSidebarPreference, useSidebarPanelState } from '../../hooks/useSidebarPanelState';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  commentBelongsToEntity,
  commentIdsRelatedToEntity,
  createPlainCommentDoc,
  type Comment,
  type CommentTargetKind,
} from '../../domain/comment';
import { genericAssociationRelationTypeId } from '../../domain/entity-relation-type';
import { isCommentTargetKind, isStructuralEntityKind } from '../../domain/entity-kinds';
import { ReviewItemCard } from '../../features/comments/ReviewItemCard';
import {
  groupReviewItems,
  reviewGroupTitle,
  type ReviewGroup,
  type ReviewGroupData,
} from '../../features/comments/review-groups';
import { ComposeTodoDialog } from '../../features/library/LibraryDialogs';
import type { FocusedEntity } from '../../features/library/LibraryPanel';
import { useWorkspaceNavigator } from '../../features/workspace/navigation/WorkspaceNavigationContext';
import { KindMark } from '../ui/KindMark';
import { kindMarkOfTarget } from '../ui/kind-mark';
import {
  addCommentToStickyNoteRail,
  commentStickyNoteRailTarget,
  removeCommentFromStickyNoteRail,
  useStickyNoteRailRegistryRevision,
} from '../../hooks/useEntityStickyNoteRail';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { type ReviewGroupMode, type ReviewScope, type ReviewSortMode } from '../../store/ui-store';
import { useComment } from '../../usecase/useComment';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { EmptyState } from '../ui/EmptyState';
import { FilterChip } from '../ui/FilterChip';
import { GhostIconButton } from '../ui/GhostIconButton';
import { SortMenu, sortMenuGroup } from '../leftBars/SortMenu';
import type { RelationTarget } from './EntityRelationPicker';
import { BrushIcon } from '../ui/BrushIcon';

type ReviewTypeFilter = 'all' | 'comment' | 'todo';
type ComposeKind = 'note' | 'todo';

interface ReviewPanelProps {
  focused: FocusedEntity;
  onOpenAgentTask?: () => string | void;
}

/** Targets whose editor shows a margin comment rail: the prose editors and
 *  material notes (images and PDFs keep their own comment column). */
function canOwnEditorRail(kind: string | null, id: string | null): kind is Exclude<CommentTargetKind, 'patch'> {
  if (kind === 'library_item') {
    return useDataStore.getState().libraryItems.some((item) => item.id === id && item.kind === 'text');
  }
  return kind === 'node' || kind === 'element' || kind === 'category' || kind === 'storyline';
}

const OPENABLE_GROUP_KINDS = new Set<CommentTargetKind>(['node', 'element', 'storyline', 'category', 'library_item']);

export function ReviewPanel({ focused, onOpenAgentTask }: ReviewPanelProps) {
  const { t } = useTranslation();
  const navigator = useWorkspaceNavigator();
  const projectId = navigator.projectId;
  const userId = useAuthStore((state) => state.user?.id) ?? 'local';
  const comments = useDataStore((state) => state.comments);
  const entityRelations = useDataStore((state) => state.entityRelations);
  const commentUsecases = useComment({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });
  const [typeFilter, setTypeFilter] = useSidebarPanelState<ReviewTypeFilter>('typeFilter', 'all');
  const [scope, setScope] = useSidebarPreference('reviewScope');
  const [sortMode, setSortMode] = useSidebarPreference('reviewSortMode');
  const [groupMode, setGroupMode] = useSidebarPreference('reviewGroupMode');
  const [collapsedGroups, setCollapsedGroups] = useSidebarPanelState<string[]>('collapsedGroups', []);
  const bookNodes = useDataStore((state) => state.bookNodes);
  const bookElements = useDataStore((state) => state.bookElements);
  const storylines = useDataStore((state) => state.storylines);
  const bookElementCategories = useDataStore((state) => state.bookElementCategories);
  const libraryItems = useDataStore((state) => state.libraryItems);
  const groupData = useMemo<ReviewGroupData>(
    () => ({ bookNodes, bookElements, storylines, bookElementCategories, libraryItems }),
    [bookElementCategories, bookElements, bookNodes, libraryItems, storylines],
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const [resolvedExpanded, setResolvedExpanded] = useSidebarPanelState('resolvedExpanded', true);
  const [composeKind, setComposeKind] = useState<ComposeKind | null>(null);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const [compactToolbar, setCompactToolbar] = useState(false);
  useStickyNoteRailRegistryRevision();
  // A material tab scopes to its region comments, which target it directly.
  const hasCurrentScope = isCommentTargetKind(focused.kind) && Boolean(focused.id);
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
      if (effectiveScope === 'project' || !isCommentTargetKind(focused.kind) || !focused.id) {
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
          const time = b[sortMode].localeCompare(a[sortMode]);
          return time || a.id.localeCompare(b.id);
        }),
    [comments, matchesScope, matchesType, projectId, sortMode],
  );
  const openItems = filtered.filter((comment) => comment.status === 'open');
  const resolvedItems = filtered.filter((comment) => comment.status === 'resolved');

  const railTargetFor = (comment: Comment) => {
    if (canOwnEditorRail(comment.targetKind, comment.targetId) && comment.targetId) {
      return { kind: comment.targetKind, id: comment.targetId };
    }
    const structuralRelations = (refsByComment.get(comment.id) ?? []).filter(
      (relation) => canOwnEditorRail(relation.toKind, relation.toId),
    );
    const relationTarget =
      structuralRelations.find(
        (relation) => relation.toKind === focused.kind && relation.toId === focused.id,
      ) ?? structuralRelations[0];
    if (relationTarget && canOwnEditorRail(relationTarget.toKind, relationTarget.toId)) {
      return { kind: relationTarget.toKind, id: relationTarget.toId };
    }
    if (canOwnEditorRail(focused.kind, focused.id) && focused.id) {
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
    // Materials cannot be relation targets, so both notes and TODOs about a
    // material target it directly (a comment on the whole image or PDF).
    const directTarget =
      focused.id &&
      ((composeKind === 'note' && isStructuralEntityKind(focused.kind)) || focused.kind === 'library_item')
        ? { targetKind: focused.kind as CommentTargetKind, targetId: focused.id }
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
        onOpenAgentTask={onOpenAgentTask}
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

  const renderGroup = (group: ReviewGroup, section: 'open' | 'resolved') => {
    const collapseKey = `${section}:${group.key}`;
    const collapsed = collapsedGroups.includes(collapseKey);
    const named = group.targetKind && group.targetId ? reviewGroupTitle(groupData, group.targetKind, group.targetId) : null;
    const title = !group.targetKind
      ? t('reviewPanel.groups.floating')
      : named
        ? named.title || t('common.untitled')
        : t(group.targetKind === 'patch' ? 'reviewPanel.groups.patch' : 'reviewPanel.groups.deleted');
    const mark =
      group.targetKind && group.targetKind !== 'patch'
        ? <KindMark kind={kindMarkOfTarget(group.targetKind, named?.isDrift)} seed={group.targetId ?? ''} color="hsl(var(--ink-3))" />
        : '○';
    const openable = Boolean(named && group.targetKind && OPENABLE_GROUP_KINDS.has(group.targetKind));
    const toggle = () =>
      setCollapsedGroups(collapsed ? collapsedGroups.filter((key) => key !== collapseKey) : [...collapsedGroups, collapseKey]);
    return (
      <div key={collapseKey} className="review-group">
        <div className="review-group__header">
          <button
            type="button"
            className={`review-group__toggle${collapsed ? '' : ' review-group__toggle--open'}`}
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'reviewPanel.groups.expand' : 'reviewPanel.groups.collapse', { name: title })}
            onClick={toggle}
          >
            <BrushIcon name="chevron-right" size={11} />
          </button>
          <button
            type="button"
            className="review-group__title"
            disabled={!openable}
            title={openable ? t('reviewPanel.groups.open', { name: title }) : undefined}
            onClick={() => {
              if (openable && group.targetKind && group.targetId && group.targetKind !== 'patch') {
                navigator.open({ entityType: group.targetKind, id: group.targetId });
              }
            }}
          >
            <span className="review-group__glyph" aria-hidden="true">{mark}</span>
            <span className="review-group__name">{title}</span>
          </button>
          <span className="review-group__count">{group.items.length}</span>
        </div>
        {!collapsed && <div className="review-group__items">{group.items.map(renderCard)}</div>}
      </div>
    );
  };

  const renderItems = (items: Comment[], section: 'open' | 'resolved') => {
    if (groupMode === 'flat') return items.map(renderCard);
    const groups = groupReviewItems(items, groupData);
    // One target needs no header (e.g. the current-entity scope).
    if (groups.length === 1) return groups[0]!.items.map(renderCard);
    return groups.map((group) => renderGroup(group, section));
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
            ref={sortButtonRef}
            className="review-panel__sort-button"
            size="sm"
            icon={<BrushIcon name="sort" size={12} />}
            onClick={() => setSortMenuOpen((open) => !open)}
            title={t('leftSidebar.actions.sort')}
            aria-label={t('leftSidebar.actions.sort')}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
          />
          <GhostIconButton
            size="sm"
            icon={<BrushIcon name="comment-plus" size={12} />}
            onClick={() => setComposeKind('note')}
            title={t('reviewPanel.newComment')}
            aria-label={t('reviewPanel.newComment')}
          />
          <GhostIconButton
            size="sm"
            icon={<BrushIcon name="checklist-plus" size={12} />}
            onClick={() => setComposeKind('todo')}
            title={t('todoPanel.newTodo')}
            aria-label={t('todoPanel.newTodo')}
          />
        </div>
      </header>

      <SortMenu<ReviewSortMode>
        triggerRef={sortButtonRef}
        open={sortMenuOpen}
        onClose={() => setSortMenuOpen(false)}
        title={t('leftSidebar.actions.sort')}
        options={[
          { value: 'createdAt', label: t('leftSidebar.sort.createdAt') },
          { value: 'updatedAt', label: t('leftSidebar.sort.updatedAt') },
        ]}
        value={sortMode}
        onChange={setSortMode}
        groups={[
          sortMenuGroup<ReviewGroupMode>({
            title: t('reviewPanel.groupBy.title'),
            options: [
              { value: 'target', label: t('reviewPanel.groupBy.target') },
              { value: 'flat', label: t('reviewPanel.groupBy.flat') },
            ],
            value: groupMode,
            onChange: setGroupMode,
          }),
        ]}
      />

      <div className="review-panel__list scroll-no-bar workspace-list">
        {openItems.length === 0 && <EmptyState density="compact" message={t('reviewPanel.empty')} />}
        {renderItems(openItems, 'open')}
        {resolvedItems.length > 0 && (
          <details
            className="review-panel__resolved"
            open={resolvedExpanded}
            onToggle={(event) => setResolvedExpanded(event.currentTarget.open)}
          >
            <summary>{t('reviewPanel.resolved', { count: resolvedItems.length })}</summary>
            <div className="review-panel__resolved-list">{renderItems(resolvedItems, 'resolved')}</div>
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
