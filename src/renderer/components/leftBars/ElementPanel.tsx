import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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
import { GroupHeaderCell } from './GroupHeaderCell';
import { ElementGroupPicker } from './ElementGroupPicker';
import { PanelHoverPreview } from './PanelHoverPreview';
import { aggregateActivity } from './agentActivityBubble';
import { useEntityCellAction } from '../../hooks/useEntityCellAction';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import type { EditorType } from '../editor/EditorTopBar';

const log = loglevel.getLogger('ElementPanel');
log.setLevel(loglevel.levels.ERROR);

// 宽度低于此值时隐藏 cell 上的日期，优先保证 title 显示。
const DATE_HIDE_WIDTH = 200;

// Sentinel categoryId for elements whose categoryId is NULL — i.e. they
// belong to no category. Surfaced as a virtual "未分类" group rendered at
// the tail of the list. Used inside the panel only; never persisted.
const UNCATEGORIZED_ID = '__uncategorized__';
const UNCATEGORIZED_LABEL = '未分类';
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

export function ElementPanel() {
  const { bookElements, bookElementCategories } = useDataStore();
  const { elementUi } = useUiStore();
  const sidebarWidth = useUiStore((s) => s.sidebars.left.width);
  const showDate = sidebarWidth >= DATE_HIDE_WIDTH;
  const sortMode = useUiStore((s) => s.elementSortMode);
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedBookElementId = elementUi.selectedId;
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentActivityStore((s) => s.touched);
  const agentPending = useAgentEditStore((s) => s.pending);

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

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const categorySectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const footerScrollRef = useRef<HTMLDivElement | null>(null);
  const footerChipRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  // While a manual chip click is in effect, ignore scroll-driven updates so
  // the highlighted chip stays put even when the section can't fully scroll
  // to the anchor (e.g. last category near the end of the list).
  const manualActiveLockUntilRef = useRef<number>(0);

  // Footer height. null means "use natural one-row height + horizontal scroll".
  // Once dragged taller than the natural row, the inner scroll switches to
  // vertical with chips wrapping onto multiple lines. Persisted in ui-store.
  const footerHeight = useUiStore((s) => s.elementCategoryFooterHeight);
  const setFooterHeight = useUiStore((s) => s.setElementCategoryFooterHeight);
  const minFooterHeightRef = useRef<number>(0);
  // Per-cell context menu — reuses the editor top-bar three-dot menu items
  // via EntityCellContextMenu so element & category context options stay in
  // lockstep with what the editor exposes.
  const dispatchEntityAction = useEntityCellAction();
  const [contextMenu, setContextMenu] = useState<
    | { x: number; y: number; entityType: EditorType; id: string }
    | null
  >(null);
  // In-place "change group" picker (replaces the old jump-to-editor modal).
  const [groupPicker, setGroupPicker] = useState<
    { x: number; y: number; elementId: string } | null
  >(null);
  const [hoverPreview, setHoverPreview] = useState<{
    element: BookElement;
    categoryColor: string;
    top: number;
    left: number;
  } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

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

  // Track which category section is currently at the top of the scroll
  // viewport, so the footer chip can highlight it.
  const updateActiveFromScroll = useCallback(() => {
    if (Date.now() < manualActiveLockUntilRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    // anchor a little below the top edge so the highlight flips as a category
    // header crosses past it
    const anchorY = containerRect.top + 8;

    let bestId: string | null = null;
    let bestTop = -Infinity;
    categorySectionRefs.current.forEach((el, id) => {
      const rect = el.getBoundingClientRect();
      // pick the last section whose top is at or above the anchor
      if (rect.top <= anchorY && rect.top > bestTop) {
        bestTop = rect.top;
        bestId = id;
      }
    });
    // fallback: first visible section
    if (!bestId) {
      let firstId: string | null = null;
      let firstTop = Infinity;
      categorySectionRefs.current.forEach((el, id) => {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > containerRect.top && rect.top < firstTop) {
          firstTop = rect.top;
          firstId = id;
        }
      });
      bestId = firstId;
    }
    setActiveCategoryId((prev) => (prev === bestId ? prev : bestId));
  }, []);

  // Auto-scroll the footer so the active chip stays in view.
  useEffect(() => {
    if (!activeCategoryId) return;
    const footer = footerScrollRef.current;
    const chip = footerChipRefs.current.get(activeCategoryId);
    if (!footer || !chip) return;
    const footerRect = footer.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    if (chipRect.left < footerRect.left + 8) {
      footer.scrollBy({ left: chipRect.left - footerRect.left - 16, behavior: 'smooth' });
    } else if (chipRect.right > footerRect.right - 8) {
      footer.scrollBy({ left: chipRect.right - footerRect.right + 16, behavior: 'smooth' });
    }
  }, [activeCategoryId]);

  const startFooterResize = useCallback((event: React.MouseEvent) => {
    if (!footerScrollRef.current) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = footerScrollRef.current.offsetHeight;
    const min = minFooterHeightRef.current || startHeight;

    const onMove = (ev: MouseEvent) => {
      const next = startHeight + (startY - ev.clientY);
      const max = Math.max(min, Math.round(window.innerHeight * 0.5));
      const clamped = Math.max(min, Math.min(max, next));
      // Snap back to "natural" when within a couple px of the min.
      setFooterHeight(clamped <= min + 2 ? null : clamped);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [setFooterHeight]);

  const scrollToCategory = useCallback((categoryId: string) => {
    // Lock the highlight to the clicked chip first. If the section can fully
    // scroll to the anchor, normal tracking would arrive at the same chip
    // once the lock expires; if it can't (last category near the bottom), the
    // chip stays selected until the user manually scrolls again.
    setActiveCategoryId(categoryId);
    manualActiveLockUntilRef.current = Date.now() + 700;
    const section = categorySectionRefs.current.get(categoryId);
    const container = scrollContainerRef.current;
    if (!section || !container) return;
    const sectionRect = section.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const delta = sectionRect.top - containerRect.top;
    container.scrollBy({ top: delta, behavior: 'smooth' });
  }, []);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleRowHoverEnter = useCallback(
    (element: BookElement, categoryColor: string, rect: DOMRect) => {
      clearHoverTimer();
      hoverTimerRef.current = window.setTimeout(() => {
        setHoverPreview({
          element,
          categoryColor,
          top: rect.top,
          left: rect.right + 8,
        });
      }, 220);
    },
    [clearHoverTimer],
  );

  const handleRowHoverLeave = useCallback(() => {
    clearHoverTimer();
    setHoverPreview(null);
  }, [clearHoverTimer]);

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

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
      if (categoryId === UNCATEGORIZED_ID) return UNCATEGORIZED_LABEL;
      return categoryById.get(categoryId)?.name ?? categoryId;
    },
    [categoryById],
  );

  // Are there any elements with no category? Drives whether we render the
  // virtual "未分类" group at the tail.
  const hasUncategorized = useMemo(
    () => bookElements.some((el) => !el.categoryId),
    [bookElements],
  );

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

      if (sortMode === 'createdAt') {
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
  }, [bookElementCategories, bookElements, getCategoryLabel, hasUncategorized, sortMode, categoryById]);

  // Lower bound for the resize gesture = natural one-row footer height.
  // Prefer measuring directly when footerHeight is null (the footer is at its
  // natural size). Otherwise derive it from a single chip's height plus the
  // footer's own padding+border — measuring offsetHeight while an explicit
  // height is applied would lock min to the persisted value, causing later
  // drags to jump straight past the 2-row size.
  useLayoutEffect(() => {
    if (!footerScrollRef.current) return;
    if (footerHeight == null) {
      minFooterHeightRef.current = footerScrollRef.current.offsetHeight;
      return;
    }
    const firstChip = footerChipRefs.current.values().next().value;
    if (firstChip) {
      // footer paddingTop + paddingBottom + borderTop
      minFooterHeightRef.current = firstChip.offsetHeight + 6 + 6 + 1;
    }
  }, [footerHeight, categoryIds.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    updateActiveFromScroll();
    container.addEventListener('scroll', updateActiveFromScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', updateActiveFromScroll);
    };
  }, [updateActiveFromScroll, categoryIds, collapsedCategoryIds]);

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
        openEntity({ entityType: 'element', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create element', error);
      }
    },
    [createElement, openEntity],
  );

  // "+ element in this group" on a group header. The uncategorized bucket has
  // no real category to create under, so the group header skips the + there.
  const handleCreateElementInGroup = useCallback(
    async (categoryId: string, groupName: string) => {
      if (categoryId === UNCATEGORIZED_ID) return;
      try {
        const created = await createElement({ categoryId, groupName });
        openEntity({ entityType: 'element', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create element in group', error);
      }
    },
    [createElement, openEntity],
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

  const renderElementCard = (element: BookElement, categoryId: string, elementIndex: number) => {
    const selected = element.id === selectedBookElementId;
    const agentBusy = `element:${element.id}` in agentActive;
    // "M" on either an activity touch (summary/kv writes) OR a pending edit-store
    // change (e.g. an unreviewed patch create/soft-delete, which leaves no
    // activity dot) — mirrors how storyline/category cells flag both.
    const agentChanged =
      !agentBusy &&
      (`element:${element.id}` in agentTouched || `element:${element.id}` in agentPending);
    // The virtual "未分类" bucket isn't a real category — getCategoryColor
    // would log a not-found warning and return a flickering random color.
    const categoryColor =
      categoryId === UNCATEGORIZED_ID ? UNCATEGORIZED_COLOR : getCategoryColor(categoryId);

    return (
      <div
        key={element.id}
        data-category-id={categoryId}
        data-element-index={elementIndex}
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
          background: selected ? 'hsl(var(--accent) / 0.10)' : 'transparent',
          color: selected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
          fontSize: 12.5,
          lineHeight: 1.35,
          transition: 'background 0.1s',
        }}
        onMouseEnter={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'hsl(var(--ink-1) / 0.03)';
          }
          handleRowHoverEnter(
            element,
            categoryColor,
            event.currentTarget.getBoundingClientRect(),
          );
        }}
        onMouseLeave={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'transparent';
          }
          handleRowHoverLeave();
        }}
        onClick={() => {
          if (agentChanged) useAgentActivityStore.getState().clearTouched('element', element.id);
          openEntity({ entityType: 'element', id: element.id });
        }}
        onDoubleClick={() => {
          promoteCurrentTab();
        }}
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
        {selected && (
          <span
            aria-hidden
            className="cell-accent-stripe"
            style={{
              position: 'absolute',
              left: 0,
              top: 4,
              bottom: 4,
              width: 2,
              background: 'hsl(var(--accent))',
            }}
          />
        )}

        {/* Element mark — diamond in category color. Sized to occupy the
            same 12px-wide slot the chapter stripe uses, so titles line up
            across panels. */}
        <span
          aria-hidden
          className={agentBusy ? 'agent-glyph-busy' : undefined}
          title={agentBusy ? 'Agent 正在处理' : agentChanged ? 'Agent 刚改动了这里' : undefined}
          style={{
            // Done swaps the diamond for a plain mono "M" marker; working/rest
            // keep the italic serif diamond.
            fontFamily: agentChanged ? 'var(--font-mono)' : 'var(--font-serif)',
            fontStyle: agentChanged ? 'normal' : 'italic',
            fontSize: agentChanged ? 10 : 11,
            fontWeight: agentChanged ? 600 : undefined,
            // Agent status overrides the category color: accent (lit) while
            // working, muted ink for the done "M". At rest, the category color.
            color: agentBusy
              ? 'hsl(var(--accent))'
              : agentChanged
                ? 'hsl(var(--ink-2))'
                : categoryColor,
            flexShrink: 0,
            lineHeight: 1,
            width: 12,
            textAlign: 'center',
          }}
        >
          {agentChanged ? 'M' : '◆'}
        </span>

        {/* Name */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: 'inherit',
            fontWeight: selected ? 500 : 400,
            letterSpacing: '-0.005em',
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
          ref={scrollContainerRef}
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
            // Bubble agent activity from this category's elements up to its
            // group header (#17).
            const activity = aggregateActivity(
              agentActive,
              agentTouched,
              (elementsByCategory[categoryId] ?? []).map((el) =>
                entityKey('element', el.id),
              ),
            );
            return (
            <div
              key={categoryId}
              ref={(el) => {
                if (el) categorySectionRefs.current.set(categoryId, el);
                else categorySectionRefs.current.delete(categoryId);
              }}
              data-category-section={categoryId}
              style={{ marginBottom: 8 }}
            >
              <GroupHeaderCell
                name={getCategoryLabel(categoryId)}
                count={(elementsByCategory[categoryId] ?? []).length}
                color={isUncategorized ? UNCATEGORIZED_COLOR : getCategoryColor(categoryId)}
                collapsed={collapsedCategoryIds.has(categoryId)}
                onToggleCollapsed={() => toggleCategoryCollapsed(categoryId)}
                onClick={
                  // The "未分类" bucket isn't a real category — there's no
                  // editor page to open. Click is a no-op except for the
                  // toggle handled by the disclosure caret.
                  isUncategorized
                    ? undefined
                    : () => openEntity({ entityType: 'category', id: categoryId })
                }
                onDoubleClick={isUncategorized ? undefined : () => promoteCurrentTab()}
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
                  isUncategorized ? undefined : 'New element in this category'
                }
                // Creating a new element in "未分类" means categoryId=null;
                // we don't surface that affordance — users should pick a real
                // category. Setting onAdd to undefined hides the + button.
                onAdd={
                  isUncategorized ? undefined : () => void handleCreateElement(categoryId)
                }
                sticky
                agentBusy={activity.busy}
                agentDoneCount={activity.doneCount}
                agentSelfChanged={
                  !isUncategorized &&
                  (`category:${categoryId}` in agentTouched ||
                    `category:${categoryId}` in agentPending)
                }
              />

              {!collapsedCategoryIds.has(categoryId) &&
                (() => {
                  const groups = groupedByCategory[categoryId] ?? [];
                  let elementIndex = 0;
                  return groups.map((group) => {
                    const cards = group.items.map((element) => {
                      const card = renderElementCard(element, categoryId, elementIndex);
                      elementIndex += 1;
                      return card;
                    });
                    return (
                      <div key={`${categoryId}::${group.groupName ?? '__ungrouped__'}`}>
                        {group.groupName !== null && (
                          <ElementGroupHeader
                            name={group.groupName}
                            count={group.items.length}
                            canAdd={categoryId !== UNCATEGORIZED_ID}
                            onRename={(next) => void handleRenameElementGroup(group.items, next)}
                            onAddElement={() =>
                              void handleCreateElementInGroup(categoryId, group.groupName as string)
                            }
                          />
                        )}
                        {cards}
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
                fontFamily: 'var(--font-serif)',
                fontStyle: 'italic',
                color: 'hsl(var(--ink-3))',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              no elements yet.
            </div>
          )}
        </div>

        {/* Category footer — horizontal chips; highlights the section currently
            scrolled into view and lets the user jump between categories. */}
        {categoryIds.length > 0 && (
          <div
            ref={footerScrollRef}
            className="left-panel-cat-footer"
            style={{
              position: 'relative',
              flexShrink: 0,
              display: 'flex',
              alignItems: footerHeight == null ? 'center' : 'flex-start',
              flexWrap: footerHeight == null ? 'nowrap' : 'wrap',
              alignContent: 'flex-start',
              gap: 4,
              padding: '6px 8px',
              overflowX: footerHeight == null ? 'auto' : 'hidden',
              overflowY: footerHeight == null ? 'hidden' : 'auto',
              borderTop: '1px solid hsl(var(--rule))',
              background: 'hsl(var(--paper))',
              whiteSpace: footerHeight == null ? 'nowrap' : 'normal',
              height: footerHeight ?? undefined,
            }}
          >
            {/* Invisible drag handle on the top border — no extra UI. */}
            <div
              onMouseDown={startFooterResize}
              title="拖拽调整高度"
              style={{
                position: 'absolute',
                top: -3,
                left: 0,
                right: 0,
                height: 6,
                cursor: 'ns-resize',
                zIndex: 5,
              }}
            />
            {categoryIds.map((categoryId) => {
              const active = categoryId === activeCategoryId;
              const color =
                categoryId === UNCATEGORIZED_ID
                  ? UNCATEGORIZED_COLOR
                  : getCategoryColor(categoryId);
              return (
                <button
                  key={categoryId}
                  ref={(el) => {
                    if (el) footerChipRefs.current.set(categoryId, el);
                    else footerChipRefs.current.delete(categoryId);
                  }}
                  onClick={() => scrollToCategory(categoryId)}
                  title={getCategoryLabel(categoryId)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    flexShrink: 0,
                    padding: '3px 8px',
                    border: '1px solid',
                    borderColor: active ? 'hsl(var(--ink-1))' : 'hsl(var(--rule))',
                    borderRadius: 3,
                    background: active ? 'hsl(var(--ink-1))' : 'transparent',
                    color: active ? 'hsl(var(--paper))' : 'hsl(var(--ink-3))',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    transition: 'background 0.12s, color 0.12s, border-color 0.12s',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 2,
                      background: color,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      maxWidth: 96,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {getCategoryLabel(categoryId)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {hoverPreview && (
        <PanelHoverPreview
          glyph="◆"
          accentColor={hoverPreview.categoryColor}
          title={hoverPreview.element.name}
          summary={hoverPreview.element.summary}
          top={hoverPreview.top}
          left={hoverPreview.left}
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

      {groupPicker && (() => {
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

      {/* Hide the vertical scrollbar on the inner scroll container and the
          horizontal scrollbar on the category footer (scroll still works). */}
      <style>{`
        .left-panel-scroll { scrollbar-width: none; }
        .left-panel-scroll::-webkit-scrollbar { width: 0; height: 0; display: none; }
        .left-panel-cat-footer { scrollbar-width: none; }
        .left-panel-cat-footer::-webkit-scrollbar { width: 0; height: 0; display: none; }
      `}</style>
    </div>
  );
}

// Concise secondary-group (groupName) header inside a category. Keeps the
// minimal label style (rule tick + name + count) but adds: double-click to
// rename the whole group, and a hover-revealed "+" to create an element
// directly inside it. Self-contained hover state — avoids touching the global
// .left-sb-group CSS (which would also flip the category header's + button).
function ElementGroupHeader({
  name,
  count,
  canAdd,
  onRename,
  onAddElement,
}: {
  name: string;
  count: number;
  canAdd: boolean;
  onRename: (next: string) => void;
  onAddElement: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  // Guards against onBlur double-committing after Enter, or committing on
  // Escape (cancel) if the unmount happens to fire a blur.
  const handledRef = useRef(false);

  if (renaming) {
    return (
      <div style={{ padding: '2px 10px 0 26px' }}>
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={() => {
        setDraft(name);
        handledRef.current = false;
        setRenaming(true);
      }}
      title="双击重命名分组"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px 0 26px',
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
      {canAdd && hovered && (
        <button
          type="button"
          title="在此分组新建元素"
          onClick={(e) => {
            e.stopPropagation();
            onAddElement();
          }}
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 15,
            height: 15,
            borderRadius: 3,
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'hsl(var(--paper-deep))';
            e.currentTarget.style.color = 'hsl(var(--ink-1))';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'hsl(var(--ink-4))';
          }}
        >
          <Plus size={11} strokeWidth={1.8} />
        </button>
      )}
    </div>
  );
}
