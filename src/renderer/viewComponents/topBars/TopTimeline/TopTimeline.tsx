import { useState, useEffect, useRef } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { useDataStore } from '../../../store/data-store';
import { useStoryline } from '../../../usecase/useStoryline';
import { useElementCategory } from '../../../usecase/useElementCategory';
import { useNodeTag } from '../../../usecase/useNodeTag';
import { useElementTag } from '../../../usecase/useElementTag';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useSettingsStore } from '../../../store/settings-store';
import { useRecentEntitiesStore } from '../../../store/recent-entities-store';
import type { Storyline } from '../../../domain/storyline';
import type { BookNode } from '../../../domain/book-node';
import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import type { NodeTag } from '../../../domain/node-tag';
import type { ElementTag } from '../../../domain/element-tag';
import { useAuthStore } from '../../../store/auth';
import { useUiStore } from '../../../store/ui-store';
import { NodeHoverPreview } from '../../NodeHoverPreview';
import { TopTimelineTabs } from './TopTimelineTabs';
import { TopTimelineDropdown } from './TopTimelineDropdown';
import { useTimelineTabWidths } from './useTimelineTabWidths';
import { sortElementsForTimeline, type ElementTimelineSortMode } from './element-timeline-sort';
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
  const user = useAuthStore(state => state.user);
  const {
    projectId,
    navigateToStoryline,
    navigateToCategory,
    navigateToNode,
    navigateToElement,
    navigateTo,
  } = useProjectNavigation();
  if (!projectId) {
    log.error('No projectId in params, cannot render TopTimeline');
    throw new Error('No projectId in params');
  }
  if (!user) {
    log.error('No user in auth store, cannot render TopTimeline');
    throw new Error('No user in auth store');
  }
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
  const preferAllNodeTimeline = useUiStore((state) => state.preferAllNodeTimeline);
  const preferAllElementTimeline = useUiStore((state) => state.preferAllElementTimeline);
  const setPreferAllNodeTimeline = useUiStore((state) => state.setPreferAllNodeTimeline);
  const setPreferAllElementTimeline = useUiStore((state) => state.setPreferAllElementTimeline);
  const recentEntities = useRecentEntitiesStore((state) => state.items);
  const touchRecentEntity = useRecentEntitiesStore((state) => state.touchEntity);
  const trimRecentEntities = useRecentEntitiesStore((state) => state.trimToLimit);
  const recentEntitiesLimit = useSettingsStore((state) => state.recentEntitiesLimit);
  const { getStorylineById, createStoryline } = useStoryline({
    projectId: projectId,
    userId: user.id,
  });
  const { createCategory } = useElementCategory({
    projectId: projectId,
    userId: user.id,
  });
  const { loadTags: loadNodeTags, createTag: createNodeTag, getNodesWithTag } = useNodeTag({
    projectId: projectId,
    userId: user.id,
  });
  const { loadTags: loadElementTags, createTag: createElementTag, getElementsWithTag } = useElementTag({
    projectId: projectId,
    userId: user.id,
  });

  const [currentStoryline, setCurrentStoryline] = useState<Storyline | null>(null);
  const [storylineNodes, setStorylineNodes] = useState<BookNode[]>([]);
  const [currentCategory, setCurrentCategory] = useState<BookElementCategory | null>(null);
  const [categoryElements, setCategoryElements] = useState<BookElement[]>([]);
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

  const containerRef = useRef<HTMLDivElement>(null);
  const selectedNodeRef = useRef<HTMLDivElement>(null);
  const storylineIconRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const hideDropdownTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isElementMode = Boolean(categoryId || elementId);
  const isStorylineMode = Boolean(storylineId || nodeId);
  const decodedCategoryId = categoryId ? safeDecodeURIComponent(categoryId) : undefined;
  const isProjectHomeMode = location.pathname === `/project/${projectId}/home`;
  const isAllNodesMode = location.pathname.includes('/home/all-nodes') || location.pathname.includes('/editor/all-nodes');
  const isAllElementsMode = location.pathname.includes('/home/all-elements') || location.pathname.includes('/editor/all-elements');
  const showAllNodeGroup = isAllNodesMode || (Boolean(nodeId) && preferAllNodeTimeline);
  const showAllElementGroup = isAllElementsMode || (Boolean(elementId) && preferAllElementTimeline);
  const isNodeTimelineMode = isStorylineMode || showAllNodeGroup;
  const isElementTimelineMode = isElementMode || showAllElementGroup;
  const elementTimelineSortMode: ElementTimelineSortMode = 'category-then-created-at';
  const shouldShowTimeline = isNodeTimelineMode || isElementTimelineMode || isProjectHomeMode;
  const canShowHeaderDropdown = shouldShowTimeline;
  const isNodeTagFilterEnabled = isNodeTimelineMode;
  const isElementTagFilterEnabled = isElementTimelineMode;
  const allStorylines = storylines;
  const allCategories = bookElementCategories;

  // Load current node's primary storyline and all chapters in that storyline
  useEffect(() => {
    async function loadStorylineData() {
      try {
        if (!isStorylineMode || showAllNodeGroup) {
          if (!showAllNodeGroup) {
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

        // If still no storyline found, fall back to the first loaded storyline.
        if (!targetStoryline) {
          targetStoryline = storylines[0] ?? null;
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
  }, [nodeId, storylineId, isElementMode, showAllNodeGroup, isStorylineMode, bookNodes, storylines, getStorylineById]);

  useEffect(() => {
    if (!isElementMode || showAllElementGroup) {
      if (!showAllElementGroup) {
        setCurrentCategory(null);
        setCategoryElements([]);
      }
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
      ? sortElementsForTimeline(
        bookElements.filter(el => categoryKeys.has(el.categoryId)),
        bookElementCategories,
        elementTimelineSortMode
      )
      : [];

    setCurrentCategory(targetCategory);
    setCategoryElements(elementsInCategory);
  }, [
    isElementMode,
    showAllElementGroup,
    categoryId,
    decodedCategoryId,
    elementId,
    bookElements,
    bookElementCategories,
    elementTimelineSortMode,
  ]);

  useEffect(() => {
    if (!showAllNodeGroup) {
      return;
    }
    setCurrentStoryline(null);
    setCurrentCategory(null);
    setCategoryElements([]);
    const sorted = bookNodes.slice().sort((a, b) => a.start - b.start);
    setStorylineNodes(sorted);
  }, [showAllNodeGroup, bookNodes]);

  useEffect(() => {
    if (!showAllElementGroup) {
      return;
    }
    setCurrentStoryline(null);
    setCurrentCategory(null);
    const sortedElements = sortElementsForTimeline(
      bookElements,
      bookElementCategories,
      elementTimelineSortMode
    );
    setCategoryElements(sortedElements);
  }, [showAllElementGroup, bookElements, bookElementCategories, elementTimelineSortMode]);

  useEffect(() => {
    trimRecentEntities(recentEntitiesLimit);
  }, [trimRecentEntities, recentEntitiesLimit]);

  useEffect(() => {
    if (!nodeId) {
      return;
    }
    if (!bookNodes.some((node) => node.id === nodeId)) {
      return;
    }
    touchRecentEntity(
      { projectId, entityId: nodeId, entityType: 'node' },
      recentEntitiesLimit
    );
  }, [nodeId, projectId, bookNodes, touchRecentEntity, recentEntitiesLimit]);

  useEffect(() => {
    if (!elementId) {
      return;
    }
    if (!bookElements.some((element) => element.id === elementId)) {
      return;
    }
    touchRecentEntity(
      { projectId, entityId: elementId, entityType: 'element' },
      recentEntitiesLimit
    );
  }, [elementId, projectId, bookElements, touchRecentEntity, recentEntitiesLimit]);

  useEffect(() => {
    if (!showAllNodeGroup || !selectedNodeId) {
      return;
    }
    if (!bookNodes.some((node) => node.id === selectedNodeId)) {
      return;
    }
    touchRecentEntity(
      { projectId, entityId: selectedNodeId, entityType: 'node' },
      recentEntitiesLimit
    );
  }, [showAllNodeGroup, selectedNodeId, projectId, bookNodes, touchRecentEntity, recentEntitiesLimit]);

  useEffect(() => {
    if (!showAllElementGroup || !selectedElementId) {
      return;
    }
    if (!bookElements.some((element) => element.id === selectedElementId)) {
      return;
    }
    touchRecentEntity(
      { projectId, entityId: selectedElementId, entityType: 'element' },
      recentEntitiesLimit
    );
  }, [showAllElementGroup, selectedElementId, projectId, bookElements, touchRecentEntity, recentEntitiesLimit]);

  // Load full data for icon dropdown
  useEffect(() => {
    async function loadDropdownData() {
      try {
        const [nodeTags, elementTags] = await Promise.all([
          loadNodeTags(projectId),
          loadElementTags(projectId),
        ]);
        setAllNodeTags(nodeTags);
        setAllElementTags(elementTags);
      } catch (error) {
        log.error('Failed to load dropdown data:', error);
      }
    }
    if (showStorylineDropdown) {
      void loadDropdownData();
    }
  }, [projectId, loadNodeTags, loadElementTags, showStorylineDropdown]);

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

  const recentTimelineItems: Array<BookNode | BookElement> = (() => {
    const records = recentEntities.filter((item) => item.projectId === projectId);
    const orderedItems: Array<BookNode | BookElement> = [];

    for (const record of records) {
      if (record.entityType === 'node') {
        const matchedNode = bookNodes.find((node) => node.id === record.entityId);
        if (matchedNode) {
          orderedItems.push(matchedNode);
        }
        continue;
      }

      const matchedElement = bookElements.find((element) => element.id === record.entityId);
      if (matchedElement) {
        orderedItems.push(matchedElement);
      }
    }

    return orderedItems;
  })();

  const nodeItemsSource = showAllNodeGroup
    ? bookNodes.slice().sort((a, b) => a.start - b.start)
    : storylineNodes;

  const filteredNodeItems = filteredNodeIdSet
    ? nodeItemsSource.filter(node => filteredNodeIdSet.has(node.id))
    : nodeItemsSource;

  const filteredElementItems = filteredElementIdSet
    ? categoryElements.filter(element => filteredElementIdSet.has(element.id))
    : categoryElements;

  // Calculate dynamic widths based on available space
  const timelineItems: Array<BookNode | BookElement> = isProjectHomeMode
    ? recentTimelineItems
    : (isElementTimelineMode ? filteredElementItems : filteredNodeItems);
  const selectedItemId = isProjectHomeMode
    ? null
    : (isElementTimelineMode
      ? (showAllElementGroup ? selectedElementId : elementId)
      : (showAllNodeGroup ? selectedNodeId : nodeId));
  const storylineColorMap = new Map(storylines.map((storyline) => [storyline.id, storyline.color]));
  const categoryColorMap = new Map(bookElementCategories.map((category) => [category.id, category.color]));

  // Safari-style tab width calculation
  const ICON_WIDTH = 32;
  const GAP = 8;
  const { getNodeWidth } = useTimelineTabWidths({
    timelineItems,
    containerWidth,
    selectedItemId,
    gap: GAP,
  });

  const handleHeaderClick = () => {
    if (isProjectHomeMode) {
      return;
    }
    if (showAllElementGroup || showAllNodeGroup) {
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
    if (isProjectHomeMode) {
      if ('title' in item) {
        setNodeSelection(item.id, 'ui');
        navigateToNode(item.id);
        return;
      }
      setElementSelection(item.id, 'ui');
      navigateToElement(item.id);
      return;
    }

    if ('title' in item) {
      if (showAllNodeGroup) {
        setPreferAllNodeTimeline(true);
      }
      setNodeSelection(item.id, 'ui');
      return;
    }
    if (showAllElementGroup) {
      setPreferAllElementTimeline(true);
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

  const handleCreateStorylineFromDropdown = async () => {
    try {
      await createStoryline({
        projectId,
        name: 'New Storyline',
        summary: '',
      });
    } catch (error) {
      log.error('Failed to create storyline:', error);
    }
  };

  const handleCreateCategoryFromDropdown = async () => {
    try {
      const created = await createCategory();
      if (!currentCategory && !showAllElementGroup) {
        navigateToCategory(created.id);
      }
    } catch (error) {
      log.error('Failed to create category:', error);
    }
  };

  const handleCreateNodeTagFromDropdown = async () => {
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

  const handleCreateElementTagFromDropdown = async () => {
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

  const closeStorylineDropdown = () => {
    setShowStorylineDropdown(false);
    setStorylineDropdownPosition(null);
  };

  const handleNavigateToAllNodesEditor = () => {
    navigateTo('home/all-nodes');
    closeStorylineDropdown();
  };

  const handleNavigateToAllElementsEditor = () => {
    navigateTo('home/all-elements');
    closeStorylineDropdown();
  };

  if (!shouldShowTimeline) {
    return null;
  }

  return (
    <>
      <TopTimelineTabs
        iconWidth={ICON_WIDTH}
        gap={GAP}
        containerRef={containerRef}
        selectedNodeRef={selectedNodeRef}
        storylineIconRef={storylineIconRef}
        canShowHeaderDropdown={canShowHeaderDropdown}
        isProjectHomeMode={isProjectHomeMode}
        isAllElementsMode={showAllElementGroup}
        isElementMode={isElementMode}
        isAllNodesMode={showAllNodeGroup}
        currentCategory={currentCategory}
        currentStoryline={currentStoryline}
        recentEntitiesLimit={recentEntitiesLimit}
        onHeaderClick={handleHeaderClick}
        onShowDropdown={handleShowDropdown}
        onHideDropdown={handleHideDropdown}
        timelineItems={timelineItems}
        selectedItemId={selectedItemId}
        getNodeWidth={getNodeWidth}
        onItemClick={handleItemClick}
        onNodeMouseEnter={handleMouseEnter}
        onItemMouseLeave={handleMouseLeave}
        storylineColorMap={storylineColorMap}
        categoryColorMap={categoryColorMap}
      />

      <TopTimelineDropdown
        show={showStorylineDropdown}
        position={storylineDropdownPosition}
        dropdownRef={dropdownRef}
        onMouseEnter={() => {
          if (hideDropdownTimeoutRef.current) {
            clearTimeout(hideDropdownTimeoutRef.current);
            hideDropdownTimeoutRef.current = null;
          }
        }}
        onMouseLeave={handleHideDropdown}
        isAllNodesMode={showAllNodeGroup}
        isAllElementsMode={showAllElementGroup}
        allStorylines={allStorylines}
        currentStoryline={currentStoryline}
        allCategories={allCategories}
        currentCategory={currentCategory}
        onNavigateToAllNodesEditor={handleNavigateToAllNodesEditor}
        onNavigateToAllElementsEditor={handleNavigateToAllElementsEditor}
        onSelectStoryline={(targetStorylineId) => {
          navigateToStoryline(targetStorylineId);
          closeStorylineDropdown();
        }}
        onSelectCategory={(targetCategoryId) => {
          navigateToCategory(targetCategoryId);
          closeStorylineDropdown();
        }}
        onCreateStoryline={() => {
          void handleCreateStorylineFromDropdown();
        }}
        onCreateCategory={() => {
          void handleCreateCategoryFromDropdown();
        }}
        isNodeTagFilterEnabled={isNodeTagFilterEnabled}
        isElementTagFilterEnabled={isElementTagFilterEnabled}
        allNodeTags={allNodeTags}
        allElementTags={allElementTags}
        selectedNodeTagIds={selectedNodeTagIds}
        selectedElementTagIds={selectedElementTagIds}
        onToggleNodeTagFilter={toggleNodeTagFilter}
        onToggleElementTagFilter={toggleElementTagFilter}
        onCreateNodeTag={() => {
          void handleCreateNodeTagFromDropdown();
        }}
        onCreateElementTag={() => {
          void handleCreateElementTagFromDropdown();
        }}
        onClearNodeTagFilters={() => {
          setSelectedNodeTagIds([]);
        }}
        onClearElementTagFilters={() => {
          setSelectedElementTagIds([]);
        }}
      />

      {/* Hover Preview */}
      {isNodeTimelineMode && (
        <NodeHoverPreview
          node={hoveredNodeId ? bookNodes.find((n) => n.id === hoveredNodeId) ?? null : null}
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
