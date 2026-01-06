import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '../store';
import { useStorylineUsecases } from '../hooks/useStorylineUsecases';
import type { Storyline } from '../domain/storyline';
import type { BookNode } from '../domain/book_node';
import { useAuthStore, getProjectId } from '../store/auth';

interface TimelineNode extends BookNode {
  storylines: Storyline[];
}

export function TopTimeline() {
  const navigate = useNavigate();
  const { nodeId, storylineId } = useParams<{ nodeId?: string; storylineId?: string }>();
  const { bookNodes } = useAppStore();
  const user = useAuthStore(state => state.user);
  const projectId = getProjectId(user?.id);
  const storylineUsecases = useStorylineUsecases();
  const selectedNodeId = useAppStore(state => state.selectedNodeId);

  const [currentStoryline, setCurrentStoryline] = useState<Storyline | null>(null);
  const [storylineNodes, setStorylineNodes] = useState<TimelineNode[]>([]);
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

  // Load current node's primary storyline and all chapters in that storyline
  useEffect(() => {
    async function loadStorylineData() {
      try {
        let targetStoryline: Storyline | null = null;

        if (storylineId) {
          // In storyline editor: directly load the storyline
          targetStoryline = await storylineUsecases.getStorylineById(storylineId);
        } else if (nodeId) {
          // In node editor: get storylines for current node
          const nodeStorylines = await storylineUsecases.getStorylinesByNode(nodeId);
          if (nodeStorylines.length > 0) {
            // Use the primary storyline (first one)
            targetStoryline = nodeStorylines[0];
          }
        } else if (selectedNodeId) {
          // In element editor or other views: use selected node's storyline
          const selectedNodeStorylines = await storylineUsecases.getStorylinesByNode(selectedNodeId);
          if (selectedNodeStorylines.length > 0) {
            targetStoryline = selectedNodeStorylines[0];
          }
        }

        // If still no storyline found, load the first storyline to keep timeline visible
        // This ensures timeline is visible on app startup
        if (!targetStoryline) {
          const allStorylines = await storylineUsecases.getStorylinesByProject(projectId);
          if (allStorylines.length > 0) {
            targetStoryline = allStorylines[0];
          }
        }

        if (targetStoryline) {
          setCurrentStoryline(targetStoryline);

          // Load all nodes with their storylines (even if bookNodes is empty initially)
          const nodesWithStorylines = await Promise.all(
            bookNodes.map(async (node) => {
              const nodeStorylines = await storylineUsecases.getStorylinesByNode(node.id);
              return { ...node, storylines: nodeStorylines };
            })
          );

          // Filter nodes that belong to the target storyline and sort by start position
          const nodesInStoryline = nodesWithStorylines
            .filter(n => n.storylines.some(s => s.id === targetStoryline.id))
            .sort((a, b) => a.start - b.start);

          setStorylineNodes(nodesInStoryline);
        } else {
          setCurrentStoryline(null);
          setStorylineNodes([]);
        }
      } catch (error) {
        console.error('Failed to load storyline data:', error);
      }
    }

    loadStorylineData();
  }, [nodeId, storylineId, selectedNodeId, bookNodes, storylineUsecases, projectId]);

  // Load all storylines for dropdown
  useEffect(() => {
    async function loadAllStorylines() {
      try {
        const lines = await storylineUsecases.getStorylinesByProject(projectId);
        setAllStorylines(lines);
      } catch (error) {
        console.error('Failed to load all storylines:', error);
      }
    }
    loadAllStorylines();
  }, [projectId, storylineUsecases]);

  // Monitor container width
  useEffect(() => {
    // Create canvas for text measurement
    if (!measureCanvasRef.current) {
      measureCanvasRef.current = document.createElement('canvas');
    }

    const container = containerRef.current;
    // console.log(`ContainerRef: ${containerRef.current}`);
    if (!container) {
      console.error('Container element not found');
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    resizeObserver.observe(container);
    console.log('Container element found, observering...');
    return () => {
      resizeObserver.disconnect();
    };
  }, [storylineNodes.length]);

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
  }, [nodeId, selectedNodeId, storylineNodes]);

  // Don't render if no storyline exists at all
  if (!currentStoryline) {
    return null;
  }

  // Calculate dynamic widths based on available space
  // Use nodeId for actual selection, selectedNodeId is just for loading storyline
  const selectedIndex = storylineNodes.findIndex(n => n.id === nodeId);
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
    if (storylineNodes.length === 0 || containerWidth === 0) {
      console.log(`calculateNodeWidths: storylineNodes.length: ${storylineNodes.length}, containerWidth: ${containerWidth}`);
      return storylineNodes.map(() => MAX_WIDTH);
    }

    // 1. Calculate Ideal Widths for everyone (based on title)
    // Constraint: MIN_WIDTH <= Ideal <= MAX_WIDTH
    const idealWidths = storylineNodes.map((node) => {
      const titleWidth = measureTextWidth(
        node.title || 'Untitled Chapter',
        13,
        400
      );
      // console.log(`titleWidth: ${titleWidth}`);
      return Math.min(Math.max(titleWidth + PADDING, MIN_WIDTH), MAX_WIDTH);
    });

    const selectedIdealWidth = hasSelected ? idealWidths[selectedIndex] : 0;
    const unselectedMinTotal = storylineNodes.reduce((sum, _, idx) => {
      if (idx === selectedIndex) return sum;
      return sum + MIN_WIDTH;
    }, 0);

    const minRequiredTotalWidth = (hasSelected ? selectedIdealWidth : 0) + unselectedMinTotal;
    const totalGaps = GAP * storylineNodes.length;

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

      return storylineNodes.map((_, idx) => {
        if (idx === selectedIndex) return currentSelectedWidth;
        return idealWidths[idx];
      });
    }

    // Case B: Shrink Needed

    return storylineNodes.map((_, idx) => {
      if (idx === selectedIndex) return currentSelectedWidth;
      return availableForUnselected / (storylineNodes.length - 1);
    });
  };

  const nodeWidths = calculateNodeWidths();

  const getNodeWidth = (index: number): number => {
    return nodeWidths[index] || MIN_WIDTH;
  };

  const handleStorylineClick = () => {
    if (currentStoryline) {
      navigate(`/editor/storyline/${currentStoryline.id}`);
    }
  };

  const handleStorylineChange = async (storylineId: string, navigateToEditor: boolean = false) => {
    setShowStorylineDropdown(false);

    // If navigateToEditor is true, directly navigate to storyline editor
    if (navigateToEditor) {
      navigate(`/editor/storyline/${storylineId}`);
      return;
    }

    // Load the new storyline and its nodes
    try {
      const targetStoryline = await storylineUsecases.getStorylineById(storylineId);
      setCurrentStoryline(targetStoryline);

      // Load all nodes with their storylines
      const nodesWithStorylines = await Promise.all(
        bookNodes.map(async (node) => {
          const nodeStorylines = await storylineUsecases.getStorylinesByNode(node.id);
          return { ...node, storylines: nodeStorylines };
        })
      );

      // Filter nodes that belong to the target storyline and sort by start position
      const nodesInStoryline = nodesWithStorylines
        .filter(n => n.storylines.some(s => s.id === storylineId))
        .sort((a, b) => a.start - b.start);

      setStorylineNodes(nodesInStoryline);

      // Navigate to the first node in the storyline if there are nodes
      if (nodesInStoryline.length > 0) {
        // 避免重复导航到同一页面
        if (location.pathname !== `/editor/${nodesInStoryline[0].id}`) {
          navigate(`/editor/${nodesInStoryline[0].id}`);
        }
      }
    } catch (error) {
      console.error('Failed to switch storyline:', error);
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

  const handleNodeClick = (nodeId: string) => {
    // 避免重复导航到同一页面
    if (location.pathname !== `/editor/${nodeId}`) {
      navigate(`/editor/${nodeId}`);
    }
  };

  const handleMouseEnter = (node: TimelineNode, e: React.MouseEvent) => {
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
        {/* Storyline Icon - Leftmost (Fixed) */}
        <div
          ref={storylineIconRef}
          style={{
            position: 'relative',
            flexShrink: 0,
          }}
        >
          <div
            onClick={handleStorylineClick}
            style={{
              width: ICON_WIDTH,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 7,
              background: currentStoryline.color || '#b89968',
              cursor: 'pointer',
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
              handleShowDropdown(e);
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.1)';
              handleHideDropdown();
            }}
            title={currentStoryline.name}
          >
            {currentStoryline.name.charAt(0).toUpperCase()}
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
          {storylineNodes.map((node, index) => {
            const isSelected = node.id === nodeId;
            const width = getNodeWidth(index);

            return (
              <div
                key={node.id}
                ref={isSelected ? selectedNodeRef : null}
                onClick={() => handleNodeClick(node.id)}
                onMouseEnter={(e) => {
                  handleMouseEnter(node, e);
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
                {node.title || 'Untitled Chapter'}
              </div>
            );
          })}
        </div>
      </div >

      {/* Storyline Dropdown */}
      {
        showStorylineDropdown && storylineDropdownPosition && (
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
              WebkitAppRegion: 'no-drag',
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
                  navigate(`/editor/storyline/${storyline.id}`);
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
          </div>
        )
      }

      {/* Hover Preview */}
      {
        hoveredNodeId && hoverPosition && (() => {
          const hoveredNode = storylineNodes.find(n => n.id === hoveredNodeId);
          if (!hoveredNode) return null;

          return (
            <div
              style={{
                position: 'fixed',
                left: hoverPosition.x,
                top: hoverPosition.y,
                transform: 'translateX(-50%)',
                width: 280,
                background: '#fff',
                border: '1px solid rgba(0, 0, 0, 0.1)',
                borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08)',
                padding: 12,
                zIndex: 10000,
                pointerEvents: 'none',
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'rgba(0, 0, 0, 0.85)',
                  marginBottom: 6,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {hoveredNode.title || 'Untitled Chapter'}
              </div>
              {hoveredNode.summary && (
                <div
                  style={{
                    fontSize: 12,
                    color: 'rgba(0, 0, 0, 0.6)',
                    lineHeight: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {hoveredNode.summary}
                </div>
              )}
              {!hoveredNode.summary && (
                <div
                  style={{
                    fontSize: 12,
                    color: 'rgba(0, 0, 0, 0.35)',
                    fontStyle: 'italic',
                  }}
                >
                  No summary
                </div>
              )}
            </div>
          );
        })()
      }

      <style>{`
        .top-timeline-container::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </>
  );
}
