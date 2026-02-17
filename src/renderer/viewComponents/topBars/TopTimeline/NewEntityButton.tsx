import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useLocation, useParams } from 'react-router-dom';
import { useBookNode } from '../../../usecase/useBookNode';
import { useStoryline } from '../../../usecase/useStoryline';
import { useBookElement } from '../../../usecase/useBookElement';
import { useElementCategory } from '../../../usecase/useElementCategory';
import { useDataStore } from '../../../store/data-store';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import loglevel from "loglevel";
import { useAuthStore } from '../../../store/auth';
import { useUiStore } from '../../../store/ui-store';

const log = loglevel.getLogger("NewEntityButton");
log.setLevel(loglevel.levels.ERROR);

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// TODO: make this dynamic to create different entity types
// if we're in storyline editor, get from URL, create new node
// if we're at a node editor, get the node's current main storyline, create new node
// if at element category editor, create element in this category
// if at element editor, create element in this element's category
export function NewEntityButton() {
  const { nodeId, storylineId, elementId, categoryId } = useParams<{
    nodeId?: string;
    storylineId?: string;
    elementId?: string;
    categoryId?: string;
  }>();
  const location = useLocation();
  const { projectId } = useProjectNavigation();
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const setElementSelection = useUiStore((state) => state.setElementSelection);
  const preferAllNodeTimeline = useUiStore((state) => state.preferAllNodeTimeline);
  const preferAllElementTimeline = useUiStore((state) => state.preferAllElementTimeline);
  const userId = useAuthStore((state) => state.user?.id);
  const { createNode } = useBookNode({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createElement } = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { bookNodes, storylines, bookElements, bookElementCategories } = useDataStore();
  const [showCreateTargetDropdown, setShowCreateTargetDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ x: number; y: number } | null>(null);
  const hideDropdownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isAllNodesMode = location.pathname.includes('/home/all-nodes') || location.pathname.includes('/editor/all-nodes');
  const isAllElementsMode = location.pathname.includes('/home/all-elements') || location.pathname.includes('/editor/all-elements');
  const showAllNodeGroup = isAllNodesMode || (Boolean(nodeId) && preferAllNodeTimeline);
  const showAllElementGroup = isAllElementsMode || (Boolean(elementId) && preferAllElementTimeline);
  const isAllEditorMode = showAllNodeGroup || showAllElementGroup;
  const decodedCategoryId = categoryId ? safeDecodeURIComponent(categoryId) : undefined;
  const isElementContext = Boolean(elementId || categoryId || showAllElementGroup);
  const buttonLabel = isElementContext ? 'Element' : 'Chapter';

  const showDropdownFromButton = () => {
    const button = buttonRef.current;
    if (!button) {
      return;
    }
    const rect = button.getBoundingClientRect();
    setDropdownPosition({ x: rect.left, y: rect.bottom + 4 });
    setShowCreateTargetDropdown(true);
  };

  const clearHideDropdownTimeout = () => {
    if (hideDropdownTimeoutRef.current) {
      clearTimeout(hideDropdownTimeoutRef.current);
      hideDropdownTimeoutRef.current = null;
    }
  };

  const scheduleHideDropdown = () => {
    clearHideDropdownTimeout();
    hideDropdownTimeoutRef.current = setTimeout(() => {
      setShowCreateTargetDropdown(false);
      setDropdownPosition(null);
    }, 120);
  };

  useEffect(() => {
    return () => {
      clearHideDropdownTimeout();
    };
  }, []);

  const handleCreateChapter = async (targetStorylineId?: string) => {
    try {
      const currentNodes = bookNodes;

      // Determine target storyline
      let defaultStorylineId: string | null = targetStorylineId ?? null;

      // Priority 1: Use current storyline if in storyline editor
      if (!defaultStorylineId && storylineId) {
        defaultStorylineId = storylineId;
      }
      // Priority 2: Use selected node's primary storyline
      else if (!defaultStorylineId && nodeId) {
        const selectedNode = currentNodes.find((node) => node.id === nodeId);
        defaultStorylineId = selectedNode?.mainStorylineId ?? null;
      }

      // Priority 3: Use first available storyline
      if (!defaultStorylineId) {
        const availableStorylines = storylines;
        defaultStorylineId = availableStorylines[0]?.id ?? null;
      }

      // Calculate insertion position
      let newStart = 1;
      const newLength = 10;

      if (!defaultStorylineId) {
        const createdStoryline = await createStoryline({ projectId });
        defaultStorylineId = createdStoryline.id;
      }

      const storylineNodes = currentNodes.filter((node) => node.mainStorylineId === defaultStorylineId);
      const maxStorylineEnd = storylineNodes.reduce((maxEnd, node) => {
        const nodeEnd = Math.max(node.end ?? node.start, node.start);
        return Math.max(maxEnd, nodeEnd);
      }, 0);
      const maxAllNodesEnd = currentNodes.reduce((maxEnd, node) => {
        const nodeEnd = Math.max(node.end ?? node.start, node.start);
        return Math.max(maxEnd, nodeEnd);
      }, 0);

      if (preferAllNodeTimeline) {
        newStart = maxAllNodesEnd > 0 ? maxAllNodesEnd + 1 : 1;
      } else {
        newStart = maxStorylineEnd > 0 ? maxStorylineEnd + 1 : 1;
      }

      const newEnd = newStart + newLength;

      // Create the new node
      const newNode = await createNode({
        title: 'New Chapter',
        mainStorylineId: defaultStorylineId,
        start: newStart,
        end: newEnd,
      });

      setNodeSelection(newNode.id, 'ui');

      // Scroll timeline to the new chapter
      setTimeout(() => {
        const timelineContainer = document.querySelector('[data-timeline-container]') as HTMLElement;
        if (timelineContainer) {
          const GRID_UNIT = 20;
          const scrollPosition = newStart * GRID_UNIT;
          timelineContainer.scrollTo({
            left: scrollPosition,
            behavior: 'smooth',
          });
        }
      }, 100);
    } catch (error) {
      log.error('Failed to create chapter:', error);
    }
  };

  const handleCreateElement = async (targetCategoryIdInput?: string) => {
    try {
      let targetCategoryId: string | null = targetCategoryIdInput ?? null;

      if (!targetCategoryId && categoryId) {
        targetCategoryId = decodedCategoryId ?? categoryId;
      }

      if (!targetCategoryId && elementId) {
        const element = bookElements.find((el) => el.id === elementId) ?? null;
        targetCategoryId = element?.categoryId ?? null;
      }

      if (!targetCategoryId) {
        const categories = bookElementCategories;
        targetCategoryId = categories[0]?.id ?? null;
      }

      if (!targetCategoryId) {
        const created = await createCategory();
        targetCategoryId = created.id;
      }

      if (!targetCategoryId) {
        log.error('No category available for new element');
        return;
      }

      const newElement = await createElement({ categoryId: targetCategoryId });
      setElementSelection(newElement.id, 'ui');
    } catch (error) {
      log.error('Failed to create element:', error);
    }
  };

  const handleMainButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isAllEditorMode) {
      e.preventDefault();
      clearHideDropdownTimeout();
      showDropdownFromButton();
      return;
    }

    if (isElementContext) {
      void handleCreateElement();
      return;
    }
    void handleCreateChapter();
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleMainButtonClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 6,
          border: '1px solid rgba(184, 153, 104, 0.3)',
          background: 'rgba(184, 153, 104, 0.1)',
          color: 'rgba(0, 0, 0, 0.75)',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          WebkitAppRegion: 'no-drag',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(184, 153, 104, 0.2)';
          e.currentTarget.style.borderColor = 'rgba(184, 153, 104, 0.4)';
          if (isAllEditorMode) {
            clearHideDropdownTimeout();
            showDropdownFromButton();
          }
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'rgba(184, 153, 104, 0.1)';
          e.currentTarget.style.borderColor = 'rgba(184, 153, 104, 0.3)';
          if (isAllEditorMode) {
            scheduleHideDropdown();
          }
        }}
      >
        <Plus size={16} />
        <span>{buttonLabel}</span>
      </button>

      {isAllEditorMode && showCreateTargetDropdown && dropdownPosition && (
        <div
          style={{
            position: 'fixed',
            left: Math.max(12, Math.min(dropdownPosition.x, window.innerWidth - 280)),
            top: dropdownPosition.y,
            width: 280,
            maxHeight: '60vh',
            overflowY: 'auto',
            background: 'rgba(255, 255, 255, 0.96)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            borderRadius: 8,
            border: '1px solid rgba(0, 0, 0, 0.08)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)',
            padding: 8,
            zIndex: 12000,
          }}
          onMouseEnter={clearHideDropdownTimeout}
          onMouseLeave={scheduleHideDropdown}
        >
          {showAllNodeGroup && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', padding: '4px 6px 8px 6px' }}>
                Create Chapter In Storyline
              </div>
              {storylines.map((storyline) => (
                <div
                  key={storyline.id}
                  onClick={() => {
                    void handleCreateChapter(storyline.id);
                    setShowCreateTargetDropdown(false);
                    setDropdownPosition(null);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    marginBottom: 4,
                    background: 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
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
                    {storyline.name || 'Untitled Storyline'}
                  </div>
                </div>
              ))}
              {storylines.length === 0 && (
                <div
                  onClick={() => {
                    void handleCreateChapter();
                    setShowCreateTargetDropdown(false);
                    setDropdownPosition(null);
                  }}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'rgba(0, 0, 0, 0.72)',
                  }}
                >
                  Create in new storyline
                </div>
              )}
            </>
          )}

          {showAllElementGroup && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', padding: '4px 6px 8px 6px' }}>
                Create Element In Category
              </div>
              {bookElementCategories.map((category) => (
                <div
                  key={category.id}
                  onClick={() => {
                    void handleCreateElement(category.id);
                    setShowCreateTargetDropdown(false);
                    setDropdownPosition(null);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    marginBottom: 4,
                    background: 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
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
                    {category.name || 'Untitled Category'}
                  </div>
                </div>
              ))}
              {bookElementCategories.length === 0 && (
                <div
                  onClick={() => {
                    void handleCreateElement();
                    setShowCreateTargetDropdown(false);
                    setDropdownPosition(null);
                  }}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'rgba(0, 0, 0, 0.72)',
                  }}
                >
                  Create in new category
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
