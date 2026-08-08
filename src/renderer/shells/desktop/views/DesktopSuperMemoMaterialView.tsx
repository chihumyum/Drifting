import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../../store/data-store';
import { isChapter } from '../../../domain/book-node';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { useAuthStore } from '../../../store/auth';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useSuperViewEscapeStack } from '../../../hooks/useSuperViewEscapeStack';
import { DesktopSuperViewHeader } from '../components/DesktopSuperViewHeader';
import { SuperViewShell } from '../../../components/SuperViewShell';
import { FilterChip } from '../../../components/ui/FilterChip';
import { ContextMenuSurface } from '../../../components/ui/ContextMenuSurface';
import { GhostIconButton } from '../../../components/ui/GhostIconButton';
import { LabelMono } from '../../../components/ui/LabelMono';
import { useComment } from '../../../usecase/useComment';
import { useLibraryItem } from '../../../usecase/useLibraryItem';
import { useEntityRelations } from '../../../usecase/useEntityRelations';
import {
  LibraryItemCard,
  ComposeLibraryItemDialog,
  ComposeTodoDialog,
  LibraryItemFullscreenPreview,
  TextSnippetPopover,
  TodoCard,
  type FocusedEntity,
} from '../../../components/rightBars/MemoMaterialPanel';
import { EntityRelationPicker } from '../../../components/rightBars/EntityRelationPicker';
import { createPlainCommentDoc, extractTextFromCommentBody } from '../../../domain/comment';
import type { Comment } from '../../../domain/comment';
import type { LibraryItem, LibraryItemKind } from '../../../domain/library-item';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { assetCacheService } from '../../../services/asset-cache.service';
import { platform } from '../../../platform';

const KIND_ORDER: LibraryItemKind[] = ['image', 'pdf', 'url', 'text'];

const DRAWER_HEADER_HEIGHT = 28;
const DRAWER_MIN_HEIGHT = 120;
const DRAWER_DEFAULT_HEIGHT = 260;

const TODO_RAIL_WIDTH = 280;

/**
 * Global TODO & Library workbench — the project-wide counterpart to the
 * per-entity MemoMaterialPanel in the right sidebar.
 *
 * Layout (full-screen above BottomStatusBar, same shell as StoryGraphView /
 * SuperElementView):
 *  ┌── toolbar (search · kind chips · entity filter · +) ─┐
 *  ├──────────┬────────────────────────────────────────────┤
 *  │ TODO 板  │  LibraryItem 网格 (按 kind 分组)              │
 *  │ + 笔记   │                                            │
 *  ├──────────┴────────────────────────────────────────────┤
 *  │  ▾ 待整理 (orphan) · 已解决 (archive)                  │
 *  └────────────────────────────────────────────────────────┘
 *
 * Bottom drawer is collapsible (drag the top edge to resize when open).
 * All cards reuse the right-sidebar primitives so actions stay in sync.
 */
