import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../../store/data-store';
import { isChapter, isDrift as isDriftNode } from '../../../domain/book-node';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import {
  useUiStore,
  useProjectTabs,
  tabKey,
  focusedLeafOf,
  type AnyTab,
  type CreateTab,
  type LeafTab,
  type SplitTab,
  type TabEntityType,
} from '../../../store/ui-store';
import { TabContextMenu, type TabMenuItem } from './TabContextMenu';

// Build the editor URL for a leaf — needed when activating a tab, since
// openEntity is unsuitable for tab activation: it can short-circuit on
// the all-chapters singleton fast-path, and in split mode it would mutate
// the *current* active split's focused side instead of switching.
function urlForLeaf(
  projectId: string,
  leaf: { entityType: TabEntityType; id: string },
): string | null {
  switch (leaf.entityType) {
    case 'node':
      return `/project/${projectId}/editor/${leaf.id}`;
    case 'storyline':
      return `/project/${projectId}/editor/storyline/${leaf.id}`;
    case 'element':
      return `/project/${projectId}/element/${leaf.id}`;
    case 'category':
      return `/project/${projectId}/category/${encodeURIComponent(leaf.id)}`;
    case 'all-chapters':
      return `/project/${projectId}/editor/all`;
  }
}

// Floor: absolute survival width — chrome (icon + close) just fits, label
// area collapses. Tabs may dip below this only if their idealW is naturally
// smaller (which can't happen since idealW ≥ chrome).
const TAB_FLOOR_WIDTH = 56;
// Min: the *readable* threshold. When proportional shrink would push the
// longest tab below this, the virtual canvas doubles and tabs spread out
// again — the bar grows wider (overflowX:auto scrolls), but each tab stays
// readable.
const TAB_MIN_WIDTH = 120;
// Max: per-tab cap so a runaway title doesn't dominate the bar in Phase A.
const TAB_MAX_WIDTH = 320;
// 0 (not just small): any positive gap between tabs is a window-drag region.
// Tauri excludes each role="tab" descendant from native dragging, while a 2px
// empty seam could still start a window drag and swallow horizontal scrolling.
const TAB_GAP = 0;
const CONTAINER_PADDING_X = 20;
// A split slot carries two sub-labels and reads as ~1.6 leaf tabs wide.
const SPLIT_WEIGHT = 1.6;

// Hidden DOM span used to measure label widths in the *actual* rendered font.
// canvas measureText can't resolve `var(--font-sans)` and silently falls back
// to a different system font — the resulting under/over-estimate is what was
// causing tabs to truncate labels even in Phase A.
const labelMeasureEl: HTMLSpanElement | null = (() => {
  if (typeof document === 'undefined') return null;
  const span = document.createElement('span');
  span.style.cssText = [
    'position:absolute',
    'visibility:hidden',
    'pointer-events:none',
    'top:-9999px',
    'left:-9999px',
    'white-space:nowrap',
    'font-family:var(--font-sans), -apple-system, BlinkMacSystemFont, sans-serif',
    'font-size:12.5px',
    'font-weight:400',
    'letter-spacing:-0.005em',
  ].join(';');
  document.body.appendChild(span);
  return span;
})();

function measureLabelWidth(text: string): number {
  if (!labelMeasureEl) return Math.ceil(text.length * 8);
  labelMeasureEl.textContent = text;
  return Math.ceil(labelMeasureEl.getBoundingClientRect().width);
}

// Chrome layout on a leaf tab:
//   paddingL 10 + icon 14 + gap 6 + label + gap 6 + closeMargin 2 + close 16 + paddingR 6
// (the flex container has gap:6 between *every* adjacent pair — there are
// two gaps with three children, both must be counted.)
const TAB_CHROME_WIDTH = 10 + 14 + 6 + 6 + 2 + 16 + 6;
// Split tab = two SplitSubLabel slots around a 1px divider. Each sub-label:
//   paddingL 8 + icon 12 + gap 5 + label + gap 5 + close 14 + paddingR 6 = 50 + label
// Total chrome = 50 + 50 + 1 (divider) = 101.
const SPLIT_CHROME_WIDTH = 50 + 50 + 1;

// Tab bar glyph. For node entities, the caller passes isDrift so chapters
// (§) can be distinguished from drift nodes (❦ — matches the
// "灵感" button in LeftSidebarHeader). All-chapters uses ☰ so the bar
// glance.
function getTabIcon(entityType: TabEntityType, opts?: { isDrift?: boolean }): string {
  switch (entityType) {
    case 'node':
      return opts?.isDrift ? '❦' : '§';
    case 'storyline':
      return '¶';
    case 'element':
      return '◆';
    case 'category':
      return '⌘';
    case 'all-chapters':
      return '☰';
  }
}

