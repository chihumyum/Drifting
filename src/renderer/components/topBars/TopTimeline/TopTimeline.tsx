import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useDataStore } from '../../../store/data-store';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import {
  useUiStore,
  useProjectTabs,
  tabKey,
  focusedLeafOf,
  type AnyTab,
  type LeafTab,
  type SplitTab,
  type TabEntityType,
} from '../../../store/ui-store';
import { getSubtleTabTone } from './tab-tone';
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
    case 'dashboard':
      return `/project/${projectId}/home`;
    case 'all-chapters':
      return `/project/${projectId}/editor/all`;
  }
}

const TAB_MIN_WIDTH = 64;
const TAB_MAX_WIDTH = 200;
const TAB_GAP = 2;
const CONTAINER_PADDING_X = 20;

// Tab bar glyph. For node entities, the caller passes isDrift so chapters
// (§) can be distinguished from drift nodes (❦ — matches the
// "浮缀" button in LeftSidebarHeader). Dashboard and all-chapters use ⌂ and
// ☰ respectively so the bar reads "home / whole-book / chapter / ..." at a
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
    case 'dashboard':
      return '⌂';
    case 'all-chapters':
      return '☰';
  }
}

const textMeasureCanvas =
  typeof document !== 'undefined' ? document.createElement('canvas') : null;

function measureLabelWidth(text: string): number {
  if (!textMeasureCanvas) return Math.ceil(text.length * 8);
  const ctx = textMeasureCanvas.getContext('2d');
  if (!ctx) return Math.ceil(text.length * 8);
  ctx.font = '400 12.5px var(--font-sans), -apple-system, BlinkMacSystemFont, sans-serif';
  return Math.ceil(ctx.measureText(text).width);
}

const TAB_CHROME_WIDTH = 14 + 6 + 2 + 16 + 16;
// A fused tab carries two sub-labels side-by-side with a divider; treat its
// natural width as ~1.6× a leaf tab so its label has room.
const SPLIT_CHROME_WIDTH = TAB_CHROME_WIDTH + 12;

