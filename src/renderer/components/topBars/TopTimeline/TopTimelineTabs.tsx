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
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap }}>
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
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              background: isProjectHomeMode
                ? '#6e7b8b'
                : isAllElementsMode
                  ? '#5d8aa8'
                  : isElementMode
                    ? currentCategory?.color || '#b89968'
                    : isAllNodesMode
                      ? '#8b7355'
                      : currentStoryline?.color || '#b89968',
              cursor:
                canShowHeaderDropdown || (isElementMode && Boolean(currentCategory))
                  ? 'pointer'
                  : 'default',
              fontSize: 14,
              fontWeight: 600,
              color: '#fff',
              transition: 'all 0.2s',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
              WebkitAppRegion: 'no-drag',
            } as CSSProperties
          }
          onMouseEnter={(event) => {
            event.currentTarget.style.transform = 'scale(1.05)';
            event.currentTarget.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.15)';
            if (canShowHeaderDropdown) {
              onShowDropdown(event);
            }
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.transform = 'scale(1)';
            event.currentTarget.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.1)';
            if (canShowHeaderDropdown) {
              onHideDropdown();
            }
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
          {isProjectHomeMode
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
                    : '?'}
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap,
          height: 28,
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
          const width = getNodeWidth(index);
          const label =
            'title' in item ? item.title || 'Untitled Chapter' : item.name || 'Untitled Element';
          const baseColor =
            'title' in item
              ? storylineColorMap.get(item.mainStorylineId)
              : categoryColorMap.get(item.categoryId);
          const tone = getSubtleTabTone(baseColor);
          const idleBackground = isSelected ? tone.selectedBackground : tone.normalBackground;
          const idleBorderColor = isSelected ? tone.selectedBorder : 'rgba(255, 255, 255, 0.28)';
          const idleShadow = isSelected
            ? '0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.7)'
            : '0 1px 3px rgba(0, 0, 0, 0.05)';

          return (
            <div
              key={item.id}
              ref={isSelected ? selectedNodeRef : null}
              onClick={() => onItemClick(item)}
              onMouseEnter={(event) => {
                if ('title' in item) {
                  onNodeMouseEnter(item, event);
                }
                if (!isSelected) {
                  event.currentTarget.style.background = tone.hoverBackground;
                  event.currentTarget.style.borderColor = tone.selectedBorder;
                  event.currentTarget.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.08)';
                }
              }}
              onMouseLeave={(event) => {
                onItemMouseLeave();
                if (!isSelected) {
                  event.currentTarget.style.background = idleBackground;
                  event.currentTarget.style.borderColor = idleBorderColor;
                  event.currentTarget.style.boxShadow = idleShadow;
                }
              }}
              style={
                {
                  flexShrink: 0,
                  maxWidth: width,
                  minWidth: 0,
                  height: 28,
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 7,
                  background: idleBackground,
                  backdropFilter: 'blur(10px)',
                  WebkitBackdropFilter: 'blur(10px)',
                  border: `1px solid ${idleBorderColor}`,
                  boxShadow: idleShadow,
                  cursor: 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  fontSize: 13,
                  color: isSelected ? 'rgba(0, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.65)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  WebkitAppRegion: 'no-drag',
                } as CSSProperties
              }
            >
              {label}
            </div>
          );
        })}
        {isProjectHomeMode && timelineItems.length === 0 && (
          <div
            style={{
              fontSize: 12,
              color: 'rgba(0, 0, 0, 0.5)',
              whiteSpace: 'nowrap',
              paddingLeft: 4,
            }}
          >
            No recent entities yet
          </div>
        )}
      </div>
    </div>
  );
}