export function DesktopSuperMemoMaterialView() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const { setActive: setActiveSuperView } = useSuperViewNavigation();
  const closeView = useCallback(() => setActiveSuperView('none'), [setActiveSuperView]);

  const comments = useDataStore((s) => s.comments);
  const libraryItems = useDataStore((s) => s.libraryItems);
  const entityRelations = useDataStore((s) => s.entityRelations);
  const projectAssets = useDataStore((s) => s.projectAssets);

  const commentUsecases = useComment({ projectId, userId });
  const libraryItemUsecases = useLibraryItem({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });

  const [query, setQuery] = useState('');
  const [hiddenKinds, setHiddenKinds] = useState<Set<LibraryItemKind>>(() => new Set());
  const [entityFilter, setEntityFilter] = useState<FocusedEntity>({ kind: null, id: null });
  const [composeOpen, setComposeOpen] = useState<null | 'todo' | 'library_item'>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewLibraryItemId, setPreviewLibraryItemId] = useState<string | null>(null);
  const [textPopoverId, setTextPopoverId] = useState<string | null>(null);
  const [drawerExpanded, setDrawerExpanded] = useState(false);

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
        id: `material-preview:${previewLibraryItemId ?? ''}`,
        active: previewLibraryItemId !== null,
        onEscape: () => setPreviewLibraryItemId(null),
      },
      {
        id: `text-popover:${textPopoverId ?? ''}`,
        active: textPopoverId !== null,
        onEscape: () => setTextPopoverId(null),
      },
      {
        id: 'bottom-drawer',
        active: drawerExpanded,
        onEscape: () => setDrawerExpanded(false),
      },
    ],
    closeView,
  );

  // Group entityRelations by from-entity so each card can render its
  // relation chips and the filters can narrow to a specific target.
  const refsByFrom = useMemo(() => {
    const map = new Map<string, typeof entityRelations>();
    entityRelations.forEach((r) => {
      const key = `${r.fromKind}:${r.fromId}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    });
    return map;
  }, [entityRelations]);

  const isRelatedToEntity = useCallback(
    (fromKind: EntityKind, fromId: string) => {
      if (!entityFilter.kind || !entityFilter.id) return true;
      const refs = refsByFrom.get(`${fromKind}:${fromId}`) ?? [];
      return refs.some((r) => r.toKind === entityFilter.kind && r.toId === entityFilter.id);
    },
    [refsByFrom, entityFilter.kind, entityFilter.id],
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
          isRelatedToEntity('comment', c.id) &&
          matchesQuery(extractTextFromCommentBody(c.bodyJson)),
      ),
    [comments, isRelatedToEntity, matchesQuery],
  );

  const resolvedTodos = useMemo(
    () =>
      comments
        .filter(
          (c) =>
            c.kind === 'todo' &&
            c.status !== 'open' &&
            isRelatedToEntity('comment', c.id) &&
            matchesQuery(extractTextFromCommentBody(c.bodyJson)),
        )
        .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '')),
    [comments, isRelatedToEntity, matchesQuery],
  );

  const visibleLibraryItems = useMemo(
    () =>
      libraryItems.filter(
        (mat) => isRelatedToEntity('library_item', mat.id) && matchesQuery(mat.title, mat.bodyJson),
      ),
    [libraryItems, isRelatedToEntity, matchesQuery],
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

  const previewLibraryItem = useMemo(
    () => libraryItems.find((m) => m.id === previewLibraryItemId) ?? null,
    [libraryItems, previewLibraryItemId],
  );
  const textPopoverLibraryItem = useMemo(
    () => libraryItems.find((m) => m.id === textPopoverId) ?? null,
    [libraryItems, textPopoverId],
  );

  const openLibraryItemInSystem = useCallback(
    async (m: LibraryItem) => {
      if (m.kind === 'text') return;
      if (m.kind === 'url') {
        await platform.material.openExternal(m.uri);
        return;
      }
      let path = m.localPath ?? m.uri.replace(/^file:\/\//, '');
      if (m.source === 'r2' && m.assetId) {
        const asset = projectAssets.find((item) => item.id === m.assetId);
        if (!asset) return;
        try {
          const cached = await assetCacheService.ensureCachedVariant(projectId, asset, 'source');
          path = cached.filePath;
        } catch (error) {
          alert(t('memoMaterial.error.openFile', { error: String(error) }));
          return;
        }
      }
      if (!path) return;
      const res = await platform.material.openLocal(path);
      if (!res.ok) alert(t('memoMaterial.error.openFile', { error: res.error }));
    },
    [projectAssets, projectId, t],
  );

  const openLibraryItemInApp = useCallback(
    (m: LibraryItem) => {
      if (m.kind === 'url') {
        void openLibraryItemInSystem(m);
        return;
      }
      if (m.kind === 'text') {
        setTextPopoverId(m.id);
        return;
      }
      setPreviewLibraryItemId(m.id);
    },
    [openLibraryItemInSystem],
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
      const ref = entityRelations.find(
        (r) =>
          r.fromKind === fromKind && r.fromId === fromId && r.toKind === toKind && r.toId === toId,
      );
      if (ref) relationUsecases.removeRelation(ref.id);
    },
    [entityRelations, relationUsecases],
  );

  const focusedEntity: FocusedEntity = entityFilter;

  return (
    <SuperViewShell className="super-mm-overlay">
      {/* Top header — back + title + global search. LibraryItem-specific
          filters (KIND chips, entity-target filter) live inside the
          LibraryItemMain section header so the global header stays focused
          on cross-cutting controls. */}
      <DesktopSuperViewHeader
        title={t('memoMaterial.super.title')}
        meta={t('memoMaterial.super.meta', {
          todos: comments.filter((c) => c.kind === 'todo').length,
          materials: libraryItems.length,
        })}
        onBack={closeView}
        rightSlot={
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
        }
      />

      {/* One continuous body surface wraps the rail/main split and drawer
          above the shared status strip. */}
      <div className="super-view-body">
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <TodoRail
            openTodos={openTodos}
            commentUsecases={commentUsecases}
            relationUsecases={relationUsecases}
            entityRelations={entityRelations}
            onCompose={() => setComposeOpen('todo')}
          />

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
          resolvedTodos={resolvedTodos}
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
                relationUsecases.addRelation('comment', created.id, t.kind, t.id),
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
                relationUsecases.addRelation('library_item', mat.id, t.kind, t.id),
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

      {previewLibraryItem && (
        <LibraryItemFullscreenPreview
          key={previewLibraryItem.id}
          material={previewLibraryItem}
          onClose={() => setPreviewLibraryItemId(null)}
          onUpdate={(updates) =>
            libraryItemUsecases.updateLibraryItem(previewLibraryItem.id, updates)
          }
        />
      )}

      {textPopoverLibraryItem && (
        <TextSnippetPopover
          key={textPopoverLibraryItem.id}
          material={textPopoverLibraryItem}
          onClose={() => setTextPopoverId(null)}
          onExpand={() => {
            setTextPopoverId(null);
            setPreviewLibraryItemId(textPopoverLibraryItem.id);
          }}
          onUpdate={(updates) =>
            libraryItemUsecases.updateLibraryItem(textPopoverLibraryItem.id, updates)
          }
        />
      )}
    </SuperViewShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LibraryItem filter primitives — KindChip + EntityFilterButton, both used in
// the LibraryItemMain section header (previously lived in a top toolbar). The
// thin vertical divider used between filter groups is shared too.

function ToolbarDivider() {
  return (
    <div
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
// Entity-target filter — popover with EntityRelationPicker constrained to a
// single-select.

function EntityFilterButton({
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
  const { bookNodes, bookElements, storylines, bookElementCategories } = useDataStore();

  const label = useMemo(() => {
    if (!entityFilter.kind || !entityFilter.id) return t('memoMaterial.super.all');
    const { kind, id } = entityFilter;
    if (kind === 'node') {
      const n = bookNodes.find((x) => x.id === id);
      return n?.title || (n && isChapter(n) ? 'Untitled Chapter' : 'Untitled Drift');
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
          {!entityFilter.kind && <ChevronDown size={12} aria-hidden="true" />}
        </button>
        {entityFilter.kind && (
          <GhostIconButton
            size="sm"
            icon={<X size={13} aria-hidden="true" />}
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
// TodoRail — left column. TODOs on top (action surface), pure notes below.

function TodoRail({
  openTodos,
  commentUsecases,
  relationUsecases,
  entityRelations,
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
  onCompose: () => void;
}) {
  const { t } = useTranslation();
  const renderTodo = (todo: Comment) => {
    const relations = entityRelations
      .filter((r) => r.fromKind === 'comment' && r.fromId === todo.id)
      .map((r) => ({ id: r.id, toKind: r.toKind, toId: r.toId }));
    return (
      <TodoCard
        key={todo.id}
        todo={todo}
        relations={relations}
        onResolve={() => commentUsecases.resolveComment(todo.id)}
        onDelete={() => commentUsecases.deleteComment(todo.id)}
        onAddRelation={(t) => relationUsecases.addRelation('comment', todo.id, t.kind, t.id)}
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
      style={{
        width: TODO_RAIL_WIDTH,
        flexShrink: 0,
        borderRight: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper-deep) / 0.35)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
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
            ＋
          </button>
        }
      />
      <div
        className="smm-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '6px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {openTodos.length === 0 && <RailEmpty hint={t('memoMaterial.super.todoEmptyHint')} />}
        {openTodos.map(renderTodo)}
      </div>
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

function LibraryItemMain({
  libraryItemsByKind,
  totalVisible,
  totalLibraryItems,
  hiddenKinds,
  onToggleKind,
  kindCounts,
  entityFilter,
  onEntityFilterChange,
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
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* LibraryItem section header: kicker + count on the left, then KIND
          chips and entity filter (moved down from the global header), then
          the new-material action on the right. Taller than the default
          SectionHeader because it needs to host the filter group inline. */}
      <div
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
        <div style={{ display: 'flex', gap: 4 }}>
          {KIND_ORDER.map((k) => (
            <KindChip
              key={k}
              active={!hiddenKinds.has(k)}
              count={kindCounts[k] ?? 0}
              onClick={() => onToggleKind(k)}
            >
              {t(`memoMaterial.kind.${k}`, { defaultValue: k })}
            </KindChip>
          ))}
        </div>

        <ToolbarDivider />

        <EntityFilterButton entityFilter={entityFilter} onChange={onEntityFilterChange} />

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
          {t('memoMaterial.super.newMaterialButton')}
        </button>
      </div>

      <div
        className="smm-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '10px 16px 18px',
        }}
      >
        {totalVisible === 0 && (
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
                  {t('memoMaterial.super.newMaterialButton')}
                </button>
              </>
            ) : (
              t('memoMaterial.super.noFilteredMaterials')
            )}
          </div>
        )}

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
  return (
    <section style={{ marginBottom: 18 }}>
      <div
        style={{
          ...kickerStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 8,
          paddingBottom: 4,
          borderBottom: '1px dashed hsl(var(--rule))',
        }}
      >
        <span>{t(`memoMaterial.kind.${kind}`, { defaultValue: kind })}</span>
        <span style={{ color: 'hsl(var(--ink-4))' }}>{items.length}</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 10,
          alignItems: 'start',
        }}
      >
        {items.map((mat) => (
          <LibraryItemCard
            key={mat.id}
            material={mat}
            relations={refsByFrom.get(`library_item:${mat.id}`) ?? []}
            editing={editingId === mat.id}
            onSetEditing={(on) => setEditingId(on ? mat.id : null)}
            onOpenInSystem={() => openLibraryItemInSystem(mat)}
            onOpenInApp={() => openLibraryItemInApp(mat)}
            onUpdate={(updates) => libraryItemUsecases.updateLibraryItem(mat.id, updates)}
            onDelete={() => libraryItemUsecases.removeLibraryItem(mat.id)}
            onRetryUpload={() => libraryItemUsecases.retryLibraryItemUpload(mat.id)}
            onAddRelation={(t) =>
              relationUsecases.addRelation('library_item', mat.id, t.kind, t.id)
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
// Body is a 2-column split: orphan libraryItems | resolved memos.

function BottomDrawer({
  expanded,
  onExpandedChange,
  orphans,
  resolvedTodos,
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
  resolvedTodos: Comment[];
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
  const [height, setHeight] = useState(DRAWER_DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleDragMove = useCallback((e: PointerEvent) => {
    const state = dragRef.current;
    if (!state) return;
    const delta = state.startY - e.clientY;
    setHeight(Math.max(DRAWER_MIN_HEIGHT, state.startHeight + delta));
  }, []);

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
      style={{
        height: drawerHeight,
        flexShrink: 0,
        borderTop: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper-deep) / 0.5)',
        display: 'flex',
        flexDirection: 'column',
        transition: dragging ? 'none' : 'height 0.18s ease',
      }}
    >
      <div
        onPointerDown={handleDragStart}
        style={{
          height: 4,
          marginTop: -2,
          cursor: expanded ? 'ns-resize' : 'default',
          userSelect: 'none',
        }}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        style={{
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
        }}
        aria-expanded={expanded}
        title={
          expanded ? t('memoMaterial.super.collapseDrawer') : t('memoMaterial.super.expandDrawer')
        }
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span>
            {t('memoMaterial.super.orphans')}{' '}
            <span style={{ color: 'hsl(var(--ink-4))' }}>{orphans.length}</span>
          </span>
          <span style={{ color: 'hsl(var(--ink-5))' }}>·</span>
          <span>
            {t('memoMaterial.super.resolved')}{' '}
            <span style={{ color: 'hsl(var(--ink-4))' }}>{resolvedTodos.length}</span>
          </span>
        </span>
        <ChevronUp
          size={12}
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.18s ease',
          }}
        />
      </button>

      {expanded && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 1,
            background: 'hsl(var(--rule))',
          }}
        >
          {/* Orphan libraryItems */}
          <div
            style={{
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              background: 'hsl(var(--paper))',
            }}
          >
            <SubHeader kicker={t('memoMaterial.super.orphanHeader')} count={orphans.length} />
            <div
              className="smm-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: '8px 12px 12px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: 8,
                alignContent: 'start',
              }}
            >
              {orphans.length === 0 && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    padding: '20px 8px',
                    fontFamily: 'var(--font-sans)',
                    fontStyle: 'italic',
                    fontSize: 12,
                    color: 'hsl(var(--ink-4))',
                    textAlign: 'center',
                  }}
                >
                  {t('memoMaterial.super.noOrphans')}
                </div>
              )}
              {orphans.map((mat) => (
                <LibraryItemCard
                  key={mat.id}
                  material={mat}
                  relations={[]}
                  editing={editingId === mat.id}
                  onSetEditing={(on) => setEditingId(on ? mat.id : null)}
                  onOpenInSystem={() => openLibraryItemInSystem(mat)}
                  onOpenInApp={() => openLibraryItemInApp(mat)}
                  onUpdate={(updates) => libraryItemUsecases.updateLibraryItem(mat.id, updates)}
                  onDelete={() => libraryItemUsecases.removeLibraryItem(mat.id)}
                  onRetryUpload={() => libraryItemUsecases.retryLibraryItemUpload(mat.id)}
                  onAddRelation={(t) =>
                    relationUsecases.addRelation('library_item', mat.id, t.kind, t.id)
                  }
                  onRemoveRelation={(t) => removeRelation('library_item', mat.id, t.kind, t.id)}
                  defaultExpanded
                />
              ))}
            </div>
          </div>

          {/* Resolved memos */}
          <div
            style={{
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              background: 'hsl(var(--paper))',
            }}
          >
            <SubHeader
              kicker={t('memoMaterial.super.resolvedHeader')}
              count={resolvedTodos.length}
            />
            <div
              className="smm-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: '6px 12px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {resolvedTodos.length === 0 && (
                <div
                  style={{
                    padding: '20px 8px',
                    fontFamily: 'var(--font-sans)',
                    fontStyle: 'italic',
                    fontSize: 12,
                    color: 'hsl(var(--ink-4))',
                    textAlign: 'center',
                  }}
                >
                  {t('memoMaterial.super.noResolvedTodos')}
                </div>
              )}
              {resolvedTodos.map((c) => (
                <ResolvedTodoRow
                  key={c.id}
                  todo={c}
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

function ResolvedTodoRow({
  todo,
  onReopen,
  onDelete,
}: {
  todo: Comment;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const text = extractTextFromCommentBody(todo.bodyJson);
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
        ×
      </button>
    </div>
  );
}
