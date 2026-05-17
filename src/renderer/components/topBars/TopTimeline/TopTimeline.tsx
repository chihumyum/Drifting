import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useDataStore } from '../../../store/data-store';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import {
  useUiStore,
  useProjectTabs,
  tabKey,
  type Tab,
  type TabEntityType,
} from '../../../store/ui-store';
import { getSubtleTabTone } from './tab-tone';

const TAB_MIN_WIDTH = 64;
const TAB_MAX_WIDTH = 200;
const TAB_GAP = 2;
const CONTAINER_PADDING_X = 20; // 4 left + 16 right

function getTabIcon(entityType: TabEntityType): string {
  switch (entityType) {
    case 'node':
      return '§';
    case 'storyline':
      return '¶';
    case 'element':
      return '◆';
    case 'category':
      return '⌘';
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

// Icon (~14px) + gap (6) + label + gap (2) + close button (16) + horizontal padding (16).
const TAB_CHROME_WIDTH = 14 + 6 + 2 + 16 + 16;

export function TopTimeline() {
  const { projectId, openEntity, navigateToHome } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const closeTab = useUiStore((s) => s.closeTab);
  const promoteTab = useUiStore((s) => s.promoteTab);
  const reorderTabs = useUiStore((s) => s.reorderTabs);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const storylines = useDataStore((s) => s.storylines);
  const bookElements = useDataStore((s) => s.bookElements);
  const bookElementCategories = useDataStore((s) => s.bookElementCategories);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);

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
    const labelOf = (tab: Tab): string => {
      switch (tab.entityType) {
        case 'node':
          return bookNodes.find((n) => n.id === tab.id)?.title || 'Untitled Chapter';
        case 'storyline':
          return storylines.find((s) => s.id === tab.id)?.name || 'Untitled Storyline';
        case 'element':
          return bookElements.find((e) => e.id === tab.id)?.name || 'Untitled Element';
        case 'category':
          return bookElementCategories.find((c) => c.id === tab.id)?.name || 'Untitled Category';
      }
    };
    const colorOf = (tab: Tab): string | undefined => {
      switch (tab.entityType) {
        case 'node': {
          const n = bookNodes.find((b) => b.id === tab.id);
          if (!n) return undefined;
          return storylines.find((s) => s.id === n.mainStorylineId)?.color;
        }
        case 'storyline':
          return storylines.find((s) => s.id === tab.id)?.color;
        case 'element': {
          const e = bookElements.find((b) => b.id === tab.id);
          if (!e) return undefined;
          return bookElementCategories.find((c) => c.id === e.categoryId)?.color;
        }
        case 'category':
          return bookElementCategories.find((c) => c.id === tab.id)?.color;
      }
    };
    return { labelOf, colorOf };
  }, [bookNodes, storylines, bookElements, bookElementCategories]);

  // Safari-style compact overflow:
  //   1. Ideal width per tab = label + chrome, clamped to [MIN, MAX].
  //   2. If everything fits at ideal, use ideal.
  //   3. Else shrink uniformly down to MIN. While shrinking, no scrollbar.
  //   4. When MIN can't fit either, keep MIN and let the row scroll horizontally.
  const tabWidths = useMemo(() => {
    if (openTabs.length === 0) return [] as number[];
    const ideals = openTabs.map((tab) => {
      const labelW = measureLabelWidth(lookups.labelOf(tab));
      return Math.min(Math.max(labelW + TAB_CHROME_WIDTH, TAB_MIN_WIDTH), TAB_MAX_WIDTH);
    });

    if (containerWidth === 0) return ideals;

    const totalGaps = TAB_GAP * Math.max(0, openTabs.length - 1);
    const availableW = Math.max(0, containerWidth - CONTAINER_PADDING_X - totalGaps);
    const idealTotal = ideals.reduce((a, b) => a + b, 0);

    if (idealTotal <= availableW) return ideals;

    const evenW = availableW / openTabs.length;
    if (evenW >= TAB_MIN_WIDTH) {
      return ideals.map((w) => Math.min(w, evenW));
    }

    // At-or-below MIN — pin to MIN, scroll handles the rest.
    return ideals.map(() => TAB_MIN_WIDTH);
  }, [openTabs, lookups, containerWidth]);

  const handleSelect = useCallback(
    (tab: Tab) => {
      openEntity({ entityType: tab.entityType, id: tab.id });
    },
    [openEntity],
  );

  const handleClose = useCallback(
    (tab: Tab) => {
      if (!projectId) return;
      const { nextActive } = closeTab(projectId, { entityType: tab.entityType, id: tab.id });
      if (nextActive) {
        openEntity({ entityType: nextActive.entityType, id: nextActive.id });
      } else {
        navigateToHome();
      }
    },
    [projectId, closeTab, openEntity, navigateToHome],
  );

  const handlePromote = useCallback(
    (tab: Tab) => {
      if (!projectId || !tab.isPreview) return;
      promoteTab(projectId, { entityType: tab.entityType, id: tab.id });
    },
    [projectId, promoteTab],
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
        const label = lookups.labelOf(tab);
        const color = lookups.colorOf(tab);
        const tone = getSubtleTabTone(color);
        const accent = color || 'hsl(var(--ink-3))';
        const width = tabWidths[index] ?? TAB_MIN_WIDTH;

        return (
          <div
            key={key}
            role="tab"
            aria-selected={isActive}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', key);
              setDragFromIndex(index);
            }}
            onDragOver={(event) => {
              if (dragFromIndex === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (projectId && dragFromIndex !== null && dragFromIndex !== index) {
                reorderTabs(projectId, dragFromIndex, index);
              }
              setDragFromIndex(null);
            }}
            onDragEnd={() => setDragFromIndex(null)}
            onClick={() => handleSelect(tab)}
            onDoubleClick={() => handlePromote(tab)}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                handleClose(tab);
              }
            }}
            onMouseEnter={(event) => {
              if (!isActive) {
                (event.currentTarget as HTMLElement).style.background = tone.hoverBackground;
              }
            }}
            onMouseLeave={(event) => {
              if (!isActive) {
                (event.currentTarget as HTMLElement).style.background = 'transparent';
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
              {getTabIcon(tab.entityType)}
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
                handleClose(tab);
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
      })}
      <style>{`
        .top-timeline-container::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}
