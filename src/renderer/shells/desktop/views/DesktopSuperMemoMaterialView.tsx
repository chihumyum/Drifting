import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../../store/data-store';
import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { isChapter } from '../../../domain/book-node';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { useAuthStore } from '../../../store/auth';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useSuperViewEscapeStack } from '../../../hooks/useSuperViewEscapeStack';
import { DesktopSuperViewHeader } from '../components/DesktopSuperViewHeader';
import { SuperViewShell } from '../../../components/SuperViewShell';
import { FilterChip } from '../../../components/ui/FilterChip';
import { ContextMenuSurface } from '../../../components/ui/ContextMenuSurface';
import { AnchoredPopover } from '../../../components/ui/AnchoredPopover';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { GhostIconButton } from '../../../components/ui/GhostIconButton';
import { KindMark } from '../../../components/ui/KindMark';
import { kindMarkOfTarget, type KindMarkKind } from '../../../components/ui/kind-mark';
import { LabelMono } from '../../../components/ui/LabelMono';
import { useComment } from '../../../usecase/useComment';
import { useLibraryItem } from '../../../usecase/useLibraryItem';
import { useEntityRelations } from '../../../usecase/useEntityRelations';
import {
  LibraryItemCard,
  ComposeLibraryItemDialog,
  ComposeTodoDialog,
  TodoCard,
  type FocusedEntity,
} from '../../../components/rightBars/MemoMaterialPanel';
import { EntityRelationPicker } from '../../../components/rightBars/EntityRelationPicker';
import { ReviewItemCard } from '../../../features/comments/ReviewItemCard';
import {
  groupReviewItems,
  reviewGroupTitle,
  reviewTargetColor,
  type ReviewGroup,
  type ReviewGroupData,
} from '../../../features/comments/review-groups';
import { TodoStatusToggle } from '../../../features/comments/TodoStatusToggle';
import { useWorkspaceNavigator } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import { libraryItemMatchesQuery } from '../../../features/library/library-item-search';
import { createPlainCommentDoc, extractTextFromCommentBody } from '../../../domain/comment';
import { genericAssociationRelationTypeId } from '../../../domain/entity-relation-type';
import { isStructuralEntityKind } from '../../../domain/entity-kinds';
import type { Comment, CommentTargetKind } from '../../../domain/comment';
import type { LibraryItem, LibraryItemKind } from '../../../domain/library-item';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { stepGlassFlow, trackGlassFlow } from '../../../lib/glass-flow';
import { openLibraryItemInSystem as openInSystemApp } from '../../../features/library/open-library-item';
import { getPlatformRuntime } from '../../../platform/runtime';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import {
  SMM_LIBRARY_MIN,
  SMM_RAIL_KEY_STEP,
  SMM_RAIL_MIN,
  dragRailWidth,
  readRailWidths,
  storeRailWidths,
  type SmmRail,
  type SmmRailWidths,
} from './super-memo-material-rails';
import '../../../../styles/super-memo-material.css';

const KIND_ORDER: LibraryItemKind[] = ['text', 'image', 'pdf'];

const DRAWER_HEADER_HEIGHT = 28;
const DRAWER_MIN_HEIGHT = 120;
const DRAWER_DEFAULT_HEIGHT = 260;

const TODO_RAIL_WIDTH = 280;

/**
 * The desktop draws a piece with its class from super-memo-material.css; the
 * paused mobile shell keeps the inline look it had (and the class hooks its
 * own stylesheet targets), so nothing desktop reaches it.
 */
function look(
  mobileShell: boolean,
  desktopClass: string,
  legacyStyle?: CSSProperties,
  sharedClass?: string,
): { className?: string; style?: CSSProperties } {
  if (mobileShell) return { className: sharedClass, style: legacyStyle };
  return { className: sharedClass ? `${sharedClass} ${desktopClass}` : desktopClass };
}

/**
 * Global TODO & Library workbench — the project-wide counterpart to the
 * per-entity MemoMaterialPanel in the right sidebar.
 *
 * Layout (covering the whole window, same shell as StoryGraphView /
 * SuperElementView):
 *  ┌── header (back · Super tabs · stats · search) ─────────────────┐
 *  ├────────┬────────┬───────────────────────────────────────────────┤
 *  │ TODO  ⇹│ 批注  ⇹│  素材 · kind chips · entity filter · 新建      │
 *  │        │ 按对象 │  LibraryItem 网格 (按 kind 分组)                 │
 *  ├────────┴────────┴───────────────────────────────────────────────┤
 *  │  待整理 (orphan) · 已解决 (archive)                        ▾   │
 *  └─────────────────────────────────────────────────────────────────┘
 *
 * On the desktop it is one plane: the rails and the library share the
 * paper, split by hairlines, and the drawer docks underneath as a strip of
 * the desk colour like the Bottom Panel (drag its top edge to resize when
 * open; the edge bleeds glass while it moves). Each rail's right edge drags
 * the rail wider the same way, and its cards flow into as many columns as
 * fit. The paused mobile shell keeps the single TODO rail. All cards reuse
 * the right-sidebar primitives so actions stay in sync.
 */
