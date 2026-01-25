import { Plus } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useBookElement } from '../../usecase/useBookElement';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import loglevel from "loglevel";
import { useAuthStore } from '../../store/auth';

const log = loglevel.getLogger("NewEntityButton");
log.setLevel(loglevel.levels.ERROR);

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
  const { navigateToNode, navigateToElement, projectId } = useProjectNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const { createNode, loadNodes, updateNode } = useBookNode({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { addNodeToStoryline, createStoryline, loadStorylines } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createElement, loadInitial } = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createCategory, loadCategories } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { bookNodes, storylines, bookElements, bookElementCategories } = useDataStore();
  const isElementContext = Boolean(elementId || categoryId);
  const buttonLabel = isElementContext ? 'Element' : 'Chapter';

  const handleCreateChapter = async () => {
    try {
      let currentNodes = bookNodes;
      if (currentNodes.length === 0) {
        currentNodes = await loadNodes();
      }

      // Determine target storyline
      let defaultStorylineId: string | null = null;

      // Priority 1: Use current storyline if in storyline editor
      if (storylineId) {
        defaultStorylineId = storylineId;
      }
      // Priority 2: Use selected node's primary storyline
      else if (nodeId) {
        const selectedNode = currentNodes.find((node) => node.id === nodeId);
        defaultStorylineId = selectedNode?.mainStorylineId ?? null;
      }

      // Priority 3: Use first available storyline
      if (!defaultStorylineId) {
        const availableStorylines = storylines.length > 0 ? storylines : await loadStorylines(projectId);
        defaultStorylineId = availableStorylines[0]?.id ?? null;
      }

      // Calculate insertion position
      let newStart = 1;
      let newEnd = 11; // Default length of 10 units
      const newLength = 10;

      // If in storyline editor, always insert at the end of current storyline
      // regardless of selectedNodeId
      if (defaultStorylineId) {
        const storylineNodes = currentNodes
          .filter((node) => node.mainStorylineId === defaultStorylineId)
          .sort((a, b) => a.start - b.start);

        if (storylineNodes.length > 0) {
          const lastNode = storylineNodes[storylineNodes.length - 1];
          const lastEnd = Math.max(lastNode.end ?? 0, lastNode.start);
          newStart = lastEnd + 1;
          newEnd = newStart + newLength;
        }

        // Find first overlapping node
        const firstOverlap = storylineNodes.find((node) => {
          const nodeStart = node.start;
          const nodeEnd = Math.max(node.end ?? 0, node.start);
          return nodeStart < newEnd && nodeEnd >= newStart;
        });

        if (firstOverlap) {
          // Shift amount is the length of the new chapter
          const shiftAmount = newEnd - newStart;

          // Shift all nodes from the first overlap onwards
          const nodesToShift = storylineNodes.filter((node) => node.start >= firstOverlap.start);

          for (const node of nodesToShift) {
            const nodeEnd = Math.max(node.end ?? 0, node.start);
            await updateNode(node.id, {
              start: node.start + shiftAmount,
              end: nodeEnd + shiftAmount,
            });
          }
        }
      }

      if (!defaultStorylineId) {
        const createdStoryline = await createStoryline({ projectId });
        defaultStorylineId = createdStoryline.id;
      }

      // Create the new node
      const newNode = await createNode({
        title: 'New Chapter',
        mainStorylineId: defaultStorylineId,
        start: newStart,
        end: newEnd,
      });

      if (defaultStorylineId) {
        await addNodeToStoryline(newNode.id, defaultStorylineId);
      }

      await loadNodes();
      navigateToNode(newNode.id);

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

  const handleCreateElement = async () => {
    try {
      let targetCategoryId: string | null = null;

      if (categoryId) {
        const match = bookElementCategories.find(
          (cat) => cat.id === categoryId || cat.name === categoryId
        );
        targetCategoryId = match?.id ?? null;
      }

      if (!targetCategoryId && elementId) {
        let element = bookElements.find((el) => el.id === elementId) ?? null;
        if (!element) {
          await loadInitial();
          element = useDataStore.getState().bookElements.find((el) => el.id === elementId) ?? null;
        }
        targetCategoryId = element?.categoryId ?? null;
      }

      if (!targetCategoryId) {
        const categories = bookElementCategories.length > 0 ? bookElementCategories : await loadCategories();
        targetCategoryId = categories[0]?.id ?? null;
      }

      if (!targetCategoryId) {
        const created = await createCategory('others');
        targetCategoryId = created.id;
      }

      if (!targetCategoryId) {
        log.error('No category available for new element');
        return;
      }

      const newElement = await createElement({ categoryId: targetCategoryId });
      navigateToElement(newElement.id);
    } catch (error) {
      log.error('Failed to create element:', error);
    }
  };

  return (
    <button
      onClick={isElementContext ? handleCreateElement : handleCreateChapter}
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
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'rgba(184, 153, 104, 0.2)';
        e.currentTarget.style.borderColor = 'rgba(184, 153, 104, 0.4)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'rgba(184, 153, 104, 0.1)';
        e.currentTarget.style.borderColor = 'rgba(184, 153, 104, 0.3)';
      }}
    >
      <Plus size={16} />
      <span>{buttonLabel}</span>
    </button>
  );
}
