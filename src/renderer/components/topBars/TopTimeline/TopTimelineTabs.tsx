import type { CSSProperties, MouseEvent, RefObject } from 'react';
import type { BookNode } from '../../../domain/book-node';
import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import type { Storyline } from '../../../domain/storyline';
import { getSubtleTabTone } from './tab-tone';

interface TopTimelineTabsProps {
  iconWidth: number;
  gap: number;
  containerRef: RefObject<HTMLDivElement | null>;
  selectedNodeRef: RefObject<HTMLDivElement | null>;
  storylineIconRef: RefObject<HTMLDivElement | null>;
  canShowHeaderDropdown: boolean;
  isProjectHomeMode: boolean;
  isAllElementsMode: boolean;
  isElementMode: boolean;
  isAllNodesMode: boolean;
  currentCategory: BookElementCategory | null;
  currentStoryline: Storyline | null;
  recentEntitiesLimit: number;
  onHeaderClick: () => void;
  onShowDropdown: (event: MouseEvent) => void;
  onHideDropdown: () => void;
  timelineItems: Array<BookNode | BookElement>;
  selectedItemId: string | null | undefined;
  getNodeWidth: (index: number) => number;
  onItemClick: (item: BookNode | BookElement) => void;
  onNodeMouseEnter: (node: BookNode, event: MouseEvent) => void;
  onItemMouseLeave: () => void;
  storylineColorMap: Map<string, string>;
  categoryColorMap: Map<string, string>;
}

export function TopTimelineTabs({
  iconWidth,
  gap,
  containerRef,
  selectedNodeRef,
  storylineIconRef,
  canShowHeaderDropdown,
  isProjectHomeMode,
  isAllElementsMode,
  isElementMode,
  isAllNodesMode,
  currentCategory,
  currentStoryline,
  recentEntitiesLimit,
  onHeaderClick,
  onShowDropdown,
  onHideDropdown,
  timelineItems,
  selectedItemId,
  getNodeWidth,
  onItemClick,
  onNodeMouseEnter,
  onItemMouseLeave,
  storylineColorMap,
  categoryColorMap,
}: TopTimelineTabsProps) {
  // Header pill — square with first letter, color from current scope
  const headerColor = isProjectHomeMode
    ? 'hsl(var(--ink-2))'
    : isAllElementsMode
      ? 'hsl(var(--story-2))'
      : isElementMode
        ? currentCategory?.color || 'hsl(var(--story-4))'
        : isAllNodesMode
          ? 'hsl(var(--story-4))'
          : currentStoryline?.color || 'hsl(var(--story-1))';

  const headerLetter = isProjectHomeMode
    ? 'R'
    : isAllElementsMode
      ? 'E'
      : isElementMode
        ? currentCategory?.name
          ? currentCategory.name.charAt(0).toUpperCase()
          : '?'
        : isAllNodesMode
          ? 'A'
          : currentStoryline?.name
            ? currentStoryline.name.charAt(0).toUpperCase()
            : '?';

  const headerInteractive =
    canShowHeaderDropdown || (isElementMode && Boolean(currentCategory));

  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap }}>
      {/* Header anchor — scope indicator */}
      <div
        ref={storylineIconRef}
        style={{
          position: 'relative',
          flexShrink: 0,
        }}
      >
        <div
          onClick={onHeaderClick}
          style={
            {
              width: iconWidth,
              height: 26,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              background: headerColor,
              cursor: headerInteractive ? 'pointer' : 'default',
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontSize: 14,
              fontWeight: 500,
              color: 'hsl(var(--paper))',
              transition: 'filter 0.15s, transform 0.15s',
              WebkitAppRegion: 'no-drag',
              letterSpacing: '0.01em',
            } as CSSProperties
          }
          onMouseEnter={(event) => {
            event.currentTarget.style.filter = 'brightness(1.08)';
            if (canShowHeaderDropdown) onShowDropdown(event);
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.filter = 'none';
            if (canShowHeaderDropdown) onHideDropdown();
          }}
          title={
            isAllElementsMode
              ? 'All Elements'
              : isProjectHomeMode
                ? `Recent Entities (${recentEntitiesLimit})`
                : isElementMode
                  ? currentCategory?.name || 'Category'
                  : isAllNodesMode
                    ? 'All Nodes'
                    : currentStoryline?.name || 'Storyline'
          }
        >
          {headerLetter}
        </div>
      </div>

      {/* Tab list */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'stretch',
          gap: 2,
          height: 42,
          overflowX: 'auto',
          overflowY: 'hidden',
          paddingRight: 16,
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
        }}
        className="top-timeline-container"
      >
        {timelineItems.map((item, index) => {
          const isSelected = item.id === selectedItemId;
          const isNode = 'title' in item;
          const width = getNodeWidth(index);
          const label = isNode
            ? item.title || 'Untitled Chapter'
            : item.name || 'Untitled Element';
          const baseColor = isNode
            ? storylineColorMap.get(item.mainStorylineId)
            : categoryColorMap.get(item.categoryId);
          const tone = getSubtleTabTone(baseColor);
          const accent = baseColor || 'hsl(var(--ink-3))';

          return (
            <div
              key={item.id}
              ref={isSelected ? selectedNodeRef : null}
              onClick={() => onItemClick(item)}
              onMouseEnter={(event) => {
                if (isNode) onNodeMouseEnter(item, event);
                if (!isSelected) {
                  event.currentTarget.style.background = tone.hoverBackground;
                }
              }}
              onMouseLeave={(event) => {
                onItemMouseLeave();
                if (!isSelected) {
                  event.currentTarget.style.background = 'transparent';
                }
              }}
              style={
                {
                  flexShrink: 0,
                  maxWidth: width,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  paddingLeft: 10,
                  paddingRight: 10,
                  background: isSelected ? tone.selectedBackground : 'transparent',
                  cursor: 'pointer',
                  transition: 'background 0.18s ease',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12.5,
                  color: isSelected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
                  fontWeight: isSelected ? 500 : 400,
                  borderBottom: isSelected
                    ? `2px solid ${accent}`
                    : '2px solid transparent',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  WebkitAppRegion: 'no-drag',
                  height: '100%',
                } as CSSProperties
              }
            >
              {/* Leading symbol — § for node, ◆ for element */}
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontStyle: 'italic',
                  fontSize: 13,
                  color: accent,
                  flexShrink: 0,
                  lineHeight: 1,
                }}
                aria-hidden
              >
                {isNode ? '§' : '◆'}
              </span>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                  letterSpacing: '-0.005em',
                }}
              >
                {label}
              </span>
            </div>
          );
        })}
        {isProjectHomeMode && timelineItems.length === 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: 11,
              color: 'hsl(var(--ink-4))',
              fontStyle: 'italic',
              fontFamily: 'var(--font-serif)',
              whiteSpace: 'nowrap',
              paddingLeft: 6,
            }}
          >
            no recent entities
          </div>
        )}
      </div>
    </div>
  );
}
