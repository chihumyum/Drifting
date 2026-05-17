import { Plus } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useBookNode } from '../../../usecase/useBookNode';
import { useStoryline } from '../../../usecase/useStoryline';
import { useBookElement } from '../../../usecase/useBookElement';
import { useElementCategory } from '../../../usecase/useElementCategory';
import { useDataStore } from '../../../store/data-store';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import loglevel from 'loglevel';
import { useAuthStore } from '../../../store/auth';

const log = loglevel.getLogger('NewEntityButton');
log.setLevel(loglevel.levels.ERROR);

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Self-adapting create button. Element-context (element/category route) → "Element";
// otherwise → "Chapter". Hidden on the project dashboard by AppTopbar.
export function NewEntityButton() {
  const { nodeId, storylineId, elementId, categoryId } = useParams<{
    nodeId?: string;
    storylineId?: string;
    elementId?: string;
    categoryId?: string;
  }>();
  const { projectId, openEntity } = useProjectNavigation();
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
  const decodedCategoryId = categoryId ? safeDecodeURIComponent(categoryId) : undefined;
  const isElementContext = Boolean(elementId || categoryId);
  const buttonLabel = isElementContext ? 'Element' : 'Chapter';

  const handleCreateChapter = async () => {
    try {
      let defaultStorylineId: string | null = null;

      // Priority 1: current storyline if in storyline editor.
      if (storylineId) {
        defaultStorylineId = storylineId;
      } else if (nodeId) {
        // Priority 2: selected node's primary storyline.
        const selectedNode = bookNodes.find((node) => node.id === nodeId);
        defaultStorylineId = selectedNode?.mainStorylineId ?? null;
      }
      // Priority 3: first available storyline.
      if (!defaultStorylineId) {
        defaultStorylineId = storylines[0]?.id ?? null;
      }
      // Priority 4: create one.
      if (!defaultStorylineId) {
        const created = await createStoryline({ projectId });
        defaultStorylineId = created.id;
      }

      const storylineNodes = bookNodes.filter(
        (node) => node.mainStorylineId === defaultStorylineId,
      );
      const maxStorylineEnd = storylineNodes.reduce((maxEnd, node) => {
        const nodeEnd = Math.max(node.end ?? node.start, node.start);
        return Math.max(maxEnd, nodeEnd);
      }, 0);
      const newStart = maxStorylineEnd > 0 ? maxStorylineEnd + 1 : 1;
      const newEnd = newStart + 10;

      const newNode = await createNode({
        title: 'New Chapter',
        mainStorylineId: defaultStorylineId,
        start: newStart,
        end: newEnd,
      });

      openEntity({ entityType: 'node', id: newNode.id }, { preview: false });

      setTimeout(() => {
        const timelineContainer = document.querySelector(
          '[data-timeline-container]',
        ) as HTMLElement | null;
        if (timelineContainer) {
          const GRID_UNIT = 20;
          timelineContainer.scrollTo({
            left: newStart * GRID_UNIT,
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
        targetCategoryId = decodedCategoryId ?? categoryId;
      } else if (elementId) {
        const element = bookElements.find((el) => el.id === elementId) ?? null;
        targetCategoryId = element?.categoryId ?? null;
      }
      if (!targetCategoryId) {
        targetCategoryId = bookElementCategories[0]?.id ?? null;
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
      openEntity({ entityType: 'element', id: newElement.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create element:', error);
    }
  };

  const handleClick = () => {
    if (isElementContext) {
      void handleCreateElement();
    } else {
      void handleCreateChapter();
    }
  };

  return (
    <button
      onClick={handleClick}
      style={
        {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '5px 10px',
          borderRadius: 4,
          border: '1px solid hsl(var(--rule))',
          background: 'transparent',
          color: 'hsl(var(--ink-2))',
          fontSize: 11.5,
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties
      }
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'hsl(var(--ink-1))';
        event.currentTarget.style.borderColor = 'hsl(var(--ink-1))';
        event.currentTarget.style.color = 'hsl(var(--paper))';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.borderColor = 'hsl(var(--rule))';
        event.currentTarget.style.color = 'hsl(var(--ink-2))';
      }}
    >
      <Plus size={13} strokeWidth={1.8} />
      <span>{buttonLabel}</span>
    </button>
  );
}