export function TopTimeline() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId, openEntity } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const openCreateTab = useUiStore((s) => s.openCreateTab);
  const closeTab = useUiStore((s) => s.closeTab);
  const closeOtherTabs = useUiStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useUiStore((s) => s.closeTabsToRight);
  const closeAllTabs = useUiStore((s) => s.closeAllTabs);
  const closeSplitSide = useUiStore((s) => s.closeSplitSide);
  const splitActiveWith = useUiStore((s) => s.splitActiveWith);
  const unsplitTab = useUiStore((s) => s.unsplitTab);
  const swapSplitPanes = useUiStore((s) => s.swapSplitPanes);
  const extractFromSplit = useUiStore((s) => s.extractFromSplit);
  const setSplitFocus = useUiStore((s) => s.setSplitFocus);
  const promoteTab = useUiStore((s) => s.promoteTab);
  const reorderTabs = useUiStore((s) => s.reorderTabs);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const storylines = useDataStore((s) => s.storylines);
  const bookElements = useDataStore((s) => s.bookElements);
  const bookElementCategories = useDataStore((s) => s.bookElementCategories);
  const primaryStorylineByNode = useDataStore((s) => s.primaryStorylineByNode);

  // The active tab paints its own static rectangular state. The container ref
  // remains the authority for width allocation, drag/drop and scrolling.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  // Where the dragged tab would land if dropped right now. `side` is which
  // half of the hovered tab the cursor is on — drop becomes "insert at
  // index" (before) or "insert at index+1" (after) in the *original* tabs
  // array. The pre-removal indices are translated to a `reorderTabs` arg
  // at drop time (see handleDrop).
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    side: 'before' | 'after';
    indicatorX: number;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: TabMenuItem[];
  } | null>(null);

  // Translate a (hovered-index, side) drop target into the toIndex that
  // `reorderTabs` expects (insertion index in the post-removal array).
  // Returns null when the drop is a no-op (would put the tab back where it
  // started).
  const computeReorderTarget = useCallback(
    (from: number, target: { index: number; side: 'before' | 'after' }) => {
      const insertion = target.side === 'before' ? target.index : target.index + 1;
      // After removing `from`, indices > from shift left by one.
      const adjusted = from < insertion ? insertion - 1 : insertion;
      return adjusted === from ? null : adjusted;
    },
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const lookups = useMemo(() => {
    const labelOfLeaf = (leaf: LeafTab): string => {
      switch (leaf.entityType) {
        case 'node': {
          const n = bookNodes.find((b) => b.id === leaf.id);
          if (!n) return t('topTimeline.untitled.chapter');
          if (n.title) return n.title;
          return isChapter(n) ? t('topTimeline.untitled.chapter') : t('topTimeline.untitled.drift');
        }
        case 'storyline':
          return (
            storylines.find((s) => s.id === leaf.id)?.name || t('topTimeline.untitled.storyline')
          );
        case 'element':
          return (
            bookElements.find((e) => e.id === leaf.id)?.name || t('topTimeline.untitled.element')
          );
        case 'category':
          return (
            bookElementCategories.find((c) => c.id === leaf.id)?.name ||
            t('topTimeline.untitled.category')
          );
        case 'all-chapters':
          return t('topTimeline.singletons.allChapters');
      }
    };
    const colorOfLeaf = (leaf: LeafTab): string | undefined => {
      switch (leaf.entityType) {
        case 'node': {
          const n = bookNodes.find((b) => b.id === leaf.id);
          if (!n) return undefined;
          const primaryId = primaryStorylineByNode[n.id] ?? null;
          return primaryId ? storylines.find((s) => s.id === primaryId)?.color : undefined;
        }
        case 'storyline':
          return storylines.find((s) => s.id === leaf.id)?.color;
        case 'element': {
          const e = bookElements.find((b) => b.id === leaf.id);
          if (!e) return undefined;
          return bookElementCategories.find((c) => c.id === e.categoryId)?.color;
        }
        case 'category':
          return bookElementCategories.find((c) => c.id === leaf.id)?.color;
        case 'all-chapters':
          // Singletons share the neutral ink color — no entity behind them
          // that carries a palette, and a fixed accent would compete with
          // the surrounding tabs.
          return undefined;
      }
    };
    const isDriftLeaf = (leaf: LeafTab): boolean => {
      if (leaf.entityType !== 'node') return false;
      const n = bookNodes.find((b) => b.id === leaf.id);
      return Boolean(n) && isDriftNode(n!);
    };
    return { labelOfLeaf, colorOfLeaf, isDriftLeaf };
  }, [bookNodes, storylines, bookElements, bookElementCategories, primaryStorylineByNode, t]);

  // Three-phase tab sizing:
  //
  //   A. Plenty of space (idealTotal ≤ availableW)
  //      Each tab is exactly its ideal width — label + chrome, capped at MAX
  //      to keep one long title from dominating. Empty space hangs off the
  //      right end.
  //
  //   B. Cramped (idealTotal > availableW)
  //      Tabs shrink proportionally by a single scale factor, so every tab
  //      keeps its share of the bar relative to its title length. Short tabs
  //      stay smaller than long ones.
  //
  //   C. Virtual canvas expansion
  //      If the scale in B would push the longest tab below TAB_MIN_WIDTH
  //      (readable threshold), the virtual canvas doubles (visible × 2, × 4,
  //      …) until the longest tab is back at or above MIN. The bar then
  //      exceeds visible width and overflowX:auto on the container lets the
  //      user scroll. This trades scroll distance for readability — exactly
  //      the spec'd behavior.
  //
  // Splits count as SPLIT_WEIGHT leaf-units throughout (for ideal width and
  // for the MIN/FLOOR clamps), so a fused tab gets ~1.6× the space.
  const tabWidths = useMemo(() => {
    if (openTabs.length === 0) return [] as number[];
    const weights = openTabs.map((t) => (t.kind === 'split' ? SPLIT_WEIGHT : 1));
    const ideals = openTabs.map((tab, i) => {
      const raw =
        tab.kind === 'leaf'
          ? measureLabelWidth(lookups.labelOfLeaf(tab)) + TAB_CHROME_WIDTH
          : tab.kind === 'create'
            ? measureLabelWidth(t('topTimeline.newTab')) + TAB_CHROME_WIDTH
            : measureLabelWidth(lookups.labelOfLeaf(tab.left)) +
              measureLabelWidth(lookups.labelOfLeaf(tab.right)) +
              SPLIT_CHROME_WIDTH;
      return Math.min(TAB_MAX_WIDTH * weights[i], raw);
    });
    const totalGaps = TAB_GAP * Math.max(0, openTabs.length - 1);
    // Preserve the document-tab sizing contract. The adjacent `+` is a
    // separate strip item and may extend the scrollable content; it must not
    // make every existing tab enter proportional shrink earlier.
    const availableW = Math.max(0, containerWidth - CONTAINER_PADDING_X - totalGaps);
    const idealTotal = ideals.reduce((a, b) => a + b, 0);

    // Phase A — or initial render before ResizeObserver fires.
    if (containerWidth === 0 || idealTotal <= availableW) {
      return ideals.map((w, i) => Math.max(TAB_FLOOR_WIDTH * weights[i], Math.floor(w)));
    }

    // Phase B/C — proportional shrink, expanding the virtual canvas in 2×
    // steps until the per-unit longest tab stays ≥ MIN.
    const perUnit = ideals.map((w, i) => w / weights[i]);
    const maxPerUnit = Math.max(...perUnit);
    let virtual = availableW;
    // Cap iterations: log2(32) = 5 doublings is more headroom than any
    // realistic tab count needs, and guards against degenerate inputs.
    for (let k = 0; k < 5 && (virtual / idealTotal) * maxPerUnit < TAB_MIN_WIDTH; k++) {
      virtual *= 2;
    }
    const scale = Math.min(1, virtual / idealTotal);
    return ideals.map((w, i) => Math.max(TAB_FLOOR_WIDTH * weights[i], Math.floor(w * scale)));
  }, [openTabs, lookups, containerWidth, t]);

  // A narrow insertion marker translates between drag-and-drop positions.
  // It is reorder feedback, independent of the static active-tab treatment.
  // DOM geometry is captured by the drag event that creates the target. This
  // keeps ref reads in an event handler (where React permits them) instead of
  // reading the container ref during render.
  const dropIndicatorStyle: React.CSSProperties =
    dropTarget && dragFromIndex !== null && computeReorderTarget(dragFromIndex, dropTarget) !== null
      ? { transform: `translateX(${dropTarget.indicatorX}px)`, opacity: 1 }
      : { opacity: 0 };

  // When the active tab changes (or the layout shifts enough to push it out of
  // view), scroll the bar so the active tab is fully visible. Without this,
  // activating a tab via shortcut / split focus change / URL nav can leave the
  // active tab inside the horizontal overflow with no visual cue.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !activeTabKey) return;
    const activeEl = container.querySelector(
      `[data-tab-key="${CSS.escape(activeTabKey)}"]`,
    ) as HTMLElement | null;
    if (!activeEl) return;
    const cRect = container.getBoundingClientRect();
    const eRect = activeEl.getBoundingClientRect();
    if (eRect.left < cRect.left) {
      container.scrollBy({ left: eRect.left - cRect.left - 8, behavior: 'auto' });
    } else if (eRect.right > cRect.right) {
      container.scrollBy({ left: eRect.right - cRect.right + 8, behavior: 'auto' });
    }
  }, [activeTabKey, tabWidths, containerWidth, containerRef]);

  // Click a top-level tab. Tab activation always bypasses openEntity:
  //   - splits would otherwise have their focused side replaced (openEntity
  //     treats them as "active is split → swap focused side"),
  //   - node leaves would short-circuit when the current active is the
  //     all-chapters singleton (openEntity scrolls instead of switching).
  // setActiveTab + navigate(url) keeps both flows clean and uniform.
  const handleSelectTab = useCallback(
    (tab: AnyTab) => {
      if (!projectId) return;
      if (tab.kind === 'create') {
        setActiveTab(projectId, { createId: tab.id });
        navigate(`/project/${projectId}/new`);
        return;
      }
      if (tab.kind === 'split') {
        setActiveTab(projectId, { splitId: tab.id });
        const focused = focusedLeafOf(tab);
        const url = focused ? urlForLeaf(projectId, focused) : null;
        if (url) navigate(url);
        return;
      }
      setActiveTab(projectId, { entityType: tab.entityType, id: tab.id });
      const url = urlForLeaf(projectId, tab);
      if (url) navigate(url);
    },
    [projectId, setActiveTab, navigate],
  );

  const handleCloseTab = useCallback(
    (tab: AnyTab) => {
      if (!projectId) return;
      const closeRef =
        tab.kind === 'split'
          ? { splitId: tab.id }
          : tab.kind === 'create'
            ? { createId: tab.id }
            : { entityType: tab.entityType, id: tab.id };
      const { nextActive, wasActive } = closeTab(projectId, closeRef);
      // Three cases:
      //   1. nextActive → closed the active tab AND a sibling took over.
      //      Sync URL to the new active leaf.
      //   2. wasActive && !nextActive → closed the LAST tab. Send the URL
      //      to a blank project route so the URL → tab sync doesn't
      //      reopen the just-closed entity, and Project Home shows.
      //   3. !wasActive → closed a non-active tab. URL and active tab are
      //      unchanged; do nothing. This used to call navigateToHome()
      //      here, which used to mutate the background tab collection.
      if (nextActive) {
        openEntity({ entityType: nextActive.entityType, id: nextActive.id });
      } else if (wasActive) {
        navigate(`/project/${projectId}`, { replace: true });
      }
    },
    [projectId, closeTab, openEntity, navigate],
  );

  const handlePromote = useCallback(
    (tab: AnyTab) => {
      if (!projectId || tab.kind !== 'leaf' || !tab.isPreview) return;
      promoteTab(projectId, { entityType: tab.entityType, id: tab.id });
    },
    [projectId, promoteTab],
  );

  // Build the menu items for right-clicking a top-level tab. Per the
  // requirement that there be no distinction between "sub-tab menu" and
  // "outer menu" inside a split, each side of a split surfaces all the same
  // operations — both per-side (close this side / extract / swap) and
  // whole-tab (close, close others, close all, unsplit).
  const buildMenuItems = useCallback(
    (tab: AnyTab, tabIndex: number, sideHint?: 'left' | 'right'): TabMenuItem[] => {
      if (!projectId) return [];
      const items: TabMenuItem[] = [];

      // "Open in left/right pane" is only meaningful for a non-active leaf —
      // splitting the active tab against itself produces no useful pane, and
      // a split tab can't be folded into another tab.
      const activeTabRef = openTabs.find((t) => tabKey(t) === activeTabKey);
      const activeFocused = activeTabRef ? focusedLeafOf(activeTabRef) : null;
      const isLeafSameAsActiveFocused =
        tab.kind === 'leaf' &&
        activeFocused !== null &&
        activeFocused.entityType === tab.entityType &&
        activeFocused.id === tab.id;
      const allowSplitOpen =
        tab.kind === 'leaf' && activeTabRef !== undefined && !isLeafSameAsActiveFocused;
      // Per-side operations only make sense inside a split. Each operation
      // that can change the active tab follows up with an openEntity() call
      // so the URL races EditorShell's own URL→tab sync — without this,
      // closing a side leaves the URL pointing at the just-closed entity
      // and EditorShell re-adds it as a fresh preview tab.
      if (tab.kind === 'split') {
        const side = sideHint ?? tab.focused;
        items.push(
          {
            label: t('topTimeline.menu.closePane'),
            onClick: () => {
              const { nextActive } = closeSplitSide(projectId, tab.id, side);
              if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            },
          },
          {
            label: t('topTimeline.menu.extractTab'),
            onClick: () => {
              const { nextActive } = extractFromSplit(projectId, tab.id, side);
              if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            },
          },
          {
            label: t('topTimeline.menu.swapPanes'),
            onClick: () => swapSplitPanes(projectId, tab.id),
          },
          { separator: true },
          {
            label: t('topTimeline.menu.unsplit'),
            onClick: () => {
              const { nextActive } = unsplitTab(projectId, tab.id);
              if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            },
          },
          { separator: true },
        );
      }

      // Whole-tab close / split operations, applicable to both leaves and
      // splits.
      const tabKeyStr = tabKey(tab);
      items.push({
        label: t('topTimeline.menu.close'),
        accelerator: 'Cmd+W',
        onClick: () => handleCloseTab(tab),
        disabled: tab.kind === 'create' && tab.draft.status === 'creating',
      });

      // Split-create options only on leaves — splitting an already-split tab
      // doesn't add a third pane.
      if (tab.kind === 'leaf') {
        items.push(
          {
            label: t('topTimeline.menu.openRight'),
            onClick: () => splitActiveWith(projectId, { fromKey: tabKeyStr }, 'right'),
            disabled: !allowSplitOpen,
          },
          {
            label: t('topTimeline.menu.openLeft'),
            onClick: () => splitActiveWith(projectId, { fromKey: tabKeyStr }, 'left'),
            disabled: !allowSplitOpen,
          },
        );
      }

      items.push(
        { separator: true },
        {
          label: t('topTimeline.menu.closeOthers'),
          onClick: () => {
            const { nextActive } = closeOtherTabs(projectId, tabKeyStr);
            if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            else navigate(`/project/${projectId}`, { replace: true });
          },
          disabled: openTabs.length <= 1,
        },
        {
          label: t('topTimeline.menu.closeRight'),
          onClick: () => {
            const { nextActive } = closeTabsToRight(projectId, tabKeyStr);
            if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
          },
          disabled: tabIndex >= openTabs.length - 1,
        },
        {
          label: t('topTimeline.menu.closeAll'),
          onClick: () => {
            closeAllTabs(projectId);
            // Land on the bare project URL so the Layout URL → tab sync
            // doesn't reopen whatever the URL had been pointing at, and
            // Project Home renders without creating another tab.
            navigate(`/project/${projectId}`, { replace: true });
          },
          disabled: openTabs.length === 0,
        },
      );

      return items;
    },
    [
      projectId,
      openTabs,
      activeTabKey,
      handleCloseTab,
      openEntity,
      navigate,
      closeOtherTabs,
      closeTabsToRight,
      closeAllTabs,
      closeSplitSide,
      extractFromSplit,
      swapSplitPanes,
      unsplitTab,
      splitActiveWith,
      t,
    ],
  );

  return (
    <div
      ref={containerRef}
      className="top-timeline-container"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 42,
        gap: TAB_GAP,
        overflowX: 'auto',
        overflowY: 'hidden',
        width: '100%',
        paddingLeft: 4,
        paddingRight: 16,
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        WebkitOverflowScrolling: 'touch',
        // The drop marker positions against this strip.
        position: 'relative',
      }}
    >
      <div className="tab-drop-indicator" style={dropIndicatorStyle} aria-hidden />
      {openTabs.map((tab, index) => {
        const key = tabKey(tab);
        const isActive = key === activeTabKey;
        const isDragging = dragFromIndex === index;
        const width = tabWidths[index] ?? TAB_MIN_WIDTH;
        const onDragOverSlot = (event: React.DragEvent<HTMLDivElement>) => {
          if (dragFromIndex === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          const isRightHalf = event.clientX >= rect.left + rect.width / 2;
          // Normalize seam targeting so the boundary between tab i and
          // tab i+1 has exactly one visual position: "right half of i" is
          // rewritten as "before tab i+1". Without this, the indicator
          // jumps by ~2px as the cursor crosses the seam (each tab paints
          // its own edge inside its own box). Last tab keeps `after` so
          // the user can drop past the end.
          const targetIndex = isRightHalf && index + 1 < openTabs.length ? index + 1 : index;
          const side: 'before' | 'after' =
            isRightHalf && targetIndex === index ? 'after' : 'before';
          const targetTab = openTabs[targetIndex];
          const targetElement = targetTab
            ? containerRef.current?.querySelector<HTMLElement>(
                `[data-tab-key="${CSS.escape(tabKey(targetTab))}"]`,
              )
            : null;
          if (!targetElement) return;
          const DROP_INDICATOR_WIDTH = 3;
          const indicatorX =
            side === 'before'
              ? targetElement.offsetLeft - DROP_INDICATOR_WIDTH / 2
              : targetElement.offsetLeft + targetElement.offsetWidth - DROP_INDICATOR_WIDTH / 2;
          setDropTarget((prev) =>
            prev &&
            prev.index === targetIndex &&
            prev.side === side &&
            prev.indicatorX === indicatorX
              ? prev
              : { index: targetIndex, side, indicatorX },
          );
        };
        const onDropSlot = (event: React.DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (projectId && dragFromIndex !== null && dropTarget !== null) {
            const to = computeReorderTarget(dragFromIndex, dropTarget);
            if (to !== null) reorderTabs(projectId, dragFromIndex, to);
          }
          setDragFromIndex(null);
          setDropTarget(null);
        };
        // Fires on the drag source when the drag ends — success or cancel.
        // Must clear `dropTarget` too, otherwise the indicator lingers after
        // a cancelled drop (drop fired outside the bar). Also arm the drop
        const onDragEndSlot = () => {
          setDragFromIndex(null);
          setDropTarget(null);
        };

        if (tab.kind === 'create') {
          return (
            <CreateTabSlot
              key={key}
              tab={tab}
              isActive={isActive}
              width={width}
              label={t('topTimeline.newTab')}
              onSelect={() => handleSelectTab(tab)}
              onClose={() => handleCloseTab(tab)}
              onContextMenu={(x, y) => setContextMenu({ x, y, items: buildMenuItems(tab, index) })}
              onDragOverSlot={onDragOverSlot}
              onDropSlot={onDropSlot}
            />
          );
        }

        if (tab.kind === 'leaf') {
          return (
            <LeafTabSlot
              key={key}
              tab={tab}
              index={index}
              isActive={isActive}
              isDragging={isDragging}
              width={width}
              label={lookups.labelOfLeaf(tab)}
              color={lookups.colorOfLeaf(tab)}
              isDrift={lookups.isDriftLeaf(tab)}
              setDragFromIndex={setDragFromIndex}
              onDragOverSlot={onDragOverSlot}
              onDropSlot={onDropSlot}
              onDragEndSlot={onDragEndSlot}
              onSelect={() => handleSelectTab(tab)}
              onPromote={() => handlePromote(tab)}
              onClose={() => handleCloseTab(tab)}
              onContextMenu={(x, y) => setContextMenu({ x, y, items: buildMenuItems(tab, index) })}
            />
          );
        }

        return (
          <SplitTabSlot
            key={key}
            tab={tab}
            index={index}
            isActive={isActive}
            isDragging={isDragging}
            width={width}
            leftLabel={lookups.labelOfLeaf(tab.left)}
            rightLabel={lookups.labelOfLeaf(tab.right)}
            leftColor={lookups.colorOfLeaf(tab.left)}
            rightColor={lookups.colorOfLeaf(tab.right)}
            leftIsDrift={lookups.isDriftLeaf(tab.left)}
            rightIsDrift={lookups.isDriftLeaf(tab.right)}
            setDragFromIndex={setDragFromIndex}
            onDragOverSlot={onDragOverSlot}
            onDropSlot={onDropSlot}
            onDragEndSlot={onDragEndSlot}
            onSelectSide={(side) => {
              if (!projectId) return;
              // Always activate the split first (no-op when it's already
              // active), so when we navigate the URL change lands on this
              // split's focused side and not the previously-active split's.
              setActiveTab(projectId, { splitId: tab.id });
              setSplitFocus(projectId, tab.id, side);
              const leaf = side === 'left' ? tab.left : tab.right;
              const url = urlForLeaf(projectId, leaf);
              if (url) navigate(url);
            }}
            onCloseSide={(side) => {
              if (!projectId) return;
              const { nextActive } = closeSplitSide(projectId, tab.id, side);
              if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            }}
            onContextMenu={(x, y, side) =>
              setContextMenu({ x, y, items: buildMenuItems(tab, index, side) })
            }
          />
        );
      })}

      <button
        type="button"
        className="top-timeline-create-button"
        aria-label={t('topTimeline.newEntity')}
        title={t('topTimeline.newEntity')}
        onClick={() => {
          if (!projectId) return;
          openCreateTab(projectId);
          navigate(`/project/${projectId}/new`);
        }}
      >
        <Plus size={16} strokeWidth={1.8} aria-hidden />
      </button>

      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function CreateTabSlot({
  tab,
  isActive,
  width,
  label,
  onSelect,
  onClose,
  onContextMenu,
  onDragOverSlot,
  onDropSlot,
}: {
  tab: CreateTab;
  isActive: boolean;
  width: number;
  label: string;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
  onDragOverSlot: (event: React.DragEvent<HTMLDivElement>) => void;
  onDropSlot: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  const isCreating = tab.draft.status === 'creating';
  return (
    <div
      role="tab"
      aria-selected={isActive}
      data-tab-key={tabKey(tab)}
      className={`app-tab app-tab--create${isActive ? ' is-active' : ''}`}
      onClick={onSelect}
      onDragOver={onDragOverSlot}
      onDrop={onDropSlot}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      style={{ width, minWidth: TAB_FLOOR_WIDTH }}
    >
      <Plus size={14} strokeWidth={1.8} aria-hidden />
      <span className="app-tab--create__label">{label}</span>
      <button
        type="button"
        className="app-tab__close"
        aria-label={t('topTimeline.closeTab')}
        title={t('topTimeline.closeTab')}
        disabled={isCreating}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

interface LeafSlotProps {
  tab: LeafTab;
  index: number;
  isActive: boolean;
  isDragging: boolean;
  width: number;
  label: string;
  color: string | undefined;
  isDrift: boolean;
  setDragFromIndex: (idx: number | null) => void;
  onDragOverSlot: (event: React.DragEvent<HTMLDivElement>) => void;
  onDropSlot: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEndSlot: () => void;
  onSelect: () => void;
  onPromote: () => void;
  onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
}

function LeafTabSlot({
  tab,
  index,
  isActive,
  isDragging,
  width,
  label,
  color,
  isDrift,
  setDragFromIndex,
  onDragOverSlot,
  onDropSlot,
  onDragEndSlot,
  onSelect,
  onPromote,
  onClose,
  onContextMenu,
}: LeafSlotProps) {
  const { t } = useTranslation();
  const accent = color || 'hsl(var(--ink-3))';
  return (
    <div
      role="tab"
      aria-selected={isActive}
      data-tab-key={tabKey(tab)}
      className={`app-tab${isActive ? ' is-active' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey(tab));
        // Custom format used by the editor area to detect "this is a tab
        // being dragged from the bar" (separate from text/plain so we don't
        // confuse it with other text drags).
        event.dataTransfer.setData('application/x-drifting-tab', tabKey(tab));
        // Force the drag image to be the tab itself, anchored at the cursor's
        // grab point. Without this, Chromium on macOS falls back to the
        // `text/plain` data as the drag chip (label-only), making it look
        // like the tab isn't moving.
        const rect = event.currentTarget.getBoundingClientRect();
        event.dataTransfer.setDragImage(
          event.currentTarget,
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
        setDragFromIndex(index);
      }}
      onDragOver={onDragOverSlot}
      onDrop={onDropSlot}
      onDragEnd={onDragEndSlot}
      onClick={onSelect}
      onDoubleClick={onPromote}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
      style={
        {
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 10,
          paddingRight: 6,
          width,
          minWidth: TAB_FLOOR_WIDTH,
          background: isActive ? 'hsl(var(--surface))' : 'transparent',
          opacity: isDragging ? 0.5 : 1,
          cursor: 'pointer',
          transition: 'opacity 0.12s ease',
          fontFamily: 'var(--font-sans)',
          fontSize: 12.5,
          color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
          // Constant weight: bolding the active tab widens its glyphs, so at
          // the same fixed tab width the SELECTED label ellipsized earlier
          // than unselected ones. Emphasis comes from a metric-neutral
          // text-shadow instead.
          fontWeight: 400,
          textShadow: isActive ? '0 0 0.6px currentcolor' : 'none',
          fontStyle: tab.isPreview ? 'italic' : 'normal',
          borderBottom: isActive
            ? '1px solid hsl(var(--surface))'
            : '1px solid hsl(var(--rule))',
          position: 'relative',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          height: '100%',
          userSelect: 'none',
        } as React.CSSProperties
      }
    >
      <span
        aria-hidden
        style={{
          fontFamily: 'var(--font-sans)',
          fontStyle: 'italic',
          fontSize: 13,
          color: accent,
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        {getTabIcon(tab.entityType, { isDrift })}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          flex: 1,
          letterSpacing: '-0.005em',
        }}
      >
        {label}
      </span>
      <button
        type="button"
        // draggable=false + onDragStart blocker: the parent <div> is
        // draggable, so mousedown-with-any-movement inside it can start a
        // drag (parent as source) instead of producing a click. Without
        // these, clicking X with a slightly imperfect press registers as
        // a drag and onClose never fires — manifesting as the "have to
        // click X twice to close" intermittent bug.
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={t('topTimeline.closeTab')}
        title={t('topTimeline.closeTab')}
        className="app-tab__close"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          marginLeft: 2,
          borderRadius: 1,
          border: 'none',
          background: 'transparent',
          color: 'hsl(var(--ink-3))',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = 'hsl(var(--ink-3))';
        }}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

interface SplitSlotProps {
  tab: SplitTab;
  index: number;
  isActive: boolean;
  isDragging: boolean;
  width: number;
  leftLabel: string;
  rightLabel: string;
  leftColor: string | undefined;
  rightColor: string | undefined;
  leftIsDrift: boolean;
  rightIsDrift: boolean;
  setDragFromIndex: (idx: number | null) => void;
  onDragOverSlot: (event: React.DragEvent<HTMLDivElement>) => void;
  onDropSlot: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEndSlot: () => void;
  onSelectSide: (side: 'left' | 'right') => void;
  onCloseSide: (side: 'left' | 'right') => void;
  onContextMenu: (x: number, y: number, side: 'left' | 'right') => void;
}

function SplitTabSlot({
  tab,
  index,
  isActive,
  isDragging,
  width,
  leftLabel,
  rightLabel,
  leftColor,
  rightColor,
  leftIsDrift,
  rightIsDrift,
  setDragFromIndex,
  onDragOverSlot,
  onDropSlot,
  onDragEndSlot,
  onSelectSide,
  onCloseSide,
  onContextMenu,
}: SplitSlotProps) {
  return (
    <div
      role="tab"
      aria-selected={isActive}
      data-tab-key={tabKey(tab)}
      className={`app-tab app-tab--split${isActive ? ' is-active' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey(tab));
        event.dataTransfer.setData('application/x-drifting-tab', tabKey(tab));
        const rect = event.currentTarget.getBoundingClientRect();
        event.dataTransfer.setDragImage(
          event.currentTarget,
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
        setDragFromIndex(index);
      }}
      onDragOver={onDragOverSlot}
      onDrop={onDropSlot}
      onDragEnd={onDragEndSlot}
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        width,
        minWidth: TAB_FLOOR_WIDTH * SPLIT_WEIGHT,
        background: isActive ? 'hsl(var(--surface))' : 'transparent',
        opacity: isDragging ? 0.5 : 1,
        cursor: 'pointer',
        transition: 'opacity 0.12s ease',
        // Subtle bracket so the fused tab reads as one slot containing two
        // sub-labels rather than two independent tabs jammed together.
        border: '1px solid hsl(var(--rule))',
        borderTop: 'none',
        borderBottom: isActive
          ? '1px solid hsl(var(--surface))'
          : '1px solid hsl(var(--rule))',
        borderRadius: 0,
        position: 'relative',
        overflow: 'hidden',
        height: '100%',
        userSelect: 'none',
      }}
    >
      <SplitSubLabel
        entityType={tab.left.entityType}
        label={leftLabel}
        color={leftColor}
        isDrift={leftIsDrift}
        isFocused={isActive && tab.focused === 'left'}
        isPreview={tab.left.isPreview}
        onClick={() => onSelectSide('left')}
        onClose={() => onCloseSide('left')}
        onContextMenu={(x, y) => onContextMenu(x, y, 'left')}
      />
      <div
        aria-hidden
        className="app-tab__split-divider"
        style={{
          width: 1,
          alignSelf: 'stretch',
          background: 'hsl(var(--rule))',
          margin: '6px 0',
        }}
      />
      <SplitSubLabel
        entityType={tab.right.entityType}
        label={rightLabel}
        color={rightColor}
        isDrift={rightIsDrift}
        isFocused={isActive && tab.focused === 'right'}
        isPreview={tab.right.isPreview}
        onClick={() => onSelectSide('right')}
        onClose={() => onCloseSide('right')}
        onContextMenu={(x, y) => onContextMenu(x, y, 'right')}
      />
    </div>
  );
}

function SplitSubLabel({
  entityType,
  label,
  color,
  isDrift,
  isFocused,
  isPreview,
  onClick,
  onClose,
  onContextMenu,
}: {
  entityType: TabEntityType;
  label: string;
  color: string | undefined;
  isDrift: boolean;
  isFocused: boolean;
  isPreview: boolean;
  onClick: () => void;
  onClose: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const accent = color || 'hsl(var(--ink-3))';
  return (
    <div
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 6px 0 8px',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        color: isFocused ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
        // Metric-neutral emphasis (see LeafTabSlot): real bold widens the
        // focused label and truncates it earlier than the unfocused side.
        fontWeight: 400,
        textShadow: isFocused ? '0 0 0.6px currentcolor' : 'none',
        fontStyle: isPreview ? 'italic' : 'normal',
        // Sub-tab keeps transparent bg. The parent SplitTabSlot already
        // paints its tone-selected bg when the split is active, and the
        // focused side is signalled by `color` + the text-shadow — an extra
        // accent tint here just reads as visual clutter.
        background: 'transparent',
        transition: 'none',
      }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: 'var(--font-sans)',
          fontStyle: 'italic',
          fontSize: 12,
          color: accent,
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        {getTabIcon(entityType, { isDrift })}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          flex: 1,
        }}
      >
        {label}
      </span>
      <button
        type="button"
        // Same "draggable parent eats clicks" guard as the LeafTabSlot X
        // button — the surrounding SplitTabSlot is draggable, and without
        // these blockers a click with any pixel of mouse drift becomes a
        // drag (no click event, no close).
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={t('topTimeline.closePane')}
        title={t('topTimeline.closePane')}
        className="app-tab__close"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          borderRadius: 1,
          border: 'none',
          background: 'transparent',
          color: 'hsl(var(--ink-4))',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = 'hsl(var(--ink-4))';
        }}
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}
