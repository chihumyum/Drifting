import type { RefObject } from 'react';
import type { Storyline } from '../../../domain/storyline';
import type { BookElementCategory } from '../../../domain/book-element';
import type { NodeTag } from '../../../domain/node-tag';
import type { ElementTag } from '../../../domain/element-tag';

interface TopTimelineDropdownProps {
  show: boolean;
  position: { x: number; y: number } | null;
  dropdownRef: RefObject<HTMLDivElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  isAllNodesMode: boolean;
  isAllElementsMode: boolean;
  allStorylines: Storyline[];
  currentStoryline: Storyline | null;
  allCategories: BookElementCategory[];
  currentCategory: BookElementCategory | null;
  onNavigateToAllNodesEditor: () => void;
  onNavigateToAllElementsEditor: () => void;
  onSelectStoryline: (storylineId: string) => void;
  onSelectCategory: (categoryId: string) => void;
  onCreateStoryline: () => void;
  onCreateCategory: () => void;
  isNodeTagFilterEnabled: boolean;
  isElementTagFilterEnabled: boolean;
  allNodeTags: NodeTag[];
  allElementTags: ElementTag[];
  selectedNodeTagIds: string[];
  selectedElementTagIds: string[];
  onToggleNodeTagFilter: (tagId: string) => void;
  onToggleElementTagFilter: (tagId: string) => void;
  onCreateNodeTag: () => void;
  onCreateElementTag: () => void;
  onClearNodeTagFilters: () => void;
  onClearElementTagFilters: () => void;
}

