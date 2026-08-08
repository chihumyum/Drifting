import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import loglevel from 'loglevel';

import type { BookElement } from '../../domain/book-element';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookElement } from '../../usecase/useBookElement';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';
import { EntityCellContextMenu } from './EntityCellContextMenu';
import { ElementCategoryCreateMenu } from './ElementCategoryCreateMenu';
import { GroupHeaderCell } from './GroupHeaderCell';
import { ElementGroupPicker } from './ElementGroupPicker';
import { EntityHoverCard } from '../../features/entities/hover/EntityHoverCard';
import { ElementIdentityTile } from '../ui/ElementIdentityTile';
import {
  useHoverPreview,
  type EntityHoverTarget,
} from '../../features/entities/hover/entity-hover-card-model';
import { aggregateActivity } from './agentActivityBubble';
import { useEntityCellAction } from '../../hooks/useEntityCellAction';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import type { EditorType } from '../editor/EditorTopBar';
import type { WorkspaceTarget } from '../../features/workspace/navigation/workspace-target';

const log = loglevel.getLogger('ElementPanel');
log.setLevel(loglevel.levels.ERROR);

// 宽度低于此值时隐藏 cell 上的日期，优先保证 title 显示。
const DATE_HIDE_WIDTH = 200;

// Sentinel categoryId for elements whose categoryId is NULL — i.e. they
// belong to no category. Surfaced as a virtual "未分类" group rendered at
// the tail of the list. Used inside the panel only; never persisted.
const UNCATEGORIZED_ID = '__uncategorized__';
const UNCATEGORIZED_COLOR = 'hsl(var(--ink-4))';

const formatShortDate = (input: string | number | Date) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return sameYear ? `${month}/${day}` : `${d.getFullYear() % 100}/${month}/${day}`;
};

interface ElementPanelProps {
  presentation?: 'desktop' | 'mobile';
  activeTarget?: WorkspaceTarget | null;
  onPreviewTarget?: (target: WorkspaceTarget) => void;
}

