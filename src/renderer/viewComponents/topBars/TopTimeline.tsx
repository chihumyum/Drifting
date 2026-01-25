import { useState, useEffect, useRef } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { useStoryline } from '../../usecase/useStoryline';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import type { Storyline } from '../../domain/storyline';
import type { BookNode } from '../../domain/book-node';
import type { BookElement, BookElementCategory } from '../../domain/book-element';
import { useAuthStore } from '../../store/auth';
import { NodeHoverPreview } from '../NodeHoverPreview';
import loglevel from "loglevel";
const log = loglevel.getLogger("TopTimeline");
log.setLevel(loglevel.levels.ERROR);

/* A flexible component for showing all types of stuff in safari compact tab style
  storyline -> nodes 
  element category -> elements
  both with additional tag filters
*/

export function TopTimeline() {
  const { nodeId, storylineId, elementId, categoryId } = useParams<{
    nodeId?: string;
    storylineId?: string;
    elementId?: string;
    categoryId?: string;
  }>();
  const location = useLocation();
  const bookNodes = useDataStore(state => state.bookNodes);
  const storylines = useDataStore(state => state.storylines);
  const bookElements = useDataStore(state => state.bookElements);
  const bookElementCategories = useDataStore(state => state.bookElementCategories);
  const user = useAuthStore(state => state.user);
  const { projectId, navigateToStoryline, navigateToNode, navigateToElement, navigateToCategory } = useProjectNavigation();
  const { getStorylineById, getNodeIdsByStoryline, createStoryline, loadStorylines } = useStoryline({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });

  const [currentStoryline, setCurrentStoryline] = useState<Storyline | null>(null);
  const [storylineNodes, setStorylineNodes] = useState<BookNode[]>([]);
  const [currentCategory, setCurrentCategory] = useState<BookElementCategory | null>(null);
  const [categoryElements, setCategoryElements] = useState<BookElement[]>([]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [showStorylineDropdown, setShowStorylineDropdown] = useState(false);
  const [storylineDropdownPosition, setStorylineDropdownPosition] = useState<{ x: number; y: number } | null>(null);
  const [allStorylines, setAllStorylines] = useState<Storyline[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const selectedNodeRef = useRef<HTMLDivElement>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const storylineIconRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const hideDropdownTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isElementMode = Boolean(categoryId || elementId);
  const isStorylineMode = Boolean(storylineId || nodeId);

  // Load current node's primary storyline and all chapters in that storyline
  useEffect(() => {
    async function loadStorylineData() {
      try {
        if (isElementMode || !isStorylineMode) {
          setCurrentStoryline(null);
          setStorylineNodes([]);
          return;
        }

        let targetStoryline: Storyline | null = null;

        if (storylineId) {
          // In storyline editor: directly load the storyline
          targetStoryline = storylines.find(s => s.id === storylineId) ?? await getStorylineById(storylineId);
        } else if (nodeId) {
          // In node editor: use node's main storyline
          const selectedNode = bookNodes.find(node => node.id === nodeId);
          const mainStorylineId = selectedNode?.mainStorylineId ?? null;
          if (mainStorylineId) {
            targetStoryline = storylines.find(s => s.id === mainStorylineId) ?? await getStorylineById(mainStorylineId);
          }
        }

        // If still no storyline found, load the first storyline to keep timeline visible
        // This ensures timeline is visible on app startup
        if (!targetStoryline) {
          const availableStorylines = storylines.length > 0 ? storylines : await loadStorylines(projectId);
          targetStoryline = availableStorylines[0] ?? null;
        }

        if (targetStoryline) {
          setCurrentStoryline(targetStoryline);

          const nodeIdsInStoryline = await getNodeIdsByStoryline(targetStoryline.id);
          const nodeIdSet = new Set(nodeIdsInStoryline);

          // Filter nodes that belong to the storyline (or are main storyline as a fallback) and sort by start position
          const nodesInStoryline = bookNodes
            .filter(n => nodeIdSet.has(n.id) || n.mainStorylineId === targetStoryline.id)
            .sort((a, b) => a.start - b.start);

          setStorylineNodes(nodesInStoryline);
        } else {
          setCurrentStoryline(null);
          setStorylineNodes([]);
        }
      } catch (error) {
        log.error('Failed to load storyline data:', error);
      }
    }

    loadStorylineData();
  }, [nodeId, storylineId, isElementMode, isStorylineMode, bookNodes, storylines, getStorylineById, getNodeIdsByStoryline, loadStorylines, projectId]);

  useEffect(() => {
    if (!isElementMode) {
      return;
    }

    let targetCategory: BookElementCategory | null = null;
    let targetCategoryId: string | null = null;

    if (categoryId) {
      targetCategory = bookElementCategories.find(cat => cat.id === categoryId || cat.name === categoryId) ?? null;
      targetCategoryId = targetCategory?.id ?? categoryId;
    }

    if (!targetCategoryId && elementId) {
      const currentElement = bookElements.find(el => el.id === elementId) ?? null;
      targetCategoryId = currentElement?.categoryId ?? null;
      if (currentElement) {
        targetCategory = bookElementCategories.find(
          cat => cat.id === currentElement.categoryId || cat.name === currentElement.categoryId
        ) ?? null;
      }
    }

    const elementsInCategory = targetCategoryId
      ? bookElements
        .filter(el => el.categoryId === targetCategoryId || el.categoryId === targetCategory?.name)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : [];

    setCurrentCategory(targetCategory);
    setCategoryElements(elementsInCategory);
  }, [isElementMode, categoryId, elementId, bookElements, bookElementCategories]);

  // Load all stuff for dropdown
  useEffect(() => {
    async function loadAllStorylines() {
      try {
        const lines = await loadStorylines(projectId);
        setAllStorylines(lines);
      } catch (error) {
        log.error('Failed to load all storylines:', error);
      }
    }
    if (!isElementMode && showStorylineDropdown) {
      loadAllStorylines();
    }
  }, [projectId, loadStorylines, showStorylineDropdown, isElementMode]);

  useEffect(() => {
    if (isElementMode && showStorylineDropdown) {
      setShowStorylineDropdown(false);
      setStorylineDropdownPosition(null);
    }
  }, [isElementMode, showStorylineDropdown]);

  useEffect(() => {
    if (isElementMode && hoveredNodeId) {
      setHoveredNodeId(null);
      setHoverPosition(null);
    }
  }, [isElementMode, hoveredNodeId]);

  // Monitor container width
  useEffect(() => {
    // Create canvas for text measurement
    if (!measureCanvasRef.current) {
      measureCanvasRef.current = document.createElement('canvas');
    }

    const container = containerRef.current;
    // console.log(`ContainerRef: ${containerRef.current}`);
    if (!container) {
      // console.log('Container element not found');
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(container);
    log.debug('Container element found, observering...');
    return () => {
      resizeObserver.disconnect();
    };
  }, [storylineNodes.length, categoryElements.length]);

  // Auto-scroll to selected node
  useEffect(() => {
    if (selectedNodeRef.current && containerRef.current) {
      const container = containerRef.current;
      const element = selectedNodeRef.current;

      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();

      // Check if element is not fully visible
      if (
        elementRect.left < containerRect.left ||
        elementRect.right > containerRect.right
      ) {
        // Scroll to center the selected element
        const scrollLeft = element.offsetLeft - container.offsetWidth / 2 + element.offsetWidth / 2;
        container.scrollTo({
          left: scrollLeft,
          behavior: 'smooth',
        });
      }
    }
  }, [nodeId, elementId, storylineNodes, categoryElements]);

  if (!isStorylineMode && !isElementMode) {
    return null;
  }

  // Calculate dynamic widths based on available space
  const timelineItems: Array<BookNode | BookElement> = isElementMode ? categoryElements : storylineNodes;
  const selectedItemId = isElementMode ? elementId : nodeId;
  const selectedIndex = timelineItems.findIndex(item => item.id === selectedItemId);
  const hasSelected = selectedIndex !== -1;

  // Safari-style tab width calculation
  const ICON_WIDTH = 32;
  const GAP = 8;
  const MIN_WIDTH = 40;
  const MAX_WIDTH = 180; // Preferred maximum width for all tabs
  const PADDING = 20; // paddingLeft + paddingRight

  // Measure text width
  const measureTextWidth = (text: string, fontSize: number, fontWeight: number): number => {
    if (!measureCanvasRef.current) return 0;
    const ctx = measureCanvasRef.current.getContext('2d');
    if (!ctx) return 0;
    ctx.font = `${fontWeight} ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    return Math.ceil(ctx.measureText(text).width);
  };

  // Calculate optimal width for each node based on its title
  const calculateNodeWidths = (): number[] => {
    // Safety check
    if (timelineItems.length === 0 || containerWidth === 0) {
      return timelineItems.map(() => MAX_WIDTH);
    }

    // 1. Calculate Ideal Widths for everyone (based on title)
    // Constraint: MIN_WIDTH <= Ideal <= MAX_WIDTH
    const idealWidths = timelineItems.map((item) => {
      const title = 'title' in item ? item.title : item.name;
      const titleWidth = measureTextWidth(
        title || (isElementMode ? 'Untitled Element' : 'Untitled Chapter'),
        13,
        400
      );
      return Math.min(Math.max(titleWidth + PADDING, MIN_WIDTH), MAX_WIDTH);
    });

    const selectedIdealWidth = hasSelected ? idealWidths[selectedIndex] : 0;
    const unselectedMinTotal = timelineItems.reduce((sum, _, idx) => {
      if (idx === selectedIndex) return sum;
      return sum + MIN_WIDTH;
    }, 0);

    const minRequiredTotalWidth = (hasSelected ? selectedIdealWidth : 0) + unselectedMinTotal;
    const totalGaps = GAP * timelineItems.length;

    // 2. Find the smallest Expansion Factor (1x, 2x, 4x...) that fits the Min Requirement
    let expansionFactor = 1;
    let targetAvailableWidth = 0;

    while (expansionFactor <= 64) {
      const targetContainerWidth = containerWidth * expansionFactor;
      targetAvailableWidth = targetContainerWidth - totalGaps - 16;

      if (targetAvailableWidth >= minRequiredTotalWidth) {
        break;
      }
      expansionFactor *= 2;
    }

    // Safety Fallback: If even 64x doesn't fit (crazy huge number of nodes), just use ideal widths
    if (targetAvailableWidth < minRequiredTotalWidth) {
      return idealWidths;
    }

    // 3. Distribute space for the winning Target Width
    const currentSelectedWidth = hasSelected ? idealWidths[selectedIndex] : 0;
    const availableForUnselected = targetAvailableWidth - currentSelectedWidth;

    // Sum of ideal widths of unselected
    const totalIdealUnselected = idealWidths.reduce((sum, w, idx) => {
      if (idx === selectedIndex) return sum;
      return sum + w;
    }, 0);

    // Case A: Extra Space (Ideal fits easily)
    if (totalIdealUnselected <= availableForUnselected) {
      return timelineItems.map((_, idx) => {
        if (idx === selectedIndex) return currentSelectedWidth;
        return idealWidths[idx];
      });
    }

    // Case B: Shrink Needed

    return timelineItems.map((_, idx) => {
      if (idx === selectedIndex) return currentSelectedWidth;
      return availableForUnselected / (timelineItems.length - 1);
    });
  };

  const nodeWidths = calculateNodeWidths();

  const getNodeWidth = (index: number): number => {
    return nodeWidths[index] || MIN_WIDTH;
  };

  const handleHeaderClick = () => {
    if (isElementMode) {
      if (currentCategory) {
        navigateToCategory(currentCategory.id);
      }
      return;
    }
    if (currentStoryline) {
      navigateToStoryline(currentStoryline.id);
    }
  };

  const handleStorylineChange = async (storylineId: string) => {
    setShowStorylineDropdown(false);

    // Load the new storyline and its nodes
    try {
      const targetStoryline = await getStorylineById(storylineId);
      setCurrentStoryline(targetStoryline);

      const nodeIdsInStoryline = await getNodeIdsByStoryline(storylineId);
      const nodeIdSet = new Set(nodeIdsInStoryline);

      // Filter nodes that belong to the target storyline and sort by start position
      const nodesInStoryline = bookNodes
        .filter(n => nodeIdSet.has(n.id) || n.mainStorylineId === storylineId)
        .sort((a, b) => a.start - b.start);

      setStorylineNodes(nodesInStoryline);

      // Don't navigate automatically when switching storylines
      // User can click on a node to navigate
    } catch (error) {
      log.error('Failed to switch storyline:', error);
    }
  };

  const handleShowDropdown = (e: React.MouseEvent) => {
    if (hideDropdownTimeoutRef.current) {
      clearTimeout(hideDropdownTimeoutRef.current);
      hideDropdownTimeoutRef.current = null;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setStorylineDropdownPosition({
      x: rect.left,
      y: rect.bottom + 4,
    });
    setShowStorylineDropdown(true);
  };

  const handleHideDropdown = () => {
    hideDropdownTimeoutRef.current = setTimeout(() => {
      setShowStorylineDropdown(false);
      setStorylineDropdownPosition(null);
    }, 150);
  };

  const handleItemClick = (item: BookNode | BookElement) => {
    if ('title' in item) {
      if (location.pathname !== `/project/${projectId}/editor/${item.id}`) {
        navigateToNode(item.id);
      }
      return;
    }
    if (location.pathname !== `/project/${projectId}/element/${item.id}`) {
      navigateToElement(item.id);
    }
  };

  const handleMouseEnter = (node: BookNode, e: React.MouseEvent) => {
    setHoveredNodeId(node.id);
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverPosition({
      x: rect.left + rect.width / 2,
      y: rect.bottom + 8,
    });
  };

  const handleMouseLeave = () => {
    setHoveredNodeId(null);
    setHoverPosition(null);
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: GAP }}>
        {/* Header Icon - Leftmost (Fixed) */}
        <div
          ref={storylineIconRef}
          style={{
            position: 'relative',
            flexShrink: 0,
          }}
        >
          <div
            onClick={handleHeaderClick}
            style={{
              width: ICON_WIDTH,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 7,
              background: isElementMode
                ? (currentCategory?.color || '#b89968')
                : (currentStoryline?.color || '#b89968'),
              cursor: isElementMode ? (currentCategory ? 'pointer' : 'default') : 'pointer',
              fontSize: 14,
              fontWeight: 600,
              color: '#fff',
              transition: 'all 0.2s',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
            onMouseEnter={e => {
              e.currentTarget.style.transform = 'scale(1.05)';
              e.currentTarget.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.15)';
              if (!isElementMode) {
                handleShowDropdown(e);
              }
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.1)';
              if (!isElementMode) {
                handleHideDropdown();
              }
            }}
            title={isElementMode ? (currentCategory?.name || 'Category') : (currentStoryline?.name || 'Storyline')}
          >
            {isElementMode
              ? (currentCategory?.name ? currentCategory.name.charAt(0).toUpperCase() : '?')
              : (currentStoryline?.name ? currentStoryline.name.charAt(0).toUpperCase() : '?')}
          </div>
        </div>

        <div
          ref={containerRef}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: GAP,
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
          {/* Chapter Tabs */}
          {timelineItems.map((item, index) => {
            const isSelected = item.id === selectedItemId;
            const width = getNodeWidth(index);
            const label = 'title' in item
              ? (item.title || 'Untitled Chapter')
              : (item.name || 'Untitled Element');

            return (
              <div
                key={item.id}
                ref={isSelected ? selectedNodeRef : null}
                onClick={() => handleItemClick(item)}
                onMouseEnter={(e) => {
                  if ('title' in item) {
                    handleMouseEnter(item, e);
                  }
                  if (!isSelected) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.8)';
                    e.currentTarget.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.08)';
                  }
                }}
                onMouseLeave={(e) => {
                  handleMouseLeave();
                  if (!isSelected) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.6)';
                    e.currentTarget.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.05)';
                  }
                }}
                style={{
                  flexShrink: 0,
                  maxWidth: width,
                  minWidth: 0,
                  height: 28,
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 7,
                  background: isSelected
                    ? 'rgba(255, 255, 255, 0.95)'
                    : 'rgba(255, 255, 255, 0.6)',
                  backdropFilter: 'blur(10px)',
                  WebkitBackdropFilter: 'blur(10px)',
                  border: isSelected
                    ? '1px solid rgba(0, 0, 0, 0.08)'
                    : '1px solid transparent',
                  boxShadow: isSelected
                    ? '0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8)'
                    : '0 1px 3px rgba(0, 0, 0, 0.05)',
                  cursor: 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  fontSize: 13,
                  color: isSelected ? 'rgba(0, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.65)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties}
              >
                {label}
              </div>
            );
          })}
        </div>
      </div >

      {/* Storyline Dropdown */}
      {
        !isElementMode && showStorylineDropdown && storylineDropdownPosition && (
          <div
            ref={dropdownRef}
            style={{
              position: 'fixed',
              left: storylineDropdownPosition.x,
              top: storylineDropdownPosition.y,
              background: 'rgba(255, 255, 255, 0.95)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              borderRadius: 8,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
              padding: 8,
              zIndex: 10000,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              minWidth: 200,
            }}
            onMouseEnter={() => {
              if (hideDropdownTimeoutRef.current) {
                clearTimeout(hideDropdownTimeoutRef.current);
                hideDropdownTimeoutRef.current = null;
              }
            }}
            onMouseLeave={handleHideDropdown}
          >
            {allStorylines.map(storyline => (
              <div
                key={storyline.id}
                onClick={(e) => {
                  e.stopPropagation();
                  navigateToStoryline(storyline.id);
                  setShowStorylineDropdown(false);
                  setStorylineDropdownPosition(null);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: storyline.id === currentStoryline?.id
                    ? 'rgba(0, 0, 0, 0.05)'
                    : 'transparent',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(0, 0, 0, 0.08)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = storyline.id === currentStoryline?.id
                    ? 'rgba(0, 0, 0, 0.05)'
                    : 'transparent';
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 6,
                    background: storyline.color || '#b89968',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {storyline.name.charAt(0).toUpperCase()}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: 'rgba(0, 0, 0, 0.85)',
                    fontWeight: storyline.id === currentStoryline?.id ? 600 : 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  {storyline.name}
                </div>
                {storyline.id === currentStoryline?.id && (
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: storyline.color || '#b89968',
                      flexShrink: 0,
                    }}
                  />
                )}
              </div>
            ))}

            {/* Divider */}
            <div style={{ height: 1, background: 'rgba(0, 0, 0, 0.1)', margin: '4px 0' }} />

            {/* New Storyline Button */}
            <div
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  // Extended storyline color palette with better distinction
                  const STORYLINE_COLORS = [
                    // Earth tones
                    '#b89968', '#8b7355', '#946b54', '#bc6c25', '#a0522d',
                    // Green tones
                    '#6b9080', '#588157', '#a3b18a', '#4a7c59', '#6d9773',
                    // Blue/Teal tones
                    '#7a9e9f', '#5b8a8f', '#4682b4', '#5f9ea0', '#4a7c8c',
                    // Purple/Mauve tones
                    '#9b7e9b', '#8b7b9b', '#a98d9b', '#9a7e9e', '#b19cd9',
                    // Warm tones
                    '#c17c5c', '#d4956c', '#b8805f', '#cf8d6f', '#a67c52',
                    // Cool grays
                    '#7d8491', '#8b939e', '#6d7684', '#858c99', '#75808a',
                  ];

                  // Get current storylines to check for used colors
                  const currentStorylines = await loadStorylines(projectId);
                  const usedColors = new Set(currentStorylines.map(s => s.color?.toLowerCase()));

                  // Find unused colors first
                  const unusedColors = STORYLINE_COLORS.filter(c => !usedColors.has(c.toLowerCase()));

                  // Select color: prefer unused, otherwise pick randomly
                  const selectedColor = unusedColors.length > 0
                    ? unusedColors[Math.floor(Math.random() * unusedColors.length)]
                    : STORYLINE_COLORS[Math.floor(Math.random() * STORYLINE_COLORS.length)];

                  const newStoryline = await createStoryline({
                    projectId,
                    name: 'New Storyline',
                    color: selectedColor,
                    summary: '',
                  });

                  // Reload all storylines to update store
                  await loadStorylines(projectId);

                  setShowStorylineDropdown(false);
                  setStorylineDropdownPosition(null);
                  navigateToStoryline(newStoryline.id);
                } catch (error) {
                  log.error('Failed to create storyline:', error);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 6,
                cursor: 'pointer',
                background: 'transparent',
                transition: 'all 0.2s',
                color: 'rgba(0, 0, 0, 0.65)',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(184, 153, 104, 0.1)';
                e.currentTarget.style.color = 'rgba(0, 0, 0, 0.85)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'rgba(0, 0, 0, 0.65)';
              }}
            >
              <Plus size={16} />
              <div style={{ fontSize: 13, fontWeight: 500 }}>New Storyline</div>
            </div>
          </div>
        )
      }

      {/* Hover Preview */}
      {!isElementMode && (
        <NodeHoverPreview
          node={hoveredNodeId ? storylineNodes.find(n => n.id === hoveredNodeId) ?? null : null}
          position={hoverPosition}
        />
      )}

      <style>{`
        .top-timeline-container::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </>
  );
}