export function DesktopSuperMemoMaterialView() {
  const { t } = useTranslation();
  const { projectId, openEntity } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const { setActive: setActiveSuperView } = useSuperViewNavigation();
  const closeView = useCallback(() => setActiveSuperView('none'), [setActiveSuperView]);
  const mobileShell = getPlatformRuntime().isMobileShell;

  const comments = useDataStore((s) => s.comments);
  const libraryItems = useDataStore((s) => s.libraryItems);
  const entityRelations = useDataStore((s) => s.entityRelations);
  const genericRelationTypeId = genericAssociationRelationTypeId(projectId);
  const genericRelations = useMemo(
    () =>
      entityRelations.filter(
        (relation) => relation.relationTypeId === genericRelationTypeId,
      ),
    [entityRelations, genericRelationTypeId],
  );

  const commentUsecases = useComment({ projectId, userId });
  const libraryItemUsecases = useLibraryItem({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });

  const [query, setQuery] = useState('');
  const [hiddenKinds, setHiddenKinds] = useState<Set<LibraryItemKind>>(() => new Set());
  const [entityFilter, setEntityFilter] = useState<FocusedEntity>({ kind: null, id: null });
  const [composeOpen, setComposeOpen] = useState<null | 'todo' | 'note' | 'library_item'>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawerExpanded, setDrawerExpanded] = useState(false);
  const [railWidths, setRailWidths] = useState<SmmRailWidths>(readRailWidths);
  const resizeRail = useCallback(
    (rail: SmmRail, width: number) => {
      const next = { ...railWidths, [rail]: width };
      setRailWidths(next);
      storeRailWidths(next);
    },
    [railWidths],
  );

  // Compose dialogs and material previews consume Escape themselves. The
  // shared stack is also aware of them as a safety net, then falls through to
  // the bottom drawer and finally the Super View root.
  useSuperViewEscapeStack(
    [
      {
        id: `compose:${composeOpen ?? ''}`,
        active: composeOpen !== null,
        onEscape: () => setComposeOpen(null),
      },
      {
        id: 'bottom-drawer',
        active: drawerExpanded,
        onEscape: () => setDrawerExpanded(false),
      },
    ],
    closeView,
  );

  // Group generic associations by from-entity so each card can render its
  // relation chips and the filters can narrow to a specific target.
  const refsByFrom = useMemo(() => {
    const map = new Map<string, typeof genericRelations>();
    genericRelations.forEach((r) => {
      const key = `${r.fromKind}:${r.fromId}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    });
    return map;
  }, [genericRelations]);

  // The shelf holds TODOs and comments (notes); accepted suggestions
  // ('converted') stay out of it, as they do in Review.
  const shelvedComments = useMemo(
    () => comments.filter((c) => c.kind === 'todo' || c.status !== 'converted'),
    [comments],
  );
  const todoCount = useMemo(() => comments.filter((c) => c.kind === 'todo').length, [comments]);
  const noteCount = shelvedComments.length - todoCount;

  // How many TODOs, comments and materials each entity gathers: the entity
  // filter shows it beside each candidate and beside the chosen one. A
  // comment counts toward the entity it is written on and the ones it is
  // related to.
  const targetCounts = useMemo(() => {
    const commentIds = new Set(shelvedComments.map((c) => c.id));
    const itemIds = new Set(libraryItems.map((m) => m.id));
    const sources = new Map<string, Set<string>>();
    const gather = (key: string, from: string) => {
      const gathered = sources.get(key) ?? new Set<string>();
      gathered.add(from);
      sources.set(key, gathered);
    };
    genericRelations.forEach((r) => {
      const counted =
        r.fromKind === 'comment'
          ? commentIds.has(r.fromId)
          : r.fromKind === 'library_item' && itemIds.has(r.fromId);
      if (counted) gather(`${r.toKind}:${r.toId}`, `${r.fromKind}:${r.fromId}`);
    });
    shelvedComments.forEach((c) => {
      if (c.targetKind && c.targetId) gather(`${c.targetKind}:${c.targetId}`, `comment:${c.id}`);
    });
    const counts = new Map<string, number>();
    sources.forEach((from, key) => counts.set(key, from.size));
    return counts;
  }, [shelvedComments, libraryItems, genericRelations]);

  const isRelatedToEntity = useCallback(
    (fromKind: EntityKind, fromId: string) => {
      if (!entityFilter.kind || !entityFilter.id) return true;
      const refs = refsByFrom.get(`${fromKind}:${fromId}`) ?? [];
      return refs.some((r) => r.toKind === entityFilter.kind && r.toId === entityFilter.id);
    },
    [refsByFrom, entityFilter.kind, entityFilter.id],
  );

  const commentMatchesEntity = useCallback(
    (comment: Comment) =>
      (comment.targetKind === entityFilter.kind && comment.targetId === entityFilter.id) ||
      isRelatedToEntity('comment', comment.id),
    [entityFilter.kind, entityFilter.id, isRelatedToEntity],
  );

  const matchesQuery = useCallback(
    (...fields: (string | null | undefined)[]) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return fields.some((f) => (f ?? '').toLowerCase().includes(q));
    },
    [query],
  );

  // TODOs replaced the old memo three-state machine: every TODO is a comment
  // with kind='todo'; status is just open vs. resolved. The pre-consolidation
  // 'no_action' bucket (notes without a checkbox) is gone — free-form notes
  // now live in library_item with kind='text'.
  const openTodos = useMemo(
    () =>
      comments.filter(
        (c) =>
          c.kind === 'todo' &&
          c.status === 'open' &&
          commentMatchesEntity(c) &&
          matchesQuery(extractTextFromCommentBody(c.bodyJson)),
      ),
    [comments, commentMatchesEntity, matchesQuery],
  );

  // Open comments, newest first; the comment rail gathers them under what
  // they are written on, as Review does.
  const openNotes = useMemo(
    () =>
      comments
        .filter(
          (c) =>
            c.kind !== 'todo' &&
            c.status === 'open' &&
            commentMatchesEntity(c) &&
            matchesQuery(extractTextFromCommentBody(c.bodyJson)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
    [comments, commentMatchesEntity, matchesQuery],
  );

  // The archive keeps resolved TODOs and comments alike.
  const resolvedItems = useMemo(
    () =>
      shelvedComments
        .filter(
          (c) =>
            c.status !== 'open' &&
            commentMatchesEntity(c) &&
            matchesQuery(extractTextFromCommentBody(c.bodyJson)),
        )
        .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '')),
    [shelvedComments, commentMatchesEntity, matchesQuery],
  );

  const visibleLibraryItems = useMemo(
    () =>
      libraryItems.filter(
        (mat) => isRelatedToEntity('library_item', mat.id) && libraryItemMatchesQuery(mat, query),
      ),
    [libraryItems, isRelatedToEntity, query],
  );

  const libraryItemsByKind = useMemo(() => {
    const map = new Map<LibraryItemKind, LibraryItem[]>();
    KIND_ORDER.forEach((k) => map.set(k, []));
    visibleLibraryItems.forEach((m) => {
      if (hiddenKinds.has(m.kind)) return;
      map.get(m.kind)?.push(m);
    });
    return map;
  }, [visibleLibraryItems, hiddenKinds]);

  const orphanLibraryItems = useMemo(
    () =>
      visibleLibraryItems.filter((m) => {
        const refs = refsByFrom.get(`library_item:${m.id}`) ?? [];
        return refs.length === 0;
      }),
    [visibleLibraryItems, refsByFrom],
  );

  const openLibraryItemInSystem = useCallback(
    async (m: LibraryItem) => {
      const result = await openInSystemApp(projectId, m);
      if (!result.ok) alert(t('memoMaterial.error.openFile', { error: result.error }));
    },
    [projectId, t],
  );

  // Materials open as workspace tabs; the overlay steps aside so the tab is
  // visible, as the element super view does for elements.
  const openLibraryItemInApp = useCallback(
    (m: LibraryItem) => {
      openEntity({ entityType: 'library_item', id: m.id });
      closeView();
    },
    [closeView, openEntity],
  );

  const toggleKindHidden = useCallback((kind: LibraryItemKind) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const removeRelation = useCallback(
    (fromKind: EntityKind, fromId: string, toKind: EntityKind, toId: string) => {
      const ref = genericRelations.find(
        (r) =>
          r.fromKind === fromKind && r.fromId === fromId && r.toKind === toKind && r.toId === toId,
      );
      if (ref) relationUsecases.removeRelation(ref.id);
    },
    [genericRelations, relationUsecases],
  );

  const focusedEntity: FocusedEntity = entityFilter;

  return (
    <SuperViewShell className="super-mm-overlay">
      {/* Top header — back + Super tabs + stats + global search. LibraryItem-specific
          filters (KIND chips, entity-target filter) live inside the
          LibraryItemMain section header so the global header stays focused
          on cross-cutting controls. */}
      <DesktopSuperViewHeader
        meta={t('memoMaterial.super.meta', {
          todos: todoCount,
          comments: noteCount,
          materials: libraryItems.length,
        })}
        onBack={closeView}
        rightSlot={
          mobileShell ? (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('memoMaterial.super.searchPlaceholder')}
              style={{
                width: 220,
                fontFamily: 'var(--font-sans)',
                fontSize: 12.5,
                padding: '5px 9px',
                border: '1px solid hsl(var(--rule))',
                borderRadius: 3,
                background: 'hsl(var(--paper))',
                color: 'hsl(var(--ink-1))',
                outline: 'none',
              }}
            />
          ) : (
            <label className="ui-field ui-field--sm glass glass--rest glass--field glass--small smm-search">
              <BrushIcon name="search" size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('memoMaterial.super.searchPlaceholder')}
                aria-label={t('memoMaterial.super.searchPlaceholder')}
              />
            </label>
          )
        }
      />

      {/* One continuous body surface wraps the rail/main split and drawer
          above the shared status strip. */}
      <div className="super-view-body">
        <div className="smm-workspace-split" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <TodoRail
            openTodos={openTodos}
            commentUsecases={commentUsecases}
            relationUsecases={relationUsecases}
            entityRelations={genericRelations}
            width={railWidths.todo}
            onResize={(width) => resizeRail('todo', width)}
            onCompose={() => setComposeOpen('todo')}
          />

          {!mobileShell && (
            <CommentRail
              projectId={projectId}
              openNotes={openNotes}
              refsByFrom={refsByFrom}
              relationUsecases={relationUsecases}
              removeRelation={removeRelation}
              width={railWidths.comment}
              onResize={(width) => resizeRail('comment', width)}
              onCompose={() => setComposeOpen('note')}
            />
          )}

          <LibraryItemMain
            libraryItemsByKind={libraryItemsByKind}
            totalVisible={visibleLibraryItems.length}
            totalLibraryItems={libraryItems.length}
            hiddenKinds={hiddenKinds}
            onToggleKind={toggleKindHidden}
            kindCounts={
              Object.fromEntries(
                KIND_ORDER.map((k) => [k, libraryItems.filter((m) => m.kind === k).length]),
              ) as Record<LibraryItemKind, number>
            }
            entityFilter={entityFilter}
            onEntityFilterChange={setEntityFilter}
            targetCounts={targetCounts}
            totalItems={shelvedComments.length + libraryItems.length}
            refsByFrom={refsByFrom}
            editingId={editingId}
            setEditingId={setEditingId}
            libraryItemUsecases={libraryItemUsecases}
            relationUsecases={relationUsecases}
            removeRelation={removeRelation}
            openLibraryItemInApp={openLibraryItemInApp}
            openLibraryItemInSystem={openLibraryItemInSystem}
            onCompose={() => setComposeOpen('library_item')}
          />
        </div>

        <BottomDrawer
          expanded={drawerExpanded}
          onExpandedChange={setDrawerExpanded}
          orphans={orphanLibraryItems}
          resolvedItems={resolvedItems}
          editingId={editingId}
          setEditingId={setEditingId}
          commentUsecases={commentUsecases}
          libraryItemUsecases={libraryItemUsecases}
          relationUsecases={relationUsecases}
          removeRelation={removeRelation}
          openLibraryItemInApp={openLibraryItemInApp}
          openLibraryItemInSystem={openLibraryItemInSystem}
        />
      </div>

      {composeOpen === 'todo' && (
        <ComposeTodoDialog
          focused={focusedEntity}
          onCancel={() => setComposeOpen(null)}
          onCreate={async (body, relations) => {
            const created = await commentUsecases.createComment({
              kind: 'todo',
              bodyJson: createPlainCommentDoc(body),
            });
            await Promise.all(
              relations.map((t) =>
                relationUsecases.addGenericAssociation('comment', created.id, t.kind, t.id),
              ),
            );
            setComposeOpen(null);
          }}
        />
      )}

      {composeOpen === 'note' && (
        <ComposeTodoDialog
          focused={focusedEntity}
          kind="note"
          onCancel={() => setComposeOpen(null)}
          onCreate={async (body, relations) => {
            // As in Review: a comment written while the filter holds an
            // entity is written on that entity, not merely related to it.
            const direct =
              focusedEntity.kind && focusedEntity.id && isStructuralEntityKind(focusedEntity.kind)
                ? { targetKind: focusedEntity.kind as CommentTargetKind, targetId: focusedEntity.id }
                : {};
            const created = await commentUsecases.createComment({
              ...direct,
              kind: 'note',
              bodyJson: createPlainCommentDoc(body),
            });
            await Promise.all(
              relations
                .filter((t) => !(created.targetKind === t.kind && created.targetId === t.id))
                .map((t) =>
                  relationUsecases.addGenericAssociation('comment', created.id, t.kind, t.id),
                ),
            );
            setComposeOpen(null);
          }}
        />
      )}

      {composeOpen === 'library_item' && (
        <ComposeLibraryItemDialog
          focused={focusedEntity}
          onCancel={() => setComposeOpen(null)}
          onCreate={async (input, relations) => {
            const mat = await libraryItemUsecases.createLibraryItem(input);
            const relationResults = await Promise.allSettled(
              relations.map((t) =>
                relationUsecases.addGenericAssociation('library_item', mat.id, t.kind, t.id),
              ),
            );
            const failedRelations = relationResults.filter(
              (result) => result.status === 'rejected',
            );
            if (failedRelations.length > 0) {
              console.warn(
                '[material] material created, but some relations failed:',
                failedRelations,
              );
            }
          }}
        />
      )}

    </SuperViewShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LibraryItem filter primitives — KindChip + EntityFilterButton, both used in
// the LibraryItemMain section header (previously lived in a top toolbar). The
// paused mobile shell still separates the filter groups with a thin vertical
// divider; the desktop separates them with space.

function ToolbarDivider() {
  return (
    <div
      className="smm-todo-rail"
      style={{
        width: 1,
        height: 20,
        background: 'hsl(var(--rule))',
        flexShrink: 0,
      }}
    />
  );
}

const kickerStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: 'hsl(var(--ink-4))',
};

/** A material kind: a Chip on the desktop (FilterChip keeps the paper chip on mobile). */
function KindChip({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <FilterChip
      look="glass"
      size="sm"
      active={active}
      count={count}
      dimmed={count === 0}
      onClick={onClick}
      title={active ? t('memoMaterial.super.hideKind') : t('memoMaterial.super.showKind')}
    >
      {children}
    </FilterChip>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity-target filter. The desktop opens a searchable menu straight from a
// word toggle (one click to the entities); the paused mobile shell keeps the
// popover with EntityRelationPicker constrained to a single-select.

interface EntityFilterProps {
  entityFilter: FocusedEntity;
  onChange: (next: FocusedEntity) => void;
  /** TODOs + materials related to each `${kind}:${id}`. */
  targetCounts: Map<string, number>;
  /** Every TODO and material in the project (the 全部 row). */
  totalItems: number;
}

function EntityFilterButton(props: EntityFilterProps) {
  return getPlatformRuntime().isMobileShell ? (
    <LegacyEntityFilterButton entityFilter={props.entityFilter} onChange={props.onChange} />
  ) : (
    <EntityFilterMenu {...props} />
  );
}

interface EntityChoice {
  kind: 'node' | 'element' | 'storyline' | 'category';
  id: string;
  label: string;
  mark: KindMarkKind;
  color?: string;
}

/**
 * The desktop entity filter: a word toggle — 「关联 · 全部」, or the chosen
 * entity's sand mark, name and count while the filter holds (then it stays
 * on, with a flat × beside it) — that opens a menu surface portalled to body:
 * a search field on top, 全部, then every chapter, drift, element, storyline
 * and category as a menu row with its mark and how many TODOs and materials
 * it gathers.
 */
function EntityFilterMenu({ entityFilter, onChange, targetCounts, totalItems }: EntityFilterProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const { bookNodes, bookElements, storylines, bookElementCategories, primaryStorylineByNode } =
    useDataStoreFields(
      'bookNodes',
      'bookElements',
      'storylines',
      'bookElementCategories',
      'primaryStorylineByNode',
    );

  const describeNode = useCallback(
    (node: (typeof bookNodes)[number]): EntityChoice => {
      const chapter = isChapter(node);
      const storylineId = primaryStorylineByNode[node.id] ?? null;
      return {
        kind: 'node',
        id: node.id,
        label:
          node.title ||
          t(chapter ? 'relationPicker.untitledChapter' : 'relationPicker.untitledDrift'),
        mark: chapter ? 'chapter' : 'drift',
        color: storylineId
          ? (storylines.find((s) => s.id === storylineId)?.color ?? undefined)
          : undefined,
      };
    },
    [primaryStorylineByNode, storylines, t],
  );

  const describeElement = useCallback(
    (element: (typeof bookElements)[number]): EntityChoice => ({
      kind: 'element',
      id: element.id,
      label: element.name || t('relationPicker.untitledElement'),
      mark: 'element',
      color: bookElementCategories.find((c) => c.id === element.categoryId)?.color ?? undefined,
    }),
    [bookElementCategories, t],
  );

  const picked = useMemo<EntityChoice | null>(() => {
    const { kind, id } = entityFilter;
    if (!kind || !id) return null;
    if (kind === 'node') {
      const node = bookNodes.find((x) => x.id === id);
      return node
        ? describeNode(node)
        : { kind, id, label: t('relationPicker.untitledChapter'), mark: 'chapter' };
    }
    if (kind === 'element') {
      const element = bookElements.find((x) => x.id === id);
      return element ? describeElement(element) : { kind, id, label: id, mark: 'element' };
    }
    if (kind === 'storyline') {
      const storyline = storylines.find((x) => x.id === id);
      return {
        kind,
        id,
        label: storyline?.name || t('relationPicker.untitledStoryline'),
        mark: 'storyline',
        color: storyline?.color ?? undefined,
      };
    }
    if (kind === 'category') {
      const category = bookElementCategories.find((x) => x.id === id);
      return {
        kind,
        id,
        label: category?.name || id,
        mark: 'category',
        color: category?.color ?? undefined,
      };
    }
    return null;
  }, [entityFilter, bookNodes, bookElements, storylines, bookElementCategories, describeNode, describeElement, t]);

  // Candidates are only built while the menu is open.
  const groups = useMemo(() => {
    if (!open) return [];
    const needle = query.trim().toLowerCase();
    const matches = (choice: EntityChoice) => !needle || choice.label.toLowerCase().includes(needle);
    const chapters: EntityChoice[] = [];
    const drifts: EntityChoice[] = [];
    bookNodes.forEach((node) => {
      const choice = describeNode(node);
      if (!matches(choice)) return;
      if (choice.mark === 'chapter') chapters.push(choice);
      else drifts.push(choice);
    });
    const elements = bookElements.map(describeElement).filter(matches);
    const storylineChoices = storylines
      .map<EntityChoice>((s) => ({
        kind: 'storyline',
        id: s.id,
        label: s.name || t('relationPicker.untitledStoryline'),
        mark: 'storyline',
        color: s.color ?? undefined,
      }))
      .filter(matches);
    const categories = bookElementCategories
      .map<EntityChoice>((c) => ({
        kind: 'category',
        id: c.id,
        label: c.name || c.id,
        mark: 'category',
        color: c.color ?? undefined,
      }))
      .filter(matches);
    return [
      { key: 'chapters', label: t('relationPicker.groups.chapters'), items: chapters },
      { key: 'drifts', label: t('relationPicker.groups.drifts'), items: drifts },
      { key: 'elements', label: t('relationPicker.groups.elements'), items: elements },
      { key: 'storylines', label: t('relationPicker.groups.storylines'), items: storylineChoices },
      { key: 'categories', label: t('relationPicker.groups.categories'), items: categories },
    ].filter((group) => group.items.length > 0);
  }, [open, query, bookNodes, bookElements, storylines, bookElementCategories, describeNode, describeElement, t]);

  const choose = (next: FocusedEntity) => {
    setOpen(false);
    onChange(next);
  };

  const row = (
    key: string,
    selected: boolean,
    onPick: () => void,
    name: string,
    count: number,
    mark?: React.ReactNode,
  ) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={selected}
      className={`menu-surface__item entity-filter-popover__item${active === key ? ' is-current' : ''}`}
      onFocus={() => setActive(key)}
      onBlur={() => setActive((was) => (was === key ? null : was))}
      onClick={onPick}
    >
      {mark}
      <span className="entity-filter-popover__name">{name}</span>
      {count > 0 && <span className="entity-filter-popover__count">{count}</span>}
      {selected && <BrushIcon name="check" size={13} className="entity-filter-popover__check" />}
    </button>
  );

  const pickedKey = picked ? `${picked.kind}:${picked.id}` : null;
  const searching = query.trim().length > 0;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ui-word-toggle glass glass--rest glass--small smm-entity-toggle${picked ? ' is-on' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          picked
            ? t('memoMaterial.super.entityFilterActiveTitle', { label: picked.label })
            : t('memoMaterial.super.entityFilterTitle')
        }
        onClick={() => {
          if (!open) setQuery('');
          setOpen(!open);
        }}
      >
        {picked ? (
          <>
            <KindMark kind={picked.mark} seed={picked.id} color={picked.color} />
            <span className="smm-entity-toggle__label">{picked.label}</span>
            <span className="ui-word-toggle__count">{targetCounts.get(pickedKey ?? '') ?? 0}</span>
          </>
        ) : (
          <span>{t('memoMaterial.super.entityFilterAll')}</span>
        )}
      </button>
      {picked && (
        <GhostIconButton
          size="sm"
          className="smm-entity-clear"
          icon={<BrushIcon name="close" size={11} />}
          aria-label={t('memoMaterial.super.clearEntityFilter')}
          title={t('memoMaterial.super.clearEntityFilter')}
          onClick={() => choose({ kind: null, id: null })}
        />
      )}
      <AnchoredPopover
        anchorRef={buttonRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-start"
        role="listbox"
        ariaLabel={t('memoMaterial.super.entityFilterTitle')}
        maxHeight={440}
        className="menu-surface menu-surface--rich menu-surface--panel entity-filter-popover entity-filter-popover--menu"
      >
        <div className="entity-filter-popover__search">
          <label className="ui-field ui-field--sm glass glass--rest glass--field glass--small">
            <BrushIcon name="search" size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('relationPicker.searchPlaceholder')}
              aria-label={t('relationPicker.searchPlaceholder')}
              onKeyDown={(event) => {
                // The popover leaves Escape to a focused field; here it closes
                // the menu instead of reaching the Super View's Escape stack.
                if (event.key !== 'Escape') return;
                event.preventDefault();
                setOpen(false);
              }}
            />
          </label>
        </div>
        {!searching &&
          row('all', !picked, () => choose({ kind: null, id: null }), t('memoMaterial.super.all'), totalItems)}
        {groups.map((group) => (
          <div key={group.key} role="group" aria-label={group.label}>
            <div className="entity-filter-popover__section">{group.label}</div>
            {group.items.map((choice) => {
              const key = `${choice.kind}:${choice.id}`;
              return row(
                key,
                key === pickedKey,
                () => choose({ kind: choice.kind, id: choice.id }),
                choice.label,
                targetCounts.get(key) ?? 0,
                <KindMark kind={choice.mark} seed={choice.id} color={choice.color} />,
              );
            })}
          </div>
        ))}
        {searching && groups.length === 0 && (
          <div className="entity-filter-popover__empty">{t('globalSearch.noResults')}</div>
        )}
      </AnchoredPopover>
    </>
  );
}

function LegacyEntityFilterButton({
  entityFilter,
  onChange,
}: {
  entityFilter: FocusedEntity;
  onChange: (next: FocusedEntity) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const { bookNodes, bookElements, storylines, bookElementCategories } = useDataStoreFields('bookNodes', 'bookElements', 'storylines', 'bookElementCategories');

  const label = useMemo(() => {
    if (!entityFilter.kind || !entityFilter.id) return t('memoMaterial.super.all');
    const { kind, id } = entityFilter;
    if (kind === 'node') {
      const n = bookNodes.find((x) => x.id === id);
      return n?.title || t(n && isChapter(n) ? 'topTimeline.untitled.chapter' : 'topTimeline.untitled.drift');
    }
    if (kind === 'element')
      return bookElements.find((x) => x.id === id)?.name || 'Untitled Element';
    if (kind === 'storyline')
      return storylines.find((x) => x.id === id)?.name || 'Untitled Storyline';
    if (kind === 'category') return bookElementCategories.find((x) => x.id === id)?.name || id;
    return id;
  }, [entityFilter, bookNodes, bookElements, storylines, bookElementCategories, t]);

  const selected = useMemo(
    () =>
      new Set(
        entityFilter.kind && entityFilter.id ? [`${entityFilter.kind}:${entityFilter.id}`] : [],
      ),
    [entityFilter],
  );

  return (
    <>
      <LabelMono tone="ink-4">{t('memoMaterial.super.relations')}</LabelMono>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <button
          ref={buttonRef}
          onClick={() => {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (rect) setAnchor({ x: rect.left, y: rect.bottom + 6 });
            setOpen((value) => !value);
          }}
          style={{
            minHeight: 'var(--control-height-sm)',
            maxWidth: 220,
            padding: '3px 8px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            overflow: 'hidden',
            border: `1px solid ${entityFilter.kind ? 'hsl(var(--ink-1))' : 'hsl(var(--rule))'}`,
            borderRadius: 'var(--radius-lg)',
            background: entityFilter.kind ? 'hsl(var(--ink-1) / 0.06)' : 'transparent',
            color: 'hsl(var(--ink-1))',
            cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
            fontSize: 12,
            whiteSpace: 'nowrap',
          }}
          title={
            entityFilter.kind
              ? t('memoMaterial.super.entityFilterActiveTitle', { label })
              : t('memoMaterial.super.entityFilterTitle')
          }
        >
          <span
            style={{
              maxWidth: 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
          {!entityFilter.kind && <BrushIcon name="chevron-down" size={12} />}
        </button>
        {entityFilter.kind && (
          <GhostIconButton
            size="sm"
            icon={<BrushIcon name="close" size={13} />}
            aria-label={t('memoMaterial.super.clearEntityFilter')}
            title={t('memoMaterial.super.clearEntityFilter')}
            onClick={() => {
              onChange({ kind: null, id: null });
              setOpen(false);
            }}
          />
        )}
      </div>
      {open && (
        <ContextMenuSurface
          x={anchor.x}
          y={anchor.y}
          onClose={() => setOpen(false)}
          role="dialog"
          ariaLabel={t('memoMaterial.super.entityFilterTitle')}
          className="menu-surface menu-surface--rich menu-surface--panel entity-filter-popover"
          style={{
            maxHeight: 440,
            padding: 10,
            overflowY: 'auto',
          }}
        >
          <div style={{ ...kickerStyle, marginBottom: 6 }}>
            {t('memoMaterial.super.entityFilterHint')}
          </div>
          <EntityRelationPicker
            selected={selected}
            selectedChipMode="toggle"
            onAdd={(target) => {
              onChange({ kind: target.kind, id: target.id });
              setOpen(false);
            }}
            onRemove={() => onChange({ kind: null, id: null })}
          />
        </ContextMenuSurface>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rails — the TODO and comment columns left of the library. On the desktop
// each is as wide as the author dragged it (RailEdge on its right line) and
// its cards flow into as many columns as fit.

/**
 * A rail's right line, dragged to make the rail wider or narrower. While it
 * moves the line bleeds glass by the distance travelled, like a sidebar's
 * seam; arrow keys move a focused edge a step at a time. The rail follows
 * the pointer directly and the width is committed once on release.
 */
function RailEdge({
  label,
  width,
  onResize,
}: {
  label: string;
  width: number;
  onResize: (width: number) => void;
}) {
  // What the split leaves this rail: its width minus the other rails and the
  // library's minimum.
  const roomFor = (rail: HTMLElement) => {
    const split = rail.parentElement;
    if (!split) return Infinity;
    const others = Array.from(split.children)
      .filter((child) => child !== rail && child.classList.contains('smm-rail'))
      .reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
    return split.getBoundingClientRect().width - others - SMM_LIBRARY_MIN;
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const edge = event.currentTarget;
    const rail = edge.parentElement;
    const split = rail?.parentElement;
    if (!rail || !split) return;
    event.preventDefault();
    try {
      edge.setPointerCapture(event.pointerId);
    } catch {
      /* a synthetic pointer: the edge still follows while it stays over it */
    }
    const start = rail.getBoundingClientRect().width;
    const room = roomFor(rail);
    const startX = event.clientX;
    let lastX = startX;
    let next = start;
    split.classList.add('is-resizing');
    const move = (moveEvent: PointerEvent) => {
      next = dragRailWidth(start, moveEvent.clientX - startX, room);
      rail.style.flexBasis = `${next}px`;
      stepGlassFlow(edge, Math.abs(moveEvent.clientX - lastX));
      lastX = moveEvent.clientX;
    };
    const stop = () => {
      edge.removeEventListener('pointermove', move);
      edge.removeEventListener('pointerup', stop);
      edge.removeEventListener('pointercancel', stop);
      split.classList.remove('is-resizing');
      onResize(next);
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', stop);
    edge.addEventListener('pointercancel', stop);
  };

  return (
    <div
      className="smm-rail__edge"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={SMM_RAIL_MIN}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const rail = event.currentTarget.parentElement;
        if (!rail) return;
        event.preventDefault();
        const step = event.key === 'ArrowLeft' ? -SMM_RAIL_KEY_STEP : SMM_RAIL_KEY_STEP;
        onResize(dragRailWidth(rail.getBoundingClientRect().width, step, roomFor(rail)));
      }}
    >
      <span className="flow-line flow-line--v smm-rail__edge-flow" aria-hidden="true" />
    </div>
  );
}

const LEGACY_RAIL_STYLE: CSSProperties = {
  width: TODO_RAIL_WIDTH,
  flexShrink: 0,
  borderRight: '1px solid hsl(var(--rule))',
  background: 'hsl(var(--paper-deep) / 0.35)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const LEGACY_RAIL_LIST_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '6px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

function TodoRail({
  openTodos,
  commentUsecases,
  relationUsecases,
  entityRelations,
  width,
  onResize,
  onCompose,
}: {
  openTodos: Comment[];
  commentUsecases: ReturnType<typeof useComment>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  entityRelations: Array<{
    id: string;
    fromKind: EntityKind;
    fromId: string;
    toKind: EntityKind;
    toId: string;
  }>;
  width: number;
  onResize: (width: number) => void;
  onCompose: () => void;
}) {
  const { t } = useTranslation();
  const mobileShell = getPlatformRuntime().isMobileShell;
  const renderTodo = (todo: Comment) => {
    const relations = entityRelations
      .filter((r) => r.fromKind === 'comment' && r.fromId === todo.id)
      .map((r) => ({ id: r.id, toKind: r.toKind, toId: r.toId }));
    return (
      <TodoCard
        key={todo.id}
        todo={todo}
        relations={relations}
        onToggleResolved={() => todo.status === 'resolved'
          ? commentUsecases.reopenComment(todo.id)
          : commentUsecases.resolveComment(todo.id)}
        onDelete={() => commentUsecases.deleteComment(todo.id)}
        onSave={(body) => commentUsecases.updateCommentBody(todo.id, createPlainCommentDoc(body))}
        onAddRelation={(t) =>
          relationUsecases.addGenericAssociation('comment', todo.id, t.kind, t.id)
        }
        onRemoveRelation={(t) => {
          const ref = entityRelations.find(
            (r) =>
              r.fromKind === 'comment' &&
              r.fromId === todo.id &&
              r.toKind === t.kind &&
              r.toId === t.id,
          );
          if (ref) relationUsecases.removeRelation(ref.id);
        }}
      />
    );
  };

  return (
    <div
      {...look(mobileShell, 'smm-rail', LEGACY_RAIL_STYLE, 'smm-library-main')}
      style={mobileShell ? LEGACY_RAIL_STYLE : { flexBasis: width }}
    >
      {mobileShell ? (
        <SectionHeader
          kicker="TODO"
          count={openTodos.length}
          accent={openTodos.length > 0 ? 'hsl(var(--story-2))' : undefined}
          action={
            <button
              onClick={onCompose}
              style={ghostBtnStyle}
              title={t('memoMaterial.dialog.newTodo')}
            >
              <BrushIcon name="plus" size={11} inline />
            </button>
          }
        />
      ) : (
        <div className="smm-column-head">
          <span className="smm-index">TODO</span>
          <span className="smm-index-count">{openTodos.length}</span>
          <GhostIconButton
            className="panel-header-new smm-column-head__action"
            icon={<BrushIcon name="plus" size={13} />}
            onClick={onCompose}
            title={t('memoMaterial.dialog.newTodo')}
            aria-label={t('memoMaterial.dialog.newTodo')}
          />
        </div>
      )}
      <div {...look(mobileShell, 'smm-rail__list', LEGACY_RAIL_LIST_STYLE, 'smm-scroll')}>
        {openTodos.length === 0 &&
          (mobileShell ? (
            <RailEmpty hint={t('memoMaterial.super.todoEmptyHint')} />
          ) : (
            <EmptyState density="compact" message={t('memoMaterial.super.todoEmptyHint')} />
          ))}
        {openTodos.map(renderTodo)}
      </div>
      {!mobileShell && (
        <RailEdge label={t('memoMaterial.super.resizeTodos')} width={width} onResize={onResize} />
      )}
    </div>
  );
}

/**
 * The comment rail (desktop): open comments gathered under what they are
 * written on, like Review grouped by target — a group's head opens its
 * thing, and on this project-wide shelf even a lone group keeps its head.
 * Each card is Review's own card. A wide rail flows whole groups down its
 * columns like a newspaper, so many short groups fill it rather than each
 * taking a row of its own.
 */
function CommentRail({
  projectId,
  openNotes,
  refsByFrom,
  relationUsecases,
  removeRelation,
  width,
  onResize,
  onCompose,
}: {
  projectId: string;
  openNotes: Comment[];
  refsByFrom: Map<string, Array<{ id: string; toKind: EntityKind; toId: string }>>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  removeRelation: (fromKind: EntityKind, fromId: string, toKind: EntityKind, toId: string) => void;
  width: number;
  onResize: (width: number) => void;
  onCompose: () => void;
}) {
  const { t } = useTranslation();
  const navigator = useWorkspaceNavigator();
  const {
    bookNodes,
    bookElements,
    storylines,
    bookElementCategories,
    libraryItems,
    primaryStorylineByNode,
  } = useDataStoreFields(
    'bookNodes',
    'bookElements',
    'storylines',
    'bookElementCategories',
    'libraryItems',
    'primaryStorylineByNode',
  );
  const groupData = useMemo<ReviewGroupData>(
    () => ({ bookNodes, bookElements, storylines, bookElementCategories, libraryItems }),
    [bookNodes, bookElements, storylines, bookElementCategories, libraryItems],
  );
  const groups = useMemo(() => groupReviewItems(openNotes, groupData), [openNotes, groupData]);

  const renderCard = (comment: Comment) => {
    const relations = refsByFrom.get(`comment:${comment.id}`) ?? [];
    return (
      <ReviewItemCard
        key={comment.id}
        comment={comment}
        projectId={projectId}
        presentation="panel"
        relations={relations.map((r) => ({ id: r.id, toKind: r.toKind, toId: r.toId }))}
        onAddRelation={(target) =>
          relationUsecases.addGenericAssociation('comment', comment.id, target.kind, target.id)
        }
        onRemoveRelation={(target) => removeRelation('comment', comment.id, target.kind, target.id)}
      />
    );
  };

  const renderGroup = (group: ReviewGroup) => {
    const kind = group.targetKind;
    const id = group.targetId;
    const named = kind && id ? reviewGroupTitle(groupData, kind, id) : null;
    const title = !kind
      ? t('reviewPanel.groups.floating')
      : named
        ? named.title || t('common.untitled')
        : t(kind === 'patch' ? 'reviewPanel.groups.patch' : 'reviewPanel.groups.deleted');
    const target = named && kind && kind !== 'patch' && id ? { kind, id } : null;
    return (
      <section key={group.key} className="review-group review-group--glass smm-comment-group">
        <div className="review-group__header">
          <button
            type="button"
            className="review-group__title"
            disabled={!target}
            title={target ? t('reviewPanel.groups.open', { name: title }) : undefined}
            onClick={() => {
              if (target) navigator.open({ entityType: target.kind, id: target.id });
            }}
          >
            <span className="review-group__glyph" aria-hidden="true">
              {kind && kind !== 'patch' && id ? (
                <KindMark
                  kind={kindMarkOfTarget(kind, named?.isDrift)}
                  seed={id}
                  color={reviewTargetColor(groupData, primaryStorylineByNode, kind, id)}
                />
              ) : (
                <BrushIcon name="enso" size={12} />
              )}
            </span>
            <span className="review-group__name">{title}</span>
          </button>
          <span className="review-group__count">{group.items.length}</span>
        </div>
        <div className="smm-comment-group__cards">{group.items.map(renderCard)}</div>
      </section>
    );
  };

  return (
    <div className="smm-rail smm-rail--comments" style={{ flexBasis: width }}>
      <div className="smm-column-head">
        <span className="smm-index">{t('memoMaterial.super.comments')}</span>
        <span className="smm-index-count">{openNotes.length}</span>
        <GhostIconButton
          className="panel-header-new smm-column-head__action"
          icon={<BrushIcon name="plus" size={13} />}
          onClick={onCompose}
          title={t('reviewPanel.newComment')}
          aria-label={t('reviewPanel.newComment')}
        />
      </div>
      <div className="smm-rail__list smm-rail__list--groups smm-scroll">
        {openNotes.length === 0 && (
          <EmptyState density="compact" message={t('memoMaterial.super.commentEmptyHint')} />
        )}
        {groups.length > 0 && <div className="smm-comment-columns">{groups.map(renderGroup)}</div>}
      </div>
      <RailEdge label={t('memoMaterial.super.resizeComments')} width={width} onResize={onResize} />
    </div>
  );
}

function SectionHeader({
  kicker,
  count,
  accent,
  action,
}: {
  kicker: string;
  count: number;
  accent?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: 30,
        flexShrink: 0,
        padding: '0 10px 0 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        borderBottom: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper))',
      }}
    >
      <span
        style={{
          ...kickerStyle,
          color: accent ?? 'hsl(var(--ink-3))',
        }}
      >
        {kicker}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'hsl(var(--ink-4))',
        }}
      >
        {count}
      </span>
      <div style={{ flex: 1 }} />
      {action}
    </div>
  );
}

const ghostBtnStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '2px 7px',
  borderRadius: 3,
  border: '1px solid hsl(var(--rule))',
  background: 'transparent',
  color: 'hsl(var(--ink-2))',
  cursor: 'pointer',
};

function RailEmpty({ hint }: { hint: string }) {
  return (
    <div
      style={{
        padding: '20px 12px',
        textAlign: 'center',
        fontFamily: 'var(--font-sans)',
        fontStyle: 'italic',
        fontSize: 12,
        color: 'hsl(var(--ink-4))',
        lineHeight: 1.55,
      }}
    >
      {hint}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LibraryItemMain — center column, grid grouped by kind.

const LEGACY_MAIN_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const LEGACY_MAIN_SCROLL_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '10px 16px 18px',
};

function LibraryItemMain({
  libraryItemsByKind,
  totalVisible,
  totalLibraryItems,
  hiddenKinds,
  onToggleKind,
  kindCounts,
  entityFilter,
  onEntityFilterChange,
  targetCounts,
  totalItems,
  refsByFrom,
  editingId,
  setEditingId,
  libraryItemUsecases,
  relationUsecases,
  removeRelation,
  openLibraryItemInApp,
  openLibraryItemInSystem,
  onCompose,
}: {
  libraryItemsByKind: Map<LibraryItemKind, LibraryItem[]>;
  totalVisible: number;
  totalLibraryItems: number;
  hiddenKinds: Set<LibraryItemKind>;
  /** Toggle one kind on/off in the visibility filter. */
  onToggleKind: (k: LibraryItemKind) => void;
  /** Total libraryItems per kind across the project (ignores the kind toggle
   *  itself, so the count next to each chip stays stable as you toggle). */
  kindCounts: Record<LibraryItemKind, number>;
  /** Entity-target filter — narrows BOTH memos and libraryItems to those
   *  related to the picked entity. Lives in this header for visual
   *  proximity to the KIND chips, even though the rail also reacts. */
  entityFilter: FocusedEntity;
  onEntityFilterChange: (next: FocusedEntity) => void;
  targetCounts: Map<string, number>;
  totalItems: number;
  refsByFrom: Map<string, Array<{ id: string; toKind: EntityKind; toId: string }>>;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  libraryItemUsecases: ReturnType<typeof useLibraryItem>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  removeRelation: (fromKind: EntityKind, fromId: string, toKind: EntityKind, toId: string) => void;
  openLibraryItemInApp: (m: LibraryItem) => void;
  openLibraryItemInSystem: (m: LibraryItem) => Promise<void>;
  onCompose: () => void;
}) {
  const { t } = useTranslation();
  const mobileShell = getPlatformRuntime().isMobileShell;
  const kindChips = KIND_ORDER.map((k) => (
    <KindChip
      key={k}
      active={!hiddenKinds.has(k)}
      count={kindCounts[k] ?? 0}
      onClick={() => onToggleKind(k)}
    >
      {t(`memoMaterial.kind.${k}`, { defaultValue: k })}
    </KindChip>
  ));
  const entityFilterButton = (
    <EntityFilterButton
      entityFilter={entityFilter}
      onChange={onEntityFilterChange}
      targetCounts={targetCounts}
      totalItems={totalItems}
    />
  );
  return (
    <div {...look(mobileShell, 'smm-main', LEGACY_MAIN_STYLE)}>
      {/* LibraryItem section header: kicker + count on the left, then KIND
          chips and entity filter (moved down from the global header), then
          the new-material action on the right. On the desktop it is exactly
          as tall as the rail's head, so both columns start on one line. */}
      {mobileShell ? (
        <div
          className="smm-library-toolbar"
          style={{
            minHeight: 38,
            flexShrink: 0,
            padding: '0 14px 0 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderBottom: '1px solid hsl(var(--rule))',
            background: 'hsl(var(--paper))',
          }}
        >
          <LabelMono tone="ink-4">{t('memoMaterial.super.material')}</LabelMono>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'hsl(var(--ink-4))',
            }}
          >
            {totalVisible}
          </span>

          <ToolbarDivider />

          <LabelMono tone="ink-4">{t('memoMaterial.super.kind')}</LabelMono>
          <div style={{ display: 'flex', gap: 4 }}>{kindChips}</div>

          <ToolbarDivider />

          {entityFilterButton}

          <div style={{ flex: 1 }} />

          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'hsl(var(--ink-4))',
              letterSpacing: '0.06em',
            }}
          >
            {totalVisible} / {totalLibraryItems}
          </span>
          <button
            className="smm-library-toolbar__create"
            onClick={onCompose}
            title={t('memoMaterial.dialog.newMaterial')}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              padding: '3px 10px',
              border: '1px solid hsl(var(--ink-1))',
              borderRadius: 3,
              background: 'hsl(var(--ink-1))',
              color: 'hsl(var(--paper))',
              cursor: 'pointer',
              letterSpacing: '0.08em',
            }}
          >
            <BrushIcon name="plus" size={10} inline /> {t('memoMaterial.super.newMaterialButton')}
          </button>
        </div>
      ) : (
        <div className="smm-library-toolbar smm-column-head">
          <span className="smm-index">{t('memoMaterial.super.material')}</span>
          <span className="smm-index-count">{totalVisible}</span>
          <div className="smm-library-toolbar__kinds">{kindChips}</div>
          {entityFilterButton}
          <span className="smm-column-head__spacer" />
          <span className="smm-index-count">
            {totalVisible} / {totalLibraryItems}
          </span>
          <Button
            variant="primary"
            size="sm"
            className="smm-library-toolbar__create"
            onClick={onCompose}
          >
            <BrushIcon name="plus" size={11} />
            {t('memoMaterial.super.newMaterialButton')}
          </Button>
        </div>
      )}

      <div {...look(mobileShell, 'smm-main__scroll', LEGACY_MAIN_SCROLL_STYLE, 'smm-scroll')}>
        {totalVisible === 0 &&
          (mobileShell ? (
            <div
              style={{
                padding: '60px 20px',
                textAlign: 'center',
                fontFamily: 'var(--font-sans)',
                fontStyle: 'italic',
                fontSize: 13,
                color: 'hsl(var(--ink-3))',
              }}
            >
              {totalLibraryItems === 0 ? (
                <>
                  <div>{t('memoMaterial.super.noMaterials')}</div>
                  <button
                    onClick={onCompose}
                    style={{
                      marginTop: 12,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      padding: '5px 14px',
                      border: '1px solid hsl(var(--ink-1))',
                      borderRadius: 3,
                      background: 'hsl(var(--ink-1))',
                      color: 'hsl(var(--paper))',
                      cursor: 'pointer',
                      letterSpacing: '0.08em',
                    }}
                  >
                    <BrushIcon name="plus" size={10} inline /> {t('memoMaterial.super.newMaterialButton')}
                  </button>
                </>
              ) : (
                t('memoMaterial.super.noFilteredMaterials')
              )}
            </div>
          ) : (
            <EmptyState
              mark="material"
              message={
                totalLibraryItems === 0
                  ? t('memoMaterial.super.noMaterials')
                  : t('memoMaterial.super.noFilteredMaterials')
              }
              action={
                totalLibraryItems === 0 ? (
                  <Button variant="ghost" size="sm" onClick={onCompose}>
                    {t('memoMaterial.super.newMaterialButton')}
                  </Button>
                ) : undefined
              }
            />
          ))}

        {KIND_ORDER.map((kind) => {
          const items = libraryItemsByKind.get(kind) ?? [];
          if (hiddenKinds.has(kind)) return null;
          if (items.length === 0) return null;
          return (
            <KindGroup
              key={kind}
              kind={kind}
              items={items}
              refsByFrom={refsByFrom}
              editingId={editingId}
              setEditingId={setEditingId}
              libraryItemUsecases={libraryItemUsecases}
              relationUsecases={relationUsecases}
              removeRelation={removeRelation}
              openLibraryItemInApp={openLibraryItemInApp}
              openLibraryItemInSystem={openLibraryItemInSystem}
            />
          );
        })}
      </div>
    </div>
  );
}

const LEGACY_GROUP_HEAD_STYLE: CSSProperties = {
  ...kickerStyle,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 8,
  paddingBottom: 4,
  borderBottom: '1px dashed hsl(var(--rule))',
};

const LEGACY_GROUP_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 10,
  alignItems: 'start',
};

function KindGroup({
  kind,
  items,
  refsByFrom,
  editingId,
  setEditingId,
  libraryItemUsecases,
  relationUsecases,
  removeRelation,
  openLibraryItemInApp,
  openLibraryItemInSystem,
}: {
  kind: LibraryItemKind;
  items: LibraryItem[];
  refsByFrom: Map<string, Array<{ id: string; toKind: EntityKind; toId: string }>>;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  libraryItemUsecases: ReturnType<typeof useLibraryItem>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  removeRelation: (fromKind: EntityKind, fromId: string, toKind: EntityKind, toId: string) => void;
  openLibraryItemInApp: (m: LibraryItem) => void;
  openLibraryItemInSystem: (m: LibraryItem) => Promise<void>;
}) {
  const { t } = useTranslation();
  const mobileShell = getPlatformRuntime().isMobileShell;
  return (
    <section {...look(mobileShell, 'smm-kind-group', { marginBottom: 18 })}>
      <div {...look(mobileShell, 'smm-kind-group__head smm-index', LEGACY_GROUP_HEAD_STYLE)}>
        <span {...look(mobileShell, 'smm-kind-group__name')}>
          {t(`memoMaterial.kind.${kind}`, { defaultValue: kind })}
        </span>
        <span {...look(mobileShell, 'smm-index-count', { color: 'hsl(var(--ink-4))' })}>
          {items.length}
        </span>
      </div>
      <div {...look(mobileShell, 'smm-kind-group__grid', LEGACY_GROUP_GRID_STYLE)}>
        {items.map((mat) => (
          <LibraryItemCard
            key={mat.id}
            material={mat}
            relations={refsByFrom.get(`library_item:${mat.id}`) ?? []}
            editing={editingId === mat.id}
            mobileActions={mobileShell}
            onSetEditing={(on) => setEditingId(on ? mat.id : null)}
            onOpenInSystem={() => openLibraryItemInSystem(mat)}
            onOpenInApp={() => openLibraryItemInApp(mat)}
            onUpdate={(updates) => libraryItemUsecases.updateLibraryItem(mat.id, updates)}
            onDelete={() => libraryItemUsecases.removeLibraryItem(mat.id)}
            onAddRelation={(t) =>
              relationUsecases.addGenericAssociation('library_item', mat.id, t.kind, t.id)
            }
            onRemoveRelation={(t) => removeRelation('library_item', mat.id, t.kind, t.id)}
            defaultExpanded
          />
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BottomDrawer — collapsed header strip + draggable resize when expanded.
// Body is a 2-column split: orphan libraryItems | resolved TODOs and comments.

const LEGACY_DRAWER_HANDLE_STYLE: CSSProperties = {
  height: 4,
  marginTop: -2,
  userSelect: 'none',
};

const LEGACY_DRAWER_BAR_STYLE: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  height: DRAWER_HEADER_HEIGHT - 4,
  padding: '0 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'hsl(var(--ink-3))',
  flexShrink: 0,
};

const LEGACY_DRAWER_COLS_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 1,
  background: 'hsl(var(--rule))',
};

const LEGACY_DRAWER_COL_STYLE: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'hsl(var(--paper))',
};

const LEGACY_DRAWER_ORPHANS_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '8px 12px 12px',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: 8,
  alignContent: 'start',
};

const LEGACY_DRAWER_RESOLVED_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '6px 12px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const LEGACY_DRAWER_EMPTY_STYLE: CSSProperties = {
  padding: '20px 8px',
  fontFamily: 'var(--font-sans)',
  fontStyle: 'italic',
  fontSize: 12,
  color: 'hsl(var(--ink-4))',
  textAlign: 'center',
};

function BottomDrawer({
  expanded,
  onExpandedChange,
  orphans,
  resolvedItems,
  editingId,
  setEditingId,
  commentUsecases,
  libraryItemUsecases,
  relationUsecases,
  removeRelation,
  openLibraryItemInApp,
  openLibraryItemInSystem,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  orphans: LibraryItem[];
  resolvedItems: Comment[];
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  commentUsecases: ReturnType<typeof useComment>;
  libraryItemUsecases: ReturnType<typeof useLibraryItem>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  removeRelation: (fromKind: EntityKind, fromId: string, toKind: EntityKind, toId: string) => void;
  openLibraryItemInApp: (m: LibraryItem) => void;
  openLibraryItemInSystem: (m: LibraryItem) => Promise<void>;
}) {
  const { t } = useTranslation();
  const mobileShell = getPlatformRuntime().isMobileShell;
  const [height, setHeight] = useState(DRAWER_DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(DRAWER_DEFAULT_HEIGHT);
  const expandedRef = useRef(expanded);

  // Desktop: the drawer's top edge bleeds glass while it opens or closes
  // (a structural movement, followed frame by frame)…
  useLayoutEffect(() => {
    if (expandedRef.current === expanded) return;
    expandedRef.current = expanded;
    const el = drawerRef.current;
    if (el && !mobileShell) trackGlassFlow(el, () => el.getBoundingClientRect().height);
  }, [expanded, mobileShell]);

  const handleDragMove = useCallback(
    (e: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      const delta = state.startY - e.clientY;
      const next = Math.max(DRAWER_MIN_HEIGHT, state.startHeight + delta);
      // …and while its height is dragged, by the distance it moved.
      const el = drawerRef.current;
      if (el && !mobileShell) stepGlassFlow(el, Math.abs(next - heightRef.current));
      heightRef.current = next;
      setHeight(next);
    },
    [mobileShell],
  );

  const handleDragEnd = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  const handleDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!expanded) return;
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startHeight: height };
      setDragging(true);
    },
    [expanded, height],
  );

  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('pointermove', handleDragMove);
    window.addEventListener('pointerup', handleDragEnd);
    window.addEventListener('pointercancel', handleDragEnd);
    return () => {
      window.removeEventListener('pointermove', handleDragMove);
      window.removeEventListener('pointerup', handleDragEnd);
      window.removeEventListener('pointercancel', handleDragEnd);
    };
  }, [dragging, handleDragMove, handleDragEnd]);

  const drawerHeight = expanded ? height : DRAWER_HEADER_HEIGHT;

  return (
    <div
      ref={drawerRef}
      className={mobileShell ? undefined : `smm-drawer${dragging ? ' is-dragging' : ''}`}
      style={
        mobileShell
          ? {
              height: drawerHeight,
              flexShrink: 0,
              borderTop: '1px solid hsl(var(--rule))',
              background: 'hsl(var(--paper-deep) / 0.5)',
              display: 'flex',
              flexDirection: 'column',
              transition: dragging ? 'none' : 'height 0.18s ease',
            }
          : { height: drawerHeight }
      }
    >
      {!mobileShell && (
        <span className="flow-line flow-line--h smm-drawer__flow" aria-hidden="true" />
      )}
      <div
        onPointerDown={handleDragStart}
        {...look(
          mobileShell,
          `smm-drawer__resize${expanded ? ' is-active' : ''}`,
          { ...LEGACY_DRAWER_HANDLE_STYLE, cursor: expanded ? 'ns-resize' : 'default' },
        )}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        {...look(mobileShell, 'smm-drawer__bar smm-index', LEGACY_DRAWER_BAR_STYLE)}
        aria-expanded={expanded}
        title={
          expanded ? t('memoMaterial.super.collapseDrawer') : t('memoMaterial.super.expandDrawer')
        }
      >
        {mobileShell ? (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <span>
                {t('memoMaterial.super.orphans')}{' '}
                <span style={{ color: 'hsl(var(--ink-4))' }}>{orphans.length}</span>
              </span>
              <span style={{ color: 'hsl(var(--ink-5))' }}>·</span>
              <span>
                {t('memoMaterial.super.resolved')}{' '}
                <span style={{ color: 'hsl(var(--ink-4))' }}>{resolvedItems.length}</span>
              </span>
            </span>
            <BrushIcon
              name="chevron-up"
              size={12}
              style={{
                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.18s ease',
              }}
            />
          </>
        ) : (
          <>
            <span className="smm-drawer__summary">
              <span>
                {t('memoMaterial.super.orphans')}{' '}
                <span className="smm-index-count">{orphans.length}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {t('memoMaterial.super.resolved')}{' '}
                <span className="smm-index-count">{resolvedItems.length}</span>
              </span>
            </span>
            <BrushIcon
              name="chevron-down"
              size={11}
              className={`smm-drawer__chevron${expanded ? '' : ' is-collapsed'}`}
            />
          </>
        )}
      </button>

      {expanded && (
        <div {...look(mobileShell, 'smm-drawer__cols', LEGACY_DRAWER_COLS_STYLE)}>
          {/* Orphan libraryItems */}
          <div {...look(mobileShell, 'smm-drawer__col', LEGACY_DRAWER_COL_STYLE)}>
            <SubHeader kicker={t('memoMaterial.super.orphanHeader')} count={orphans.length} />
            <div {...look(mobileShell, 'smm-drawer__orphans', LEGACY_DRAWER_ORPHANS_STYLE, 'smm-scroll')}>
              {orphans.length === 0 &&
                (mobileShell ? (
                  <div style={{ ...LEGACY_DRAWER_EMPTY_STYLE, gridColumn: '1 / -1' }}>
                    {t('memoMaterial.super.noOrphans')}
                  </div>
                ) : (
                  <EmptyState
                    density="compact"
                    className="smm-drawer__empty"
                    message={t('memoMaterial.super.noOrphans')}
                  />
                ))}
              {orphans.map((mat) => (
                <LibraryItemCard
                  key={mat.id}
                  material={mat}
                  relations={[]}
                  editing={editingId === mat.id}
                  mobileActions={mobileShell}
                  onSetEditing={(on) => setEditingId(on ? mat.id : null)}
                  onOpenInSystem={() => openLibraryItemInSystem(mat)}
                  onOpenInApp={() => openLibraryItemInApp(mat)}
                  onUpdate={(updates) => libraryItemUsecases.updateLibraryItem(mat.id, updates)}
                  onDelete={() => libraryItemUsecases.removeLibraryItem(mat.id)}
                  onAddRelation={(t) =>
                    relationUsecases.addGenericAssociation('library_item', mat.id, t.kind, t.id)
                  }
                  onRemoveRelation={(t) => removeRelation('library_item', mat.id, t.kind, t.id)}
                  defaultExpanded
                />
              ))}
            </div>
          </div>

          {/* Resolved TODOs and comments */}
          <div {...look(mobileShell, 'smm-drawer__col', LEGACY_DRAWER_COL_STYLE)}>
            <SubHeader
              kicker={t('memoMaterial.super.resolvedHeader')}
              count={resolvedItems.length}
            />
            <div {...look(mobileShell, 'smm-drawer__resolved', LEGACY_DRAWER_RESOLVED_STYLE, 'smm-scroll')}>
              {resolvedItems.length === 0 &&
                (mobileShell ? (
                  <div style={LEGACY_DRAWER_EMPTY_STYLE}>
                    {t('memoMaterial.super.noResolved')}
                  </div>
                ) : (
                  <EmptyState density="compact" message={t('memoMaterial.super.noResolved')} />
                ))}
              {resolvedItems.map((c) => (
                <ResolvedRow
                  key={c.id}
                  item={c}
                  onReopen={() => commentUsecases.reopenComment(c.id)}
                  onDelete={() => commentUsecases.deleteComment(c.id)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SubHeader({ kicker, count }: { kicker: string; count: number }) {
  if (!getPlatformRuntime().isMobileShell) {
    return (
      <div className="smm-drawer__subhead smm-index">
        <span>{kicker}</span>
        <span className="smm-index-count">{count}</span>
      </div>
    );
  }
  return (
    <div
      style={{
        height: 26,
        flexShrink: 0,
        padding: '0 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderBottom: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper-deep) / 0.4)',
      }}
    >
      <LabelMono tone="ink-4">{kicker}</LabelMono>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'hsl(var(--ink-4))',
        }}
      >
        {count}
      </span>
    </div>
  );
}

/**
 * A resolved TODO or comment in the archive. Desktop: the whole row faded,
 * no wash; a TODO leads with the TODO card's glass check (pressing it
 * reopens), a comment with the comment mark; 「重开」 a text button and
 * delete the flat waste-basket.
 */
function ResolvedRow({
  item,
  onReopen,
  onDelete,
}: {
  item: Comment;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const text = extractTextFromCommentBody(item.bodyJson);
  if (!getPlatformRuntime().isMobileShell) {
    return (
      <div className="smm-resolved-row">
        {item.kind === 'todo' ? (
          <TodoStatusToggle resolved onToggle={onReopen} />
        ) : (
          <span className="smm-resolved-row__mark" aria-hidden="true">
            <BrushIcon name="comment" size={12} />
          </span>
        )}
        <span className="smm-resolved-row__text" title={text}>
          {text || t('memoMaterial.todo.empty')}
        </span>
        <Button variant="ghost" size="sm" onClick={onReopen} title={t('memoMaterial.archive.reopen')}>
          {t('memoMaterial.super.reopenShort')}
        </Button>
        <GhostIconButton
          size="sm"
          icon={<BrushIcon name="trash" size={12} />}
          onClick={onDelete}
          title={t('common.delete')}
          aria-label={t('common.delete')}
        />
      </div>
    );
  }
  return (
    <div
      style={{
        padding: '6px 10px',
        borderRadius: 3,
        background: 'hsl(var(--ink-1) / 0.03)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        opacity: 0.78,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'hsl(var(--story-3))',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: 'var(--font-sans)',
          fontSize: 12.5,
          color: 'hsl(var(--ink-2))',
          textDecoration: 'line-through',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={text}
      >
        {text || t('memoMaterial.todo.empty')}
      </div>
      <button
        onClick={onReopen}
        title={t('memoMaterial.archive.reopen')}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          padding: '1px 6px',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 2,
          background: 'transparent',
          color: 'hsl(var(--ink-3))',
          cursor: 'pointer',
        }}
      >
        {t('memoMaterial.super.reopenShort')}
      </button>
      <button
        onClick={onDelete}
        title={t('common.delete')}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          padding: '0 4px',
          border: 'none',
          background: 'transparent',
          color: 'hsl(var(--ink-4))',
          cursor: 'pointer',
        }}
      >
        <BrushIcon name="close" size={10} inline />
      </button>
    </div>
  );
}