export function TopTimeline() {
  const navigate = useNavigate();
  const { projectId, openEntity } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
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

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: TabMenuItem[];
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lookups = useMemo(() => {
    const labelOfLeaf = (leaf: LeafTab): string => {
      switch (leaf.entityType) {
        case 'node': {
          const n = bookNodes.find((b) => b.id === leaf.id);
          if (!n) return 'Untitled Chapter';
          if (n.title) return n.title;
          return n.mainStorylineId ? 'Untitled Chapter' : 'Untitled Drift';
        }
        case 'storyline':
          return storylines.find((s) => s.id === leaf.id)?.name || 'Untitled Storyline';
        case 'element':
          return bookElements.find((e) => e.id === leaf.id)?.name || 'Untitled Element';
        case 'category':
          return bookElementCategories.find((c) => c.id === leaf.id)?.name || 'Untitled Category';
        case 'dashboard':
          return '项目主页';
        case 'all-chapters':
          return '通览全书';
      }
    };
    const colorOfLeaf = (leaf: LeafTab): string | undefined => {
      switch (leaf.entityType) {
        case 'node': {
          const n = bookNodes.find((b) => b.id === leaf.id);
          if (!n) return undefined;
          return n.mainStorylineId
            ? storylines.find((s) => s.id === n.mainStorylineId)?.color
            : undefined;
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
        case 'dashboard':
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
      return Boolean(n) && !n!.mainStorylineId;
    };
    return { labelOfLeaf, colorOfLeaf, isDriftLeaf };
  }, [bookNodes, storylines, bookElements, bookElementCategories]);

  // Approximate label width for a top-level tab — used for the Safari-style
  // shrink-to-fit math. Splits get the union of their two label widths plus
  // the extra chrome.
  const idealWidths = useMemo(() => {
    return openTabs.map((tab) => {
      if (tab.kind === 'leaf') {
        const labelW = measureLabelWidth(lookups.labelOfLeaf(tab));
        return Math.min(Math.max(labelW + TAB_CHROME_WIDTH, TAB_MIN_WIDTH), TAB_MAX_WIDTH);
      }
      const leftW = measureLabelWidth(lookups.labelOfLeaf(tab.left));
      const rightW = measureLabelWidth(lookups.labelOfLeaf(tab.right));
      return Math.min(
        Math.max(leftW + rightW + SPLIT_CHROME_WIDTH, TAB_MIN_WIDTH * 2),
        TAB_MAX_WIDTH * 1.6,
      );
    });
  }, [openTabs, lookups]);

  const tabWidths = useMemo(() => {
    if (openTabs.length === 0) return [] as number[];
    if (containerWidth === 0) return idealWidths;
    const totalGaps = TAB_GAP * Math.max(0, openTabs.length - 1);
    const availableW = Math.max(0, containerWidth - CONTAINER_PADDING_X - totalGaps);
    const idealTotal = idealWidths.reduce((a, b) => a + b, 0);
    if (idealTotal <= availableW) return idealWidths;
    const evenW = availableW / openTabs.length;
    if (evenW >= TAB_MIN_WIDTH) {
      return idealWidths.map((w) => Math.min(w, evenW));
    }
    return idealWidths.map(() => TAB_MIN_WIDTH);
  }, [openTabs, idealWidths, containerWidth]);

  // Click a top-level tab. Tab activation always bypasses openEntity:
  //   - splits would otherwise have their focused side replaced (openEntity
  //     treats them as "active is split → swap focused side"),
  //   - node leaves would short-circuit when the current active is the
  //     all-chapters singleton (openEntity scrolls instead of switching).
  // setActiveTab + navigate(url) keeps both flows clean and uniform.
  const handleSelectTab = useCallback(
    (tab: AnyTab) => {
      if (!projectId) return;
      if (tab.kind === 'split') {
        setActiveTab(projectId, { splitId: tab.id });
        const focused = focusedLeafOf(tab);
        const url = urlForLeaf(projectId, focused);
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
          : { entityType: tab.entityType, id: tab.id };
      const { nextActive, wasActive } = closeTab(projectId, closeRef);
      // Three cases:
      //   1. nextActive → closed the active tab AND a sibling took over.
      //      Sync URL to the new active leaf.
      //   2. wasActive && !nextActive → closed the LAST tab. Send the URL
      //      to a blank project route so the URL → tab sync doesn't
      //      reopen the just-closed entity, and the empty editor shows.
      //   3. !wasActive → closed a non-active tab. URL and active tab are
      //      unchanged; do nothing. This used to call navigateToHome()
      //      here, which silently re-spawned the dashboard singleton tab
      //      every time the user closed any background tab.
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
            label: '关闭此格',
            onClick: () => {
              const { nextActive } = closeSplitSide(projectId, tab.id, side);
              if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            },
          },
          {
            label: '拆出为独立 Tab',
            onClick: () => {
              const { nextActive } = extractFromSplit(projectId, tab.id, side);
              if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            },
          },
          {
            label: '左右互换',
            onClick: () => swapSplitPanes(projectId, tab.id),
          },
          { separator: true },
          {
            label: '解除分屏',
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
        label: '关闭',
        accelerator: 'Cmd+W',
        onClick: () => handleCloseTab(tab),
      });

      // Split-create options only on leaves — splitting an already-split tab
      // doesn't add a third pane.
      if (tab.kind === 'leaf') {
        items.push(
          {
            label: '在右侧打开',
            onClick: () =>
              splitActiveWith(projectId, { fromKey: tabKeyStr }, 'right'),
            disabled: !allowSplitOpen,
          },
          {
            label: '在左侧打开',
            onClick: () =>
              splitActiveWith(projectId, { fromKey: tabKeyStr }, 'left'),
            disabled: !allowSplitOpen,
          },
        );
      }

      items.push(
        { separator: true },
        {
          label: '关闭其他',
          onClick: () => {
            const { nextActive } = closeOtherTabs(projectId, tabKeyStr);
            if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
            else navigate(`/project/${projectId}`, { replace: true });
          },
          disabled: openTabs.length <= 1,
        },
        {
          label: '关闭右侧全部',
          onClick: () => {
            const { nextActive } = closeTabsToRight(projectId, tabKeyStr);
            if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
          },
          disabled: tabIndex >= openTabs.length - 1,
        },
        {
          label: '全部关闭',
          onClick: () => {
            closeAllTabs(projectId);
            // Land on the bare project URL so the Layout URL → tab sync
            // doesn't reopen whatever the URL had been pointing at, and
            // the empty editor state renders. navigateToHome() would
            // re-spawn a dashboard tab.
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
    ],
  );

  if (openTabs.length === 0) {
    return null;
  }

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
      }}
    >
      {openTabs.map((tab, index) => {
        const key = tabKey(tab);
        const isActive = key === activeTabKey;
        const isDragging = dragFromIndex === index;
        const width = tabWidths[index] ?? TAB_MIN_WIDTH;

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
              dragFromIndex={dragFromIndex}
              reorder={(from, to) => projectId && reorderTabs(projectId, from, to)}
              onSelect={() => handleSelectTab(tab)}
              onPromote={() => handlePromote(tab)}
              onClose={() => handleCloseTab(tab)}
              onContextMenu={(x, y) =>
                setContextMenu({ x, y, items: buildMenuItems(tab, index) })
              }
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
            dragFromIndex={dragFromIndex}
            reorder={(from, to) => projectId && reorderTabs(projectId, from, to)}
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

      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      <style>{`
        .top-timeline-container::-webkit-scrollbar { display: none; }
      `}</style>
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
  dragFromIndex: number | null;
  reorder: (from: number, to: number) => void;
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
  dragFromIndex,
  reorder,
  onSelect,
  onPromote,
  onClose,
  onContextMenu,
}: LeafSlotProps) {
  const tone = getSubtleTabTone(color);
  const accent = color || 'hsl(var(--ink-3))';
  return (
    <div
      role="tab"
      aria-selected={isActive}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey(tab));
        // Custom format used by the editor area to detect "this is a tab
        // being dragged from the bar" (separate from text/plain so we don't
        // confuse it with other text drags).
        event.dataTransfer.setData('application/x-drifting-tab', tabKey(tab));
        setDragFromIndex(index);
      }}
      onDragOver={(event) => {
        if (dragFromIndex === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (dragFromIndex !== null && dragFromIndex !== index) {
          reorder(dragFromIndex, index);
        }
        setDragFromIndex(null);
      }}
      onDragEnd={() => setDragFromIndex(null)}
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
      onMouseEnter={(event) => {
        if (!isActive) (event.currentTarget as HTMLElement).style.background = tone.hoverBackground;
      }}
      onMouseLeave={(event) => {
        if (!isActive) (event.currentTarget as HTMLElement).style.background = 'transparent';
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
          minWidth: TAB_MIN_WIDTH,
          background: isActive ? tone.selectedBackground : 'transparent',
          opacity: isDragging ? 0.5 : 1,
          cursor: 'pointer',
          transition: 'background 0.18s ease, opacity 0.15s ease',
          fontFamily: 'var(--font-sans)',
          fontSize: 12.5,
          color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
          fontWeight: isActive ? 500 : 400,
          fontStyle: tab.isPreview ? 'italic' : 'normal',
          borderBottom: isActive ? `2px solid ${accent}` : '2px solid transparent',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          WebkitAppRegion: 'no-drag',
          height: '100%',
          userSelect: 'none',
        } as React.CSSProperties
      }
    >
      <span
        aria-hidden
        style={{
          fontFamily: 'var(--font-serif)',
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
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Close tab"
        title="Close tab"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          marginLeft: 2,
          borderRadius: 3,
          border: 'none',
          background: 'transparent',
          color: 'hsl(var(--ink-3))',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = 'hsl(var(--paper-deep))';
          event.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = 'transparent';
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
  dragFromIndex: number | null;
  reorder: (from: number, to: number) => void;
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
  dragFromIndex,
  reorder,
  onSelectSide,
  onCloseSide,
  onContextMenu,
}: SplitSlotProps) {
  const tone = getSubtleTabTone(leftColor || rightColor);
  return (
    <div
      role="tab"
      aria-selected={isActive}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabKey(tab));
        event.dataTransfer.setData('application/x-drifting-tab', tabKey(tab));
        setDragFromIndex(index);
      }}
      onDragOver={(event) => {
        if (dragFromIndex === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (dragFromIndex !== null && dragFromIndex !== index) {
          reorder(dragFromIndex, index);
        }
        setDragFromIndex(null);
      }}
      onDragEnd={() => setDragFromIndex(null)}
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        width,
        minWidth: TAB_MIN_WIDTH * 2,
        background: isActive ? tone.selectedBackground : 'transparent',
        opacity: isDragging ? 0.5 : 1,
        cursor: 'pointer',
        transition: 'background 0.18s ease, opacity 0.15s ease',
        // Subtle bracket so the fused tab reads as one slot containing two
        // sub-labels rather than two independent tabs jammed together.
        border: '1px solid hsl(var(--rule))',
        borderTop: 'none',
        borderBottom: isActive
          ? `2px solid ${leftColor || rightColor || 'hsl(var(--ink-3))'}`
          : '1px solid hsl(var(--rule))',
        borderRadius: 0,
        overflow: 'hidden',
        height: '100%',
        WebkitAppRegion: 'no-drag',
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
        fontWeight: isFocused ? 500 : 400,
        fontStyle: isPreview ? 'italic' : 'normal',
        background: isFocused ? 'hsl(var(--accent) / 0.06)' : 'transparent',
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: 'var(--font-serif)',
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
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Close pane"
        title="Close pane"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          borderRadius: 3,
          border: 'none',
          background: 'transparent',
          color: 'hsl(var(--ink-4))',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = 'hsl(var(--paper-deep))';
          event.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = 'transparent';
          event.currentTarget.style.color = 'hsl(var(--ink-4))';
        }}
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}