export function TopTimelineDropdown({
  show,
  position,
  dropdownRef,
  onMouseEnter,
  onMouseLeave,
  isAllNodesMode,
  isAllElementsMode,
  allStorylines,
  currentStoryline,
  allCategories,
  currentCategory,
  onNavigateToAllNodesEditor,
  onNavigateToAllElementsEditor,
  onSelectStoryline,
  onSelectCategory,
  onCreateStoryline,
  onCreateCategory,
  isNodeTagFilterEnabled,
  isElementTagFilterEnabled,
  allNodeTags,
  allElementTags,
  selectedNodeTagIds,
  selectedElementTagIds,
  onToggleNodeTagFilter,
  onToggleElementTagFilter,
  onCreateNodeTag,
  onCreateElementTag,
  onClearNodeTagFilters,
  onClearElementTagFilters,
}: TopTimelineDropdownProps) {
  if (!show || !position) {
    return null;
  }

  return (
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        left: Math.max(12, Math.min(position.x, window.innerWidth - 980)),
        top: position.y,
        width: 'min(960px, calc(100vw - 24px))',
        maxHeight: '70vh',
        background: 'rgba(255, 255, 255, 0.96)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)',
        border: '1px solid rgba(0, 0, 0, 0.08)',
        padding: 12,
        zIndex: 10000,
        overflow: 'auto',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1fr) minmax(320px, 1.4fr)',
          gap: 12,
          alignItems: 'stretch',
        }}
      >
        <div
          style={{
            borderRight: '1px solid rgba(90, 151, 199, 0.45)',
            paddingRight: 12,
            minWidth: 0,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8 }}>
            Storylines
          </div>
          <div
            onClick={(event) => {
              event.stopPropagation();
              onNavigateToAllNodesEditor();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              marginBottom: 6,
              background: isAllNodesMode ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
              fontSize: 13,
              color: 'rgba(0, 0, 0, 0.88)',
              fontWeight: isAllNodesMode ? 600 : 500,
            }}
          >
            All Nodes Editor
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {allStorylines.map((storyline) => (
              <div
                key={storyline.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectStoryline(storyline.id);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background:
                    storyline.id === currentStoryline?.id ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    background: storyline.color || '#5d8aa8',
                    flexShrink: 0,
                  }}
                />
                <div
                  style={{
                    fontSize: 13,
                    color: 'rgba(0, 0, 0, 0.88)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {storyline.name}
                </div>
              </div>
            ))}
          </div>
          <div
            onClick={(event) => {
              event.stopPropagation();
              onCreateStoryline();
            }}
            style={{
              marginTop: 10,
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              color: 'rgba(0, 0, 0, 0.7)',
            }}
          >
            + storyline
          </div>
        </div>

        <div
          style={{
            borderRight: '1px solid rgba(90, 151, 199, 0.45)',
            paddingRight: 12,
            minWidth: 0,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8 }}>
            Categories
          </div>
          <div
            onClick={(event) => {
              event.stopPropagation();
              onNavigateToAllElementsEditor();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              marginBottom: 6,
              background: isAllElementsMode ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
              fontSize: 13,
              color: 'rgba(0, 0, 0, 0.88)',
              fontWeight: isAllElementsMode ? 600 : 500,
            }}
          >
            All Elements Editor
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {allCategories.map((category) => (
              <div
                key={category.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectCategory(category.id);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background:
                    category.id === currentCategory?.id ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    background: category.color || '#5d8aa8',
                    flexShrink: 0,
                  }}
                />
                <div
                  style={{
                    fontSize: 13,
                    color: 'rgba(0, 0, 0, 0.88)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {category.name}
                </div>
              </div>
            ))}
          </div>
          <div
            onClick={(event) => {
              event.stopPropagation();
              onCreateCategory();
            }}
            style={{
              marginTop: 10,
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              color: 'rgba(0, 0, 0, 0.7)',
            }}
          >
            + category
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8 }}>
            Tags Filter
          </div>

          {isNodeTagFilterEnabled && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                Chapter Tags
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {allNodeTags.map((tag) => {
                  const selected = selectedNodeTagIds.includes(tag.id);
                  return (
                    <div
                      key={tag.id}
                      onClick={() => {
                        onToggleNodeTagFilter(tag.id);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        border: '1px solid rgba(0, 0, 0, 0.14)',
                        background: selected
                          ? 'rgba(93, 138, 168, 0.16)'
                          : 'rgba(255, 255, 255, 0.75)',
                      }}
                    >
                      <div
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 2,
                          border: '1px solid rgba(0, 0, 0, 0.6)',
                          background: selected ? '#5d8aa8' : 'transparent',
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ fontSize: 13, color: 'rgba(0, 0, 0, 0.85)' }}>{tag.name}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <div
                  onClick={(event) => {
                    event.stopPropagation();
                    onCreateNodeTag();
                  }}
                  style={{ cursor: 'pointer', fontSize: 13, color: 'rgba(0, 0, 0, 0.7)' }}
                >
                  + chapter tag
                </div>
                <div
                  onClick={onClearNodeTagFilters}
                  style={{ cursor: 'pointer', fontSize: 13, color: 'rgba(0, 0, 0, 0.55)' }}
                >
                  clear
                </div>
              </div>
            </>
          )}

          {isElementTagFilterEnabled && (
            <>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#374151',
                  marginTop: isNodeTagFilterEnabled ? 10 : 0,
                  marginBottom: 6,
                }}
              >
                Element Tags
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {allElementTags.map((tag) => {
                  const selected = selectedElementTagIds.includes(tag.id);
                  return (
                    <div
                      key={tag.id}
                      onClick={() => {
                        onToggleElementTagFilter(tag.id);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        border: '1px solid rgba(0, 0, 0, 0.14)',
                        background: selected
                          ? 'rgba(93, 138, 168, 0.16)'
                          : 'rgba(255, 255, 255, 0.75)',
                      }}
                    >
                      <div
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 2,
                          border: '1px solid rgba(0, 0, 0, 0.6)',
                          background: selected ? '#5d8aa8' : 'transparent',
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ fontSize: 13, color: 'rgba(0, 0, 0, 0.85)' }}>{tag.name}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <div
                  onClick={(event) => {
                    event.stopPropagation();
                    onCreateElementTag();
                  }}
                  style={{ cursor: 'pointer', fontSize: 13, color: 'rgba(0, 0, 0, 0.7)' }}
                >
                  + element tag
                </div>
                <div
                  onClick={onClearElementTagFilters}
                  style={{ cursor: 'pointer', fontSize: 13, color: 'rgba(0, 0, 0, 0.55)' }}
                >
                  clear
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