export function ElementPanel({
  presentation = 'desktop',
  activeTarget = null,
  onPreviewTarget,
}: ElementPanelProps = {}) {
  const { t } = useTranslation();
  const { bookElements, bookElementCategories } = useDataStore();
  const { elementUi } = useUiStore();
  const sidebarWidth = useUiStore((s) => s.sidebars.left.width);
  const showDate = presentation === 'desktop' && sidebarWidth >= DATE_HIDE_WIDTH;
  const sortMode = useUiStore((s) => s.elementSortMode);
  const categorySortMode = useUiStore((s) => s.elementCategorySortMode);
  const viewMode = useUiStore((s) => s.elementPanelViewMode);
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedBookElementId =
    presentation === 'mobile' && activeTarget?.entityType === 'element'
      ? activeTarget.id
      : elementUi.selectedId;
  const activateTarget = useCallback(
    (target: WorkspaceTarget, options?: { preview?: boolean }) => {
      if (onPreviewTarget) onPreviewTarget(target);
      else openEntity(target, options);
    },
    [onPreviewTarget, openEntity],
  );
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentActivityStore((s) => s.touched);
  const agentPending = useAgentEditStore((s) => s.pending);
  const agentAdditions = useAgentEditStore((s) => s.additions);

  const activeProjectId = useMemo(() => {
    if (!projectId) {
      throw new Error('ElementPanel requires a non-empty projectId');
    }
    return projectId;
  }, [projectId]);

  const { createElement, updateElement } = useBookElement({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const { getCategoryColor } = useElementCategory({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(new Set());
  // Per-cell context menu — reuses the editor top-bar three-dot menu items
  // via EntityCellContextMenu so element & category context options stay in
  // lockstep with what the editor exposes.
  const dispatchEntityAction = useEntityCellAction();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entityType: EditorType;
    id: string;
  } | null>(null);
  // In-place "change group" picker (replaces the old jump-to-editor modal).
  const [groupPicker, setGroupPicker] = useState<{
    x: number;
    y: number;
    elementId: string;
  } | null>(null);
  const categoryCreateAnchorRef = useRef<HTMLButtonElement>(null);
  const [categoryCreateCategoryId, setCategoryCreateCategoryId] = useState<string | null>(null);
  const {
    preview: hoverPreview,
    onEnter: hoverEnter,
    onLeave: hoverLeave,
  } = useHoverPreview<EntityHoverTarget>();

  const toggleCategoryCollapsed = useCallback((id: string) => {
    setCollapsedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Sub-header collapse-all toggles between "expand all" and "collapse all".
  useEffect(() => {
    const handler = () => {
      setCollapsedCategoryIds((prev) => {
        if (prev.size === 0) return new Set(bookElementCategories.map((c) => c.id));
        return new Set();
      });
    };
    events.on('left-sidebar:collapse-all', handler);
    return () => events.off('left-sidebar:collapse-all', handler);
  }, [bookElementCategories]);

  const categoryById = useMemo(
    () => new Map(bookElementCategories.map((category) => [category.id, category])),
    [bookElementCategories],
  );

  const getCategoryLabel = useCallback(
    (categoryId: string) => {
      if (categoryId === UNCATEGORIZED_ID) return t('leftSidebar.uncategorized');
      return categoryById.get(categoryId)?.name ?? categoryId;
    },
    [categoryById, t],
  );

  // Are there any elements with no category? Drives whether we render the
  // virtual "未分类" group at the tail.
  const hasUncategorized = useMemo(() => bookElements.some((el) => !el.categoryId), [bookElements]);

  // Outer category order is independent from the element order inside each
  // category. Synthetic "未分类" remains pinned after every real category.
  const categoryIds = useMemo(() => {
    const ids = new Set<string>();
    bookElementCategories.forEach((category) => {
      if (category.id?.trim()) {
        ids.add(category.id.trim());
      }
    });
    bookElements.forEach((element) => {
      if (element.categoryId?.trim()) {
        ids.add(element.categoryId.trim());
      }
    });

    const result = Array.from(ids);
    result.sort((a, b) => {
      // 'others' is a legacy convention sink — keep it adjacent to 未分类 at
      // the tail regardless of the active sort mode.
      const labelA = getCategoryLabel(a);
      const labelB = getCategoryLabel(b);
      if (labelA === 'others') return 1;
      if (labelB === 'others') return -1;

      if (categorySortMode === 'createdAt') {
        const ca = categoryById.get(a)?.createdAt;
        const cb = categoryById.get(b)?.createdAt;
        // Categories synthesised purely from element rows (no real category
        // record) have no createdAt — sink them to the bottom of the real
        // categories so the list head stays stable.
        if (!ca && !cb) return labelA.localeCompare(labelB);
        if (!ca) return 1;
        if (!cb) return -1;
        if (ca === cb) return 0;
        return cb > ca ? 1 : -1; // desc — newest first
      }
      return labelA.localeCompare(labelB);
    });

    // "未分类" always renders last so real categories stay on top.
    if (hasUncategorized) result.push(UNCATEGORIZED_ID);

    return result;
  }, [
    bookElementCategories,
    bookElements,
    getCategoryLabel,
    hasUncategorized,
    categorySortMode,
    categoryById,
  ]);

  const elementsByCategory = useMemo(() => {
    const grouped: Record<string, BookElement[]> = {};
    categoryIds.forEach((categoryId) => {
      grouped[categoryId] = [];
    });

    bookElements.forEach((element) => {
      // Null categoryId (post-trash refactor: detached from a deleted
      // category) goes into the virtual UNCATEGORIZED_ID bucket. Any
      // remaining string id that isn't in categoryIds (orphan from a stale
      // row, very rare) gets its own bucket so it's at least visible.
      const categoryId = element.categoryId ? element.categoryId : UNCATEGORIZED_ID;
      if (!grouped[categoryId]) {
        grouped[categoryId] = [];
      }
      grouped[categoryId].push(element);
    });

    return grouped;
  }, [bookElements, categoryIds]);

  // Secondary grouping inside a category. Elements with the same groupName
  // are clumped together; null groupName goes into the "ungrouped" bucket and
  // is rendered last with no header. Named groups are always sorted
  // alphabetically by groupName — groupName has no createdAt, so the active
  // sort mode only controls element-level order *within* each group.
  const groupedByCategory = useMemo(() => {
    const out: Record<string, { groupName: string | null; items: BookElement[] }[]> = {};
    const elementCmp = (a: BookElement, b: BookElement) => {
      if (sortMode === 'createdAt') {
        if (a.createdAt === b.createdAt) return 0;
        return b.createdAt > a.createdAt ? 1 : -1; // desc
      }
      return (a.name || '').localeCompare(b.name || '', undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    };
    categoryIds.forEach((categoryId) => {
      const items = elementsByCategory[categoryId] ?? [];
      const buckets = new Map<string | null, BookElement[]>();
      items.forEach((el) => {
        const key = el.groupName?.trim() || null;
        const arr = buckets.get(key) ?? [];
        arr.push(el);
        buckets.set(key, arr);
      });
      buckets.forEach((arr) => arr.sort(elementCmp));
      const named: { groupName: string; items: BookElement[] }[] = [];
      let ungrouped: BookElement[] = [];
      buckets.forEach((arr, key) => {
        if (key === null) {
          ungrouped = arr;
        } else {
          named.push({ groupName: key, items: arr });
        }
      });
      named.sort((a, b) => a.groupName.localeCompare(b.groupName));
      out[categoryId] = [
        ...named.map((g) => ({ groupName: g.groupName as string | null, items: g.items })),
        ...(ungrouped.length > 0 ? [{ groupName: null as string | null, items: ungrouped }] : []),
      ];
    });
    return out;
  }, [categoryIds, elementsByCategory, sortMode]);

  const handleCreateElement = useCallback(
    async (categoryId: string) => {
      try {
        const created = await createElement({ categoryId });
        activateTarget({ entityType: 'element', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create element', error);
      }
    },
    [activateTarget, createElement],
  );

  // "+ element in this group" on a group header. The uncategorized bucket has
  // no real category to create under, so the group header skips the + there.
  const handleCreateElementInGroup = useCallback(
    async (categoryId: string, groupName: string) => {
      if (categoryId === UNCATEGORIZED_ID) return;
      try {
        const created = await createElement({ categoryId, groupName });
        activateTarget({ entityType: 'element', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create element in group', error);
      }
    },
    [activateTarget, createElement],
  );

  // Rename a secondary group: rewrite groupName on every element currently in
  // it. Empty name is treated as cancel (use the picker's "无分组" to ungroup).
  const handleRenameElementGroup = useCallback(
    async (items: BookElement[], nextName: string) => {
      const trimmed = nextName.trim();
      if (!trimmed) return;
      for (const el of items) {
        if (el.groupName === trimmed) continue;
        try {
          await updateElement(el.id, { groupName: trimmed });
        } catch (error) {
          log.error('Failed to rename element group', error);
        }
      }
    },
    [updateElement],
  );

  // Existing group names within a category — feeds the change-group combobox.
  const groupNamesByCategory = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const categoryId of Object.keys(groupedByCategory)) {
      out[categoryId] = (groupedByCategory[categoryId] ?? [])
        .map((g) => g.groupName)
        .filter((n): n is string => n != null);
    }
    return out;
  }, [groupedByCategory]);

  const renderElementCard = (element: BookElement, categoryId: string) => {
    const selected = element.id === selectedBookElementId;
    const agentBusy = `element:${element.id}` in agentActive;
    const agentAdded = !agentBusy && `element:${element.id}` in agentAdditions;
    // "M" on either an activity touch (summary/kv writes) OR a pending edit-store
    // change (e.g. an unreviewed patch create/soft-delete, which leaves no
    // activity dot) — mirrors how storyline/category cells flag both.
    const agentChanged =
      !agentBusy &&
      !agentAdded &&
      (`element:${element.id}` in agentTouched || `element:${element.id}` in agentPending);
    // The virtual "未分类" bucket isn't a real category — getCategoryColor
    // would log a not-found warning and return a flickering random color.
    const categoryColor =
      categoryId === UNCATEGORIZED_ID ? UNCATEGORIZED_COLOR : getCategoryColor(categoryId);

    return (
      <div
        key={element.id}
        style={{
          // Aligned with ChapterPanel renderNodeCard so all three left-bar
          // entity cells share the same row metrics — only the leading
          // chrome (stripe / diamond / drift glyph) differs.
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 14px 5px 22px',
          cursor: 'pointer',
          position: 'relative',
          background: selected ? 'hsl(var(--surface))' : 'transparent',
          color: selected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
          fontSize: 12.5,
          lineHeight: 1.35,
          transition: 'background 0.1s',
        }}
        onMouseEnter={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'var(--workspace-cell-hover-bg)';
          }
          hoverEnter({ kind: 'element', id: element.id }, event.currentTarget);
        }}
        onMouseLeave={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'transparent';
          }
          hoverLeave();
        }}
        onClick={() => {
          if (agentChanged) useAgentActivityStore.getState().clearTouched('element', element.id);
          activateTarget({ entityType: 'element', id: element.id });
        }}
        onDoubleClick={presentation === 'desktop' ? () => promoteCurrentTab() : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            entityType: 'element',
            id: element.id,
          });
        }}
      >
        {/* Element mark — diamond in category color. Sized to occupy the
            same 12px-wide slot the chapter stripe uses, so titles line up
            across panels. */}
        <span
          aria-hidden
          className={agentBusy ? 'agent-glyph-busy' : undefined}
          title={
            agentBusy
              ? t('agentActivity.working')
              : agentAdded || agentChanged
                ? t(agentAdded ? 'agentActivity.addedHere' : 'agentActivity.changedHere')
                : undefined
          }
          style={{
            // Done swaps the diamond for a plain Agent file marker; working/rest
            // keep the italic diamond.
            fontFamily: agentAdded || agentChanged ? 'var(--font-mono)' : 'var(--font-sans)',
            fontStyle: agentAdded || agentChanged ? 'normal' : 'italic',
            fontSize: agentAdded || agentChanged ? 10 : 11,
            fontWeight: agentAdded || agentChanged ? 600 : undefined,
            // Agent status overrides the category color: accent (lit) while
            // working, muted ink for the done "M". At rest, the category color.
            color: agentBusy
              ? 'hsl(var(--accent))'
              : agentAdded || agentChanged
                ? 'hsl(var(--ink-2))'
                : categoryColor,
            flexShrink: 0,
            lineHeight: 1,
            width: 12,
            textAlign: 'center',
          }}
        >
          {agentAdded ? 'A' : agentChanged ? 'M' : '◆'}
        </span>

        {/* Name */}
        <div
          className={`element-panel-item-label${selected ? ' is-selected' : ''}`}
          style={{
            flex: 1,
            minWidth: 0,
            color: 'inherit',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span>{element.name}</span>
        </div>

        {/* Date */}
        {showDate && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'hsl(var(--ink-4))',
              flexShrink: 0,
              letterSpacing: '0.04em',
            }}
          >
            {formatShortDate(element.updatedAt)}
          </span>
        )}
      </div>
    );
  };

  const renderCompactElement = (element: BookElement) => {
    const selected = element.id === selectedBookElementId;
    const agentBusy = `element:${element.id}` in agentActive;
    const agentAdded = !agentBusy && `element:${element.id}` in agentAdditions;
    const agentChanged =
      !agentBusy &&
      !agentAdded &&
      (`element:${element.id}` in agentTouched || `element:${element.id}` in agentPending);
    const agentState = agentBusy
      ? ('busy' as const)
      : agentAdded
        ? ('added' as const)
        : agentChanged
          ? ('changed' as const)
          : null;
    const agentStateLabel = agentBusy
      ? t('agentActivity.working')
      : agentAdded || agentChanged
        ? t(agentAdded ? 'agentActivity.addedHere' : 'agentActivity.changedHere')
        : undefined;
    return (
      <ElementIdentityTile
        key={element.id}
        element={element}
        selected={selected}
        agentState={agentState}
        agentStateLabel={agentStateLabel}
        onActivate={() => {
          if (agentChanged) useAgentActivityStore.getState().clearTouched('element', element.id);
          activateTarget({ entityType: 'element', id: element.id });
        }}
        onPromote={presentation === 'desktop' ? promoteCurrentTab : () => undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            entityType: 'element',
            id: element.id,
          });
        }}
        onPreviewEnter={(anchor) => hoverEnter({ kind: 'element', id: element.id }, anchor)}
        onPreviewLeave={hoverLeave}
      />
    );
  };

  const hasElements = bookElements.length > 0;

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        <div
          className="left-panel-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            paddingRight: 6,
          }}
        >
          {categoryIds.map((categoryId) => {
            const isUncategorized = categoryId === UNCATEGORIZED_ID;
            const categoryElements = elementsByCategory[categoryId] ?? [];
            const categoryHasElements = categoryElements.length > 0;
            const categoryCollapsed = !categoryHasElements || collapsedCategoryIds.has(categoryId);
            const categoryColor = isUncategorized
              ? UNCATEGORIZED_COLOR
              : getCategoryColor(categoryId);
            const compactIndex = viewMode === 'compact';
            // Bubble agent activity from this category's elements up to its
            // group header (#17).
            const activity = aggregateActivity(
              agentActive,
              agentTouched,
              categoryElements.map((el) => entityKey('element', el.id)),
            );
            const selfKey = entityKey('category', categoryId);
            const agentSelfBusy = !isUncategorized && selfKey in agentActive;
            const agentSelfChanged =
              !isUncategorized && (selfKey in agentTouched || selfKey in agentPending);
            return (
              <div
                key={categoryId}
                className={`left-sb-group${
                  compactIndex
                    ? ` element-category-section--compact ${
                        categoryCollapsed ? 'is-collapsed' : 'is-expanded'
                      }`
                    : ''
                }`}
                style={
                  compactIndex
                    ? ({ '--element-category-color': categoryColor } as CSSProperties)
                    : { marginBottom: 8 }
                }
              >
                <GroupHeaderCell
                  name={getCategoryLabel(categoryId)}
                  count={categoryElements.length}
                  color={categoryColor}
                  collapsed={categoryCollapsed}
                  onToggleCollapsed={() => {
                    if (categoryHasElements) toggleCategoryCollapsed(categoryId);
                  }}
                  collapseDisabled={compactIndex && !categoryHasElements}
                  collapseChrome={compactIndex ? 'frame' : 'chevron'}
                  onClick={
                    // The "未分类" bucket isn't a real category — there's no
                    // editor page to open. Real category labels always open
                    // their editor; the leading minus/square owns disclosure.
                    isUncategorized
                      ? undefined
                      : () => {
                          if (agentSelfChanged) {
                            useAgentActivityStore.getState().clearTouched('category', categoryId);
                          }
                          activateTarget({ entityType: 'category', id: categoryId });
                        }
                  }
                  onDoubleClick={
                    isUncategorized || presentation === 'mobile'
                      ? undefined
                      : () => {
                          if (compactIndex) {
                            activateTarget({ entityType: 'category', id: categoryId });
                          }
                          promoteCurrentTab();
                        }
                  }
                  onContextMenu={
                    isUncategorized
                      ? undefined
                      : (event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            entityType: 'category',
                            id: categoryId,
                          });
                        }
                  }
                  addButtonTitle={
                    isUncategorized ? undefined : t('elementCategoryCreateMenu.openCreateMenu')
                  }
                  // "未分类" has no real category, so it cannot own a creation
                  // menu. A real category's single + branches to element/group
                  // creation without adding a second permanent icon.
                  onAdd={
                    isUncategorized
                      ? undefined
                      : (event) => {
                          categoryCreateAnchorRef.current = event.currentTarget;
                          setCategoryCreateCategoryId((current) =>
                            current === categoryId ? null : categoryId,
                          );
                        }
                  }
                  addButtonHasPopup={isUncategorized ? undefined : 'menu'}
                  addButtonExpanded={categoryCreateCategoryId === categoryId}
                  addButtonVisibility={compactIndex ? 'always' : 'hover'}
                  sticky
                  agentBusy={activity.busy || agentSelfBusy}
                  agentDoneCount={activity.doneCount}
                  agentSelfChanged={agentSelfChanged}
                  agentSelfAdded={!isUncategorized && `category:${categoryId}` in agentAdditions}
                />

                {!categoryCollapsed &&
                  (() => {
                    const groups = groupedByCategory[categoryId] ?? [];
                    const lastNamedGroupIndex = groups.reduce(
                      (lastIndex, group, groupIndex) =>
                        group.groupName !== null ? groupIndex : lastIndex,
                      -1,
                    );
                    return groups.map((group, groupIndex) => {
                      const groupName = group.groupName;
                      const isNamedGroup = groupName !== null;
                      const cards = group.items.map((element) =>
                        compactIndex
                          ? renderCompactElement(element)
                          : renderElementCard(element, categoryId),
                      );
                      return (
                        <div
                          key={`${categoryId}::${groupName ?? '__ungrouped__'}`}
                          className={`element-category-group${
                            groupIndex === lastNamedGroupIndex
                              ? ' element-category-group--last-named'
                              : ''
                          }${isNamedGroup ? '' : ' element-category-group--ungrouped'}`}
                        >
                          {groupName !== null && (
                            <ElementGroupHeader
                              name={groupName}
                              count={group.items.length}
                              compact={compactIndex}
                              canAdd={categoryId !== UNCATEGORIZED_ID}
                              onRename={(next) => void handleRenameElementGroup(group.items, next)}
                              onAddElement={() =>
                                void handleCreateElementInGroup(categoryId, groupName)
                              }
                            />
                          )}
                          {compactIndex ? (
                            <div
                              className={`element-identity-flow${
                                isNamedGroup ? ' element-identity-flow--grouped' : ''
                              }`}
                            >
                              {cards}
                            </div>
                          ) : (
                            cards
                          )}
                        </div>
                      );
                    });
                  })()}
              </div>
            );
          })}

          {!hasElements && (
            <div
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-sans)',
                fontStyle: 'italic',
                color: 'hsl(var(--ink-3))',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              {t('leftSidebar.empty.noElements')}
            </div>
          )}
        </div>
      </div>

      {hoverPreview && (
        <EntityHoverCard
          target={hoverPreview.data}
          anchor={hoverPreview.anchor}
          placement="right-start"
        />
      )}

      {contextMenu && (
        <EntityCellContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          editorType={contextMenu.entityType}
          onAction={(action) => {
            // "Change Group" opens an in-place combobox here instead of routing
            // to the editor + modal (parallels the drift move-to-group flow).
            if (contextMenu.entityType === 'element' && action === 'groupPicker') {
              setGroupPicker({ x: contextMenu.x, y: contextMenu.y, elementId: contextMenu.id });
              return;
            }
            void dispatchEntityAction({
              entityType: contextMenu.entityType === 'element' ? 'element' : 'category',
              id: contextMenu.id,
              action,
            });
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {groupPicker &&
        (() => {
          const element = bookElements.find((e) => e.id === groupPicker.elementId);
          if (!element) return null;
          const catKey = element.categoryId ?? UNCATEGORIZED_ID;
          return (
            <ElementGroupPicker
              x={groupPicker.x}
              y={groupPicker.y}
              current={element.groupName}
              existing={groupNamesByCategory[catKey] ?? []}
              onPick={(groupName) => {
                void updateElement(groupPicker.elementId, { groupName });
              }}
              onClose={() => setGroupPicker(null)}
            />
          );
        })()}

      {categoryCreateCategoryId && (
        <ElementCategoryCreateMenu
          key={categoryCreateCategoryId}
          anchorRef={categoryCreateAnchorRef}
          categoryName={getCategoryLabel(categoryCreateCategoryId)}
          existingGroupNames={groupNamesByCategory[categoryCreateCategoryId] ?? []}
          onCreateElement={() => void handleCreateElement(categoryCreateCategoryId)}
          onCreateGroup={(groupName) =>
            void handleCreateElementInGroup(categoryCreateCategoryId, groupName)
          }
          onClose={() => setCategoryCreateCategoryId(null)}
        />
      )}
    </div>
  );
}
// Concise secondary-group (groupName) header inside a category. Keeps the
// minimal label style (rule tick + name + count) but adds: double-click to
// rename the whole group, and a hover-revealed "+" to create an element
// directly inside it. The shared inline-header hover selector scopes reveal to
// this label row, so a category hover cannot reveal every nested group action.
function ElementGroupHeader({
  name,
  count,
  compact,
  canAdd,
  onRename,
  onAddElement,
}: {
  name: string;
  count: number;
  compact: boolean;
  canAdd: boolean;
  onRename: (next: string) => void;
  onAddElement: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  // Guards against onBlur double-committing after Enter, or committing on
  // Escape (cancel) if the unmount happens to fire a blur.
  const handledRef = useRef(false);

  if (renaming) {
    return (
      <div style={{ padding: compact ? '4px 8px 2px' : '2px 10px 0 26px' }}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handledRef.current = true;
              onRename(draft);
              setRenaming(false);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              handledRef.current = true;
              setRenaming(false);
            }
          }}
          onBlur={() => {
            if (!handledRef.current) onRename(draft);
            setRenaming(false);
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '1px 5px',
            border: '1px solid hsl(var(--accent))',
            borderRadius: 3,
            background: 'hsl(var(--paper))',
            color: 'hsl(var(--ink-1))',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            outline: 'none',
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="left-sb-inline-group-header"
      onDoubleClick={() => {
        setDraft(name);
        handledRef.current = false;
        setRenaming(true);
      }}
      title={t('leftSidebar.groups.renameElementGroupTitle')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: compact ? '5px 8px 1px' : '2px 10px 0 26px',
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        lineHeight: 1.2,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: 'hsl(var(--ink-4))',
        cursor: 'default',
      }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 1, background: 'hsl(var(--rule))', flexShrink: 0 }}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </span>
      <span style={{ color: 'hsl(var(--ink-4))' }}>· {count}</span>
      {canAdd && (
        <button
          type="button"
          className="left-sb-group-add left-sb-inline-add-button"
          title={t('leftSidebar.groups.addElementToGroup')}
          onClick={(e) => {
            e.stopPropagation();
            onAddElement();
          }}
          // Always rendered so the row height stays constant; the shared CSS
          // only reveals it while this exact label row is hovered/focused.
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 15,
            height: 15,
            borderRadius: 3,
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
          }}
        >
          <Plus size={11} strokeWidth={1.8} />
        </button>
      )}
    </div>
  );
}
