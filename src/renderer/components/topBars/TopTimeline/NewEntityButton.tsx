import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useBookNode } from '../../../usecase/useBookNode';
import { useBookElement } from '../../../usecase/useBookElement';
import { useElementCategory } from '../../../usecase/useElementCategory';
import { useDataStore } from '../../../store/data-store';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useProjectTabs } from '../../../store/ui-store';
import { useSettingsStore } from '../../../store/settings-store';
import loglevel from 'loglevel';
import { useAuthStore } from '../../../store/auth';
import { CHAPTER_ORDER_STRIDE, isChapter, isDrift } from '../../../domain/book-node';

// Per-tab default width used by TopTimeline (TAB_MIN_WIDTH, the "still
// readable" threshold). When openTabs.length * this + chrome overhead exceeds
// the topbar width, the tab row is "filled at default width" and we drop the
// label so tabs keep their breathing room.
const TAB_DEFAULT_WIDTH = 120;
// Topbar chrome: left section (140) + right section (80) + MainTopBar
// horizontal padding (24) + room for the labeled button itself + a small
// buffer so the threshold trips before the tab row visibly cramps.
const TOPBAR_CHROME_OVERHEAD = 140 + 80 + 24 + 110 + 26;

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
  const { createElement } = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { bookNodes, bookElements, bookElementCategories, primaryStorylineByNode } =
    useDataStore();
  const { openTabs } = useProjectTabs(projectId);
  const isModern = useSettingsStore((s) => s.appearanceSkin === 'modern');
  const decodedCategoryId = categoryId ? safeDecodeURIComponent(categoryId) : undefined;
  const isElementContext = Boolean(elementId || categoryId);
  // Drift editor context = currently routed to a node whose kind is 'drift'.
  // That's the only place "+ New" should create a drift; the left-panel
  // drift tab has its own dedicated create button via the sub-header.
  const focusedNode = nodeId ? bookNodes.find((n) => n.id === nodeId) ?? null : null;
  const isDriftContext = focusedNode != null && isDrift(focusedNode);
  const buttonLabel = isElementContext ? 'element' : isDriftContext ? 'drift' : 'chapter';

  // Compact when the tab row, at its readable default width, would exceed the
  // space the topbar can give it alongside a labeled create button. Measuring
  // .app-chrome (the AppTopbar root) instead of our own slot keeps the signal
  // invariant under our own mode switch — otherwise toggling compact would
  // free up room and oscillate back to full.
  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const el = document.querySelector('.app-chrome') as HTMLElement | null;
    if (!el) return;
    const compute = () => {
      const threshold = openTabs.length * TAB_DEFAULT_WIDTH + TOPBAR_CHROME_OVERHEAD;
      setIsCompact(el.clientWidth < threshold);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [openTabs.length]);

  const handleCreateChapter = async () => {
    try {
      let defaultStorylineId: string | null = null;

      // Only context-derived storylines count:
      //   1. current storyline editor route
      //   2. focused node's primary storyline
      // Anything else → null (chapter goes 未归属). No silent fallback to
      // `storylines[0]` and no auto-create.
      if (storylineId) {
        defaultStorylineId = storylineId;
      } else if (nodeId) {
        defaultStorylineId = primaryStorylineByNode[nodeId] ?? null;
      }

      // Use the global chapter max + STRIDE, matching every other create-
      // chapter entry point (LeftSidebar / ChapterPanel / ImportDialog) so the
      // user only has to learn one "where does a new chapter land" rule.
      // Filtering by `isChapter` narrows bookOrder to a non-nullable number.
      const maxOrder = bookNodes
        .filter(isChapter)
        .reduce((m, n) => Math.max(m, n.bookOrder), 0);
      const nextOrder = maxOrder + CHAPTER_ORDER_STRIDE;

      const newNode = await createNode({
        kind: 'chapter',
        title: 'New Chapter',
        mainStorylineId: defaultStorylineId,
        bookOrder: nextOrder,
      });

      openEntity({ entityType: 'node', id: newNode.id }, { preview: false });

      setTimeout(() => {
        const timelineContainer = document.querySelector(
          '[data-timeline-container]',
        ) as HTMLElement | null;
        if (timelineContainer) {
          const GRID_UNIT = 20;
          timelineContainer.scrollTo({
            left: nextOrder * GRID_UNIT,
            behavior: 'smooth',
          });
        }
      }, 100);
    } catch (error) {
      log.error('Failed to create chapter:', error);
    }
  };

  const handleCreateDrift = async () => {
    try {
      const created = await createNode({
        kind: 'drift',
        title: 'New Drift',
        bookOrder: null,
        mainStorylineId: null,
      });
      openEntity({ entityType: 'node', id: created.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create drift:', error);
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
    } else if (isDriftContext) {
      void handleCreateDrift();
    } else {
      void handleCreateChapter();
    }
  };

  return (
    <button
      onClick={handleClick}
      aria-label={`新建 ${buttonLabel}`}
      title={`新建 ${buttonLabel}`}
      style={
        {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: isCompact ? 0 : 6,
          padding: isModern
            ? isCompact
              ? 0
              : '4px 12px'
            : isCompact
              ? '5px 6px'
              : '5px 10px',
          width: isModern && isCompact ? 24 : undefined,
          height: isModern && isCompact ? 24 : undefined,
          borderRadius: isModern ? (isCompact ? '50%' : 999) : 4,
          border: '1px solid hsl(var(--rule))',
          background: 'transparent',
          color: isModern ? 'hsl(var(--ink-3))' : 'hsl(var(--ink-2))',
          fontSize: 11.5,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties
      }
      onMouseEnter={
        isModern
          ? undefined
          : (event) => {
              event.currentTarget.style.background = 'hsl(var(--ink-1))';
              event.currentTarget.style.borderColor = 'hsl(var(--ink-1))';
              event.currentTarget.style.color = 'hsl(var(--paper))';
            }
      }
      onMouseLeave={
        isModern
          ? undefined
          : (event) => {
              event.currentTarget.style.background = 'transparent';
              event.currentTarget.style.borderColor = 'hsl(var(--rule))';
              event.currentTarget.style.color = 'hsl(var(--ink-2))';
            }
      }
    >
      <Plus size={13} strokeWidth={1.8} />
      {!isCompact && <span>{buttonLabel}</span>}
    </button>
  );
}
