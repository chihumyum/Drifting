import { useState, useEffect, useRef } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { useDataStore } from '../../../store/data-store';
import { useStoryline } from '../../../usecase/useStoryline';
import { useElementCategory } from '../../../usecase/useElementCategory';
import { useNodeTag } from '../../../usecase/useNodeTag';
import { useElementTag } from '../../../usecase/useElementTag';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import type { Storyline } from '../../../domain/storyline';
import type { BookNode } from '../../../domain/book-node';
import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import type { NodeTag } from '../../../domain/node-tag';
import type { ElementTag } from '../../../domain/element-tag';
import { useAuthStore } from '../../../store/auth';
import { useUiStore } from '../../../store/ui-store';
import { NodeHoverPreview } from '../../NodeHoverPreview';
import loglevel from "loglevel";
const log = loglevel.getLogger("TopTimeline");
log.setLevel(loglevel.levels.WARN);

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* A flexible component for showing all types of stuff in safari compact tab style
  when in node editor or storyline editor: show nodes whose primary storyline is the current storyline
    - new entity button creates a new node in the current storyline, after current node if in node editor, at the end if in storyline editor
  when in element editor or category editor: show elements in the current category
    - new entity button creates a new element in the current category
  when in all-nodes view: show all nodes in current project
  when in all-elements view: show elements in all categories in current project
  icon dropdown always shows full controls: storylines, categories, chapter tags filter, element tags filter
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
  const selectedNodeId = useUiStore((state) => state.nodeUi.selectedId);
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const selectedElementId = useUiStore((state) => state.elementUi.selectedId);
  const setElementSelection = useUiStore((state) => state.setElementSelection);
  const user = useAuthStore(state => state.user);
  const { projectId, navigateToStoryline, navigateToCategory, navigateTo } = useProjectNavigation();
  const { getStorylineById, createStoryline, loadStorylines } = useStoryline({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { loadCategories, createCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { loadTags: loadNodeTags, createTag: createNodeTag, getNodesWithTag } = useNodeTag({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { loadTags: loadElementTags, createTag: createElementTag, getElementsWithTag } = useElementTag({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });

  const [currentStoryline, setCurrentStoryline] = useState<Storyline | null>(null);
  const [storylineNodes, setStorylineNodes] = useState<BookNode[]>([]);
  const [currentCategory, setCurrentCategory] = useState<BookElementCategory | null>(null);
  const [categoryElements, setCategoryElements] = useState<BookElement[]>([]);
  const [allCategories, setAllCategories] = useState<BookElementCategory[]>([]);
  const [allNodeTags, setAllNodeTags] = useState<NodeTag[]>([]);
  const [allElementTags, setAllElementTags] = useState<ElementTag[]>([]);
  const [selectedNodeTagIds, setSelectedNodeTagIds] = useState<string[]>([]);
  const [selectedElementTagIds, setSelectedElementTagIds] = useState<string[]>([]);
  const [filteredNodeIdSet, setFilteredNodeIdSet] = useState<Set<string> | null>(null);
  const [filteredElementIdSet, setFilteredElementIdSet] = useState<Set<string> | null>(null);
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
  const decodedCategoryId = categoryId ? safeDecodeURIComponent(categoryId) : undefined;
  const isAllNodesMode = location.pathname.includes('/home/all-nodes') || location.pathname.includes('/editor/all-nodes');
  const isAllElementsMode = location.pathname.includes('/home/all-elements') || location.pathname.includes('/editor/all-elements');
  const isNodeTimelineMode = isStorylineMode || isAllNodesMode;
  const isElementTimelineMode = isElementMode || isAllElementsMode;
  const shouldShowTimeline = isNodeTimelineMode || isElementTimelineMode;
  const canShowHeaderDropdown = shouldShowTimeline;
  const isNodeTagFilterEnabled = isNodeTimelineMode;
  const isElementTagFilterEnabled = isElementTimelineMode;

  // Load current node's primary storyline and all chapters in that storyline
  useEffect(() => {
    async function loadStorylineData() {
      try {
        if (!isStorylineMode) {
          if (!isAllNodesMode) {
            setCurrentStoryline(null);
            setStorylineNodes([]);
          }
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
          const targetStorylineId = targetStoryline.id;

          // Show only nodes whose primary storyline is the current storyline.
          const nodesInStoryline = bookNodes
            .filter(n => n.mainStorylineId === targetStorylineId)
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
  }, [nodeId, storylineId, isElementMode, isAllNodesMode, isStorylineMode, bookNodes, storylines, getStorylineById, loadStorylines, projectId]);

  useEffect(() => {
    if (!isElementMode) {
      return;
    }

    let targetCategory: BookElementCategory | null = null;
    let targetCategoryId: string | null = null;

    if (categoryId) {
      targetCategory = bookElementCategories.find(
        cat =>
          cat.id === categoryId ||
          cat.id === decodedCategoryId
      ) ?? null;
      targetCategoryId = targetCategory?.id ?? decodedCategoryId ?? categoryId;
    }

    if (!targetCategoryId && elementId) {
      const currentElement = bookElements.find(el => el.id === elementId) ?? null;
      targetCategoryId = currentElement?.categoryId ?? null;
      if (currentElement) {
        targetCategory = bookElementCategories.find(
          cat => cat.id === currentElement.categoryId
        ) ?? null;
      }
    }

    const categoryKeys = new Set<string>();
    if (categoryId) categoryKeys.add(categoryId);
    if (decodedCategoryId) categoryKeys.add(decodedCategoryId);
    if (targetCategoryId) categoryKeys.add(targetCategoryId);
    if (targetCategory?.id) categoryKeys.add(targetCategory.id);

    const elementsInCategory = categoryKeys.size > 0
      ? bookElements
        .filter(el => categoryKeys.has(el.categoryId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : [];

    setCurrentCategory(targetCategory);
    setCategoryElements(elementsInCategory);
  }, [isElementMode, categoryId, decodedCategoryId, elementId, bookElements, bookElementCategories]);

  useEffect(() => {
    if (!isAllNodesMode) {
      return;
    }
    setCurrentStoryline(null);
    setCurrentCategory(null);
    setCategoryElements([]);
    const sorted = bookNodes.slice().sort((a, b) => a.start - b.start);
    setStorylineNodes(sorted);
  }, [isAllNodesMode, bookNodes]);

  useEffect(() => {
    if (!isAllElementsMode) {
      return;
    }
    setCurrentStoryline(null);
    setCurrentCategory(null);
    const sortedElements = bookElements
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    setCategoryElements(sortedElements);
  }, [isAllElementsMode, bookElements]);

  // Load full data for icon dropdown
  useEffect(() => {
    async function loadDropdownData() {
      try {
        const [lines, categories, nodeTags, elementTags] = await Promise.all([
          loadStorylines(projectId),
          loadCategories(projectId),
          loadNodeTags(projectId),
          loadElementTags(projectId),
        ]);
        setAllStorylines(lines);
        setAllCategories(categories);
        setAllNodeTags(nodeTags);
        setAllElementTags(elementTags);
      } catch (error) {
        log.error('Failed to load dropdown data:', error);
      }
    }
    if (showStorylineDropdown) {
      void loadDropdownData();
    }
  }, [projectId, loadStorylines, loadCategories, loadNodeTags, loadElementTags, showStorylineDropdown]);

  useEffect(() => {
    if (!canShowHeaderDropdown && showStorylineDropdown) {
      setShowStorylineDropdown(false);
      setStorylineDropdownPosition(null);
    }
  }, [canShowHeaderDropdown, showStorylineDropdown]);

  useEffect(() => {
    if (isElementMode && hoveredNodeId) {
      setHoveredNodeId(null);
      setHoverPosition(null);
    }
  }, [isElementMode, hoveredNodeId]);

  useEffect(() => {
    if (!isNodeTagFilterEnabled) {
      setFilteredNodeIdSet(null);
      return;
    }
    if (selectedNodeTagIds.length === 0) {
      setFilteredNodeIdSet(null);
      return;
    }

    let cancelled = false;
    async function applyNodeTagFilter() {
      try {
        const nodeIdGroups = await Promise.all(
          selectedNodeTagIds.map(tagId => getNodesWithTag(tagId, projectId))
        );
        if (cancelled) return;

        if (nodeIdGroups.length === 0) {
          setFilteredNodeIdSet(null);
          return;
        }

        const [firstGroup, ...restGroups] = nodeIdGroups;
        const intersection = firstGroup.filter(nodeId =>
          restGroups.every(group => group.includes(nodeId))
        );
        setFilteredNodeIdSet(new Set(intersection));
      } catch (error) {
        log.error('Failed to apply node tag filter:', error);
      }
    }

    void applyNodeTagFilter();
    return () => {
      cancelled = true;
    };
  }, [selectedNodeTagIds, getNodesWithTag, projectId, isNodeTagFilterEnabled]);

  useEffect(() => {
    if (!isElementTagFilterEnabled) {
      setFilteredElementIdSet(null);
      return;
    }
    if (selectedElementTagIds.length === 0) {
      setFilteredElementIdSet(null);
      return;
    }

    let cancelled = false;
    async function applyElementTagFilter() {
      try {
        const elementIdGroups = await Promise.all(
          selectedElementTagIds.map(tagId => getElementsWithTag(tagId, projectId))
        );
        if (cancelled) return;

        if (elementIdGroups.length === 0) {
          setFilteredElementIdSet(null);
          return;
        }

        const [firstGroup, ...restGroups] = elementIdGroups;
        const intersection = firstGroup.filter(elementId =>
          restGroups.every(group => group.includes(elementId))
        );
        setFilteredElementIdSet(new Set(intersection));
      } catch (error) {
        log.error('Failed to apply element tag filter:', error);
      }
    }

    void applyElementTagFilter();
    return () => {
      cancelled = true;
    };
  }, [selectedElementTagIds, getElementsWithTag, projectId, isElementTagFilterEnabled]);

  useEffect(() => {
    if (isNodeTagFilterEnabled) {
      if (selectedElementTagIds.length > 0) {
        setSelectedElementTagIds([]);
      }
      if (filteredElementIdSet) {
        setFilteredElementIdSet(null);
      }
      return;
    }

    if (isElementTagFilterEnabled) {
      if (selectedNodeTagIds.length > 0) {
        setSelectedNodeTagIds([]);
      }
      if (filteredNodeIdSet) {
        setFilteredNodeIdSet(null);
      }
    }
  }, [
    isNodeTagFilterEnabled,
    isElementTagFilterEnabled,
    selectedElementTagIds.length,
    selectedNodeTagIds.length,
    filteredElementIdSet,
    filteredNodeIdSet,
  ]);

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
  }, [nodeId, elementId, selectedNodeId, selectedElementId, storylineNodes, categoryElements]);

  if (!shouldShowTimeline) {
    return null;
  }

  const nodeItemsSource = isAllNodesMode
    ? bookNodes.slice().sort((a, b) => a.start - b.start)
    : storylineNodes;

  const filteredNodeItems = filteredNodeIdSet
    ? nodeItemsSource.filter(node => filteredNodeIdSet.has(node.id))
    : nodeItemsSource;

  const filteredElementItems = filteredElementIdSet
    ? categoryElements.filter(element => filteredElementIdSet.has(element.id))
    : categoryElements;

  // Calculate dynamic widths based on available space
  const timelineItems: Array<BookNode | BookElement> = isElementTimelineMode ? filteredElementItems : filteredNodeItems;
  const selectedItemId = isElementTimelineMode
    ? (isAllElementsMode ? selectedElementId : elementId)
    : (isAllNodesMode ? selectedNodeId : nodeId);
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
    if (isAllElementsMode || isAllNodesMode) {
      return;
    }
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
      setNodeSelection(item.id, 'ui');
      return;
    }
    setElementSelection(item.id, 'ui');
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

  const toggleNodeTagFilter = (tagId: string) => {
    setSelectedNodeTagIds(prev =>
      prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]
    );
  };

  const toggleElementTagFilter = (tagId: string) => {
    setSelectedElementTagIds(prev =>
      prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]
    );
  };

  const handleCreateStorylineFromDropdown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await createStoryline({
        projectId,
        name: 'New Storyline',
        summary: '',
      });

      const refreshed = await loadStorylines(projectId);
      setAllStorylines(refreshed);
    } catch (error) {
      log.error('Failed to create storyline:', error);
    }
  };

  const handleCreateCategoryFromDropdown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const created = await createCategory();
      const refreshed = await loadCategories(projectId);
      setAllCategories(refreshed);
      if (!currentCategory && !isAllElementsMode) {
        navigateToCategory(created.id);
      }
    } catch (error) {
      log.error('Failed to create category:', error);
    }
  };

  const handleCreateNodeTagFromDropdown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await createNodeTag({
        projectId,
        name: `Chapter Tag ${allNodeTags.length + 1}`,
      });
      const refreshed = await loadNodeTags(projectId);
      setAllNodeTags(refreshed);
    } catch (error) {
      log.error('Failed to create chapter tag:', error);
    }
  };

  const handleCreateElementTagFromDropdown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await createElementTag({
        projectId,
        name: `Element Tag ${allElementTags.length + 1}`,
      });
      const refreshed = await loadElementTags(projectId);
      setAllElementTags(refreshed);
    } catch (error) {
      log.error('Failed to create element tag:', error);
    }
  };

  const handleNavigateToAllNodesEditor = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigateTo('home/all-nodes');
    setShowStorylineDropdown(false);
    setStorylineDropdownPosition(null);
  };

  const handleNavigateToAllElementsEditor = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigateTo('home/all-elements');
    setShowStorylineDropdown(false);
    setStorylineDropdownPosition(null);
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
              background: isAllElementsMode
                ? '#5d8aa8'
                : isElementMode
                ? (currentCategory?.color || '#b89968')
                : isAllNodesMode
                  ? '#8b7355'
                  : (currentStoryline?.color || '#b89968'),
              cursor: canShowHeaderDropdown || (isElementMode && Boolean(currentCategory)) ? 'pointer' : 'default',
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
              if (canShowHeaderDropdown) {
                handleShowDropdown(e);
              }
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.1)';
              if (canShowHeaderDropdown) {
                handleHideDropdown();
              }
            }}
            title={isAllElementsMode
              ? 'All Elements'
              : isElementMode
              ? (currentCategory?.name || 'Category')
              : (isAllNodesMode ? 'All Nodes' : (currentStoryline?.name || 'Storyline'))}
          >
            {isAllElementsMode
              ? 'E'
              : isElementMode
              ? (currentCategory?.name ? currentCategory.name.charAt(0).toUpperCase() : '?')
              : (isAllNodesMode ? 'A' : (currentStoryline?.name ? currentStoryline.name.charAt(0).toUpperCase() : '?'))}
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

      {/* Header Dropdown */}
      {showStorylineDropdown && storylineDropdownPosition && (
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            left: Math.max(12, Math.min(storylineDropdownPosition.x, window.innerWidth - 980)),
            top: storylineDropdownPosition.y,
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
          onMouseEnter={() => {
            if (hideDropdownTimeoutRef.current) {
              clearTimeout(hideDropdownTimeoutRef.current);
              hideDropdownTimeoutRef.current = null;
            }
          }}
          onMouseLeave={handleHideDropdown}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1fr) minmax(320px, 1.4fr)',
              gap: 12,
              alignItems: 'stretch',
            }}
          >
            <div style={{ borderRight: '1px solid rgba(90, 151, 199, 0.45)', paddingRight: 12, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8 }}>Storylines</div>
              <div
                onClick={handleNavigateToAllNodesEditor}
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
                      background: storyline.id === currentStoryline?.id ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
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
                onClick={handleCreateStorylineFromDropdown}
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

            <div style={{ borderRight: '1px solid rgba(90, 151, 199, 0.45)', paddingRight: 12, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8 }}>Categories</div>
              <div
                onClick={handleNavigateToAllElementsEditor}
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
                {allCategories.map(category => (
                  <div
                    key={category.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateToCategory(category.id);
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
                      background: category.id === currentCategory?.id ? 'rgba(0, 0, 0, 0.06)' : 'transparent',
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
                onClick={handleCreateCategoryFromDropdown}
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
              <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 8 }}>Tags Filter</div>

              {isNodeTagFilterEnabled && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Chapter Tags</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {allNodeTags.map(tag => {
                      const selected = selectedNodeTagIds.includes(tag.id);
                      return (
                        <div
                          key={tag.id}
                          onClick={() => {
                            toggleNodeTagFilter(tag.id);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            border: '1px solid rgba(0, 0, 0, 0.14)',
                            background: selected ? 'rgba(93, 138, 168, 0.16)' : 'rgba(255, 255, 255, 0.75)',
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
                      onClick={(e) => {
                        void handleCreateNodeTagFromDropdown(e);
                      }}
                      style={{ cursor: 'pointer', fontSize: 13, color: 'rgba(0, 0, 0, 0.7)' }}
                    >
                      + chapter tag
                    </div>
                    <div
                      onClick={() => {
                        setSelectedNodeTagIds([]);
                      }}
                      style={{ cursor: 'pointer', fontSize: 13, color: 'rgba(0, 0, 0, 0.55)' }}
                    >
                      clear
                    </div>
                  </div>
                </>
              )}

              {isElementTagFilterEnabled && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginTop: isNodeTagFilterEnabled ? 10 : 0, marginBottom: 6 }}>Element Tags</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {allElementTags.map(tag => {
                      const selected = selectedElementTagIds.includes(tag.id);
                      return (
                        <div
                          key={tag.id}
                          onClick={() => {
                            toggleElementTagFilter(tag.id);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            border: '1px solid rgba(0, 0, 0, 0.14)',
                            background: selected ? 'rgba(93, 138, 168, 0.16)' : 'rgba(255, 255, 255, 0.75)',
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
                      onClick={(e) => {
                        void handleCreateElementTagFromDropdown(e);
                      }}
                      style={{ cursor: 'pointer', fontSize: 13, color: 'rgba(0, 0, 0, 0.7)' }}
                    >
                      + element tag
                    </div>
                    <div
                      onClick={() => {
                        setSelectedElementTagIds([]);
                      }}
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
      )}

      {/* Hover Preview */}
      {isNodeTimelineMode && (
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
