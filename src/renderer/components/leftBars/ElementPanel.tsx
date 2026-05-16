import { useState, useMemo, useCallback, useEffect, useRef, type UIEvent } from 'react';
import { Plus, Trash2, MoreVertical, Edit3 } from 'lucide-react';
import loglevel from 'loglevel';

import type { BookElement } from '../../domain/book-element';
import { useDataStore } from '../../store/data-store';
import { useUiStore } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookElement } from '../../usecase/useBookElement';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';

const log = loglevel.getLogger('ElementPanel');
log.setLevel(loglevel.levels.ERROR);

const ZOOM_RING_ACCELERATION_TRIGGER = 0.012;
const ZOOM_RING_MIN_VELOCITY = 0.16;
const ZOOM_RING_REFRESH_VELOCITY = 0.04;
const ZOOM_RING_HIDE_DELAY = 950;
const ZOOM_RING_MAX_DRIFT = 10;
const ZOOM_RING_BADGE_HEIGHT_MIN = 18;
const ZOOM_RING_BADGE_HEIGHT_MAX = 28;
const ZOOM_RING_BADGE_GAP = 4;
const ZOOM_RING_COLUMN_LEFT = 10;
const ZOOM_RING_COLUMN_WIDTH = 102;
const ZOOM_RING_AXIS_OFFSET = 10;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type CategorySectionMetric = {
  categoryId: string;
  top: number;
  height: number;
  elementCount: number;
};

type ActiveTick = {
  categoryId: string;
  elementIndex: number;
} | null;

export function ElementPanel() {
  const { bookElements, bookElementCategories } = useDataStore();
  const { elementUi, setElementSelection, timelineHeight } = useUiStore();
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, navigateToCategory } = useProjectNavigation();
  const selectedBookElementId = elementUi.selectedId;

  const activeProjectId = useMemo(() => {
    if (!projectId) {
      throw new Error('ElementPanel requires a non-empty projectId');
    }
    return projectId;
  }, [projectId]);

  const { createElement, removeElement, updateElement } = useBookElement({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const { createCategory, updateCategory, getCategoryColor } = useElementCategory({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [editingElementName, setEditingElementName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');

  const [zoomRingVisible, setZoomRingVisible] = useState(false);
  const [zoomRingHovered, setZoomRingHovered] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [sectionMetrics, setSectionMetrics] = useState<CategorySectionMetric[]>([]);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const categorySectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const elementCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const hideRingTimerRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastScrollTimeRef = useRef<number | null>(null);
  const lastScrollVelocityRef = useRef(0);
  const zoomRingVisibleRef = useRef(false);
  const zoomRingHoveredRef = useRef(false);
  const suppressRingUntilRef = useRef(0);

  const panelHeight = useMemo(() => `calc(100vh - 120px - ${timelineHeight}px)`, [timelineHeight]);

  const categoryById = useMemo(
    () => new Map(bookElementCategories.map((category) => [category.id, category])),
    [bookElementCategories],
  );

  const getCategoryLabel = useCallback(
    (categoryId: string) => {
      return categoryById.get(categoryId)?.name ?? categoryId;
    },
    [categoryById],
  );

  const isReservedCategory = useCallback(
    (categoryId: string) => {
      return categoryById.get(categoryId)?.name === 'others';
    },
    [categoryById],
  );

  const categoryIds = useMemo(() => {
    const ids = new Set<string>();
    bookElementCategories.forEach((category) => {
      if (category.id?.trim()) {
        ids.add(category.id.trim());
      }
    });
    bookElements.forEach((element) => {
      if (element.categoryId?.trim()) {
        ids.add(element.categoryId.trim());
      }
    });

    const result = Array.from(ids);
    result.sort((a, b) => {
      const labelA = getCategoryLabel(a);
      const labelB = getCategoryLabel(b);
      if (labelA === 'others') return 1;
      if (labelB === 'others') return -1;
      return labelA.localeCompare(labelB);
    });

    return result;
  }, [bookElementCategories, bookElements, getCategoryLabel]);

  const elementsByCategory = useMemo(() => {
    const grouped: Record<string, BookElement[]> = {};
    categoryIds.forEach((categoryId) => {
      grouped[categoryId] = [];
    });

    bookElements.forEach((element) => {
      const categoryId = element.categoryId || 'others';
      if (!grouped[categoryId]) {
        grouped[categoryId] = [];
      }
      grouped[categoryId].push(element);
    });

    return grouped;
  }, [bookElements, categoryIds]);

  const clearHideRingTimer = useCallback(() => {
    if (hideRingTimerRef.current !== null) {
      window.clearTimeout(hideRingTimerRef.current);
      hideRingTimerRef.current = null;
    }
  }, []);

  const showZoomRing = useCallback(() => {
    clearHideRingTimer();
    setZoomRingVisible(true);
  }, [clearHideRingTimer]);

  const scheduleHideZoomRing = useCallback(() => {
    clearHideRingTimer();
    hideRingTimerRef.current = window.setTimeout(() => {
      if (zoomRingHoveredRef.current) {
        return;
      }
      setZoomRingVisible(false);
    }, ZOOM_RING_HIDE_DELAY);
  }, [clearHideRingTimer]);

  useEffect(() => {
    zoomRingVisibleRef.current = zoomRingVisible;
    if (!zoomRingVisible) {
      lastScrollVelocityRef.current = 0;
    }
  }, [zoomRingVisible]);

  useEffect(() => {
    zoomRingHoveredRef.current = zoomRingHovered;
  }, [zoomRingHovered]);

  useEffect(() => {
    return () => {
      clearHideRingTimer();
    };
  }, [clearHideRingTimer]);

  const handleDeleteElement = useCallback(
    async (id: string) => {
      try {
        await removeElement(id);
        if (selectedBookElementId === id) {
          setElementSelection(null, 'ui');
        }
      } catch (error) {
        log.error('Failed to delete element', error);
      }
    },
    [removeElement, selectedBookElementId, setElementSelection],
  );

  const handleCreateElement = useCallback(
    async (categoryId: string) => {
      try {
        const created = await createElement({ categoryId });
        setElementSelection(created.id, 'ui');
      } catch (error) {
        log.error('Failed to create element', error);
      }
    },
    [createElement, setElementSelection],
  );

  const handleCreateCategory = useCallback(async () => {
    try {
      const created = await createCategory();
      window.requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        const section = categorySectionRefs.current[created.id];
        if (!container || !section) {
          return;
        }
        showZoomRing();
        container.scrollTo({
          top: Math.max(section.offsetTop - 12, 0),
          behavior: 'smooth',
        });
        scheduleHideZoomRing();
      });
    } catch (error) {
      log.error('Failed to create new category', error);
    }
  }, [createCategory, scheduleHideZoomRing, showZoomRing]);

  const handleSaveElementName = useCallback(
    async (elementId: string) => {
      const nextName = editingElementName.trim();
      if (!nextName) {
        setEditingElementId(null);
        setEditingElementName('');
        return;
      }

      try {
        await updateElement(elementId, { name: nextName });
      } catch (error) {
        log.error('Failed to update element name', error);
      } finally {
        setEditingElementId(null);
        setEditingElementName('');
      }
    },
    [editingElementName, updateElement],
  );

  const handleSaveCategoryName = useCallback(
    async (categoryId: string) => {
      const category = categoryById.get(categoryId);
      const nextName = editingCategoryName.trim();

      if (!category || category.name === 'others' || !nextName || nextName === category.name) {
        setEditingCategoryId(null);
        setEditingCategoryName('');
        return;
      }

      try {
        await updateCategory(categoryId, { name: nextName });
      } catch (error) {
        log.error('Failed to update category name', error);
      } finally {
        setEditingCategoryId(null);
        setEditingCategoryName('');
      }
    },
    [categoryById, editingCategoryName, updateCategory],
  );

  const measurePanelLayout = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const nextMetrics: CategorySectionMetric[] = categoryIds
      .map((categoryId) => {
        const section = categorySectionRefs.current[categoryId];
        if (!section) {
          return null;
        }
        const sectionRect = section.getBoundingClientRect();
        return {
          categoryId,
          top: sectionRect.top - containerRect.top + container.scrollTop,
          height: Math.max(sectionRect.height, 1),
          elementCount: (elementsByCategory[categoryId] ?? []).length,
        };
      })
      .filter((metric): metric is CategorySectionMetric => metric !== null);

    setSectionMetrics(nextMetrics);
    setScrollTop(container.scrollTop);
    setViewportHeight(container.clientHeight);
    setContentHeight(container.scrollHeight);
  }, [categoryIds, elementsByCategory]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      measurePanelLayout();
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [measurePanelLayout, bookElements.length, panelHeight]);

  useEffect(() => {
    const handleResize = () => {
      measurePanelLayout();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [measurePanelLayout]);

  const handlePanelScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const container = event.currentTarget;
      const now = performance.now();
      const nextTop = container.scrollTop;
      const delta = nextTop - lastScrollTopRef.current;
      const absDelta = Math.abs(delta);

      lastScrollTopRef.current = nextTop;
      setScrollTop(nextTop);
      setViewportHeight(container.clientHeight);
      setContentHeight(container.scrollHeight);

      if (Date.now() < suppressRingUntilRef.current) {
        lastScrollVelocityRef.current = 0;
        lastScrollTimeRef.current = now;
        return;
      }

      if (absDelta <= 0.5) {
        lastScrollVelocityRef.current = 0;
        lastScrollTimeRef.current = now;
        return;
      }

      const dt = Math.max(lastScrollTimeRef.current ? now - lastScrollTimeRef.current : 16, 8);
      const velocity = delta / dt;
      const acceleration = (velocity - lastScrollVelocityRef.current) / dt;
      const absVelocity = Math.abs(velocity);
      const absAcceleration = Math.abs(acceleration);

      const shouldShowByAcceleration =
        absAcceleration >= ZOOM_RING_ACCELERATION_TRIGGER && absVelocity >= ZOOM_RING_MIN_VELOCITY;

      if (shouldShowByAcceleration) {
        showZoomRing();
        scheduleHideZoomRing();
      } else if (zoomRingVisibleRef.current && absVelocity >= ZOOM_RING_REFRESH_VELOCITY) {
        scheduleHideZoomRing();
      }

      lastScrollVelocityRef.current = velocity;
      lastScrollTimeRef.current = now;
    },
    [scheduleHideZoomRing, showZoomRing],
  );

  const activeTick = useMemo<ActiveTick>(() => {
    const container = scrollContainerRef.current;
    if (!container || categoryIds.length === 0) {
      return null;
    }

    const centerY = scrollTop + viewportHeight / 2;
    const containerRect = container.getBoundingClientRect();
    let nearest: ActiveTick = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    categoryIds.forEach((categoryId) => {
      const elements = elementsByCategory[categoryId] ?? [];
      elements.forEach((element, elementIndex) => {
        const card = elementCardRefs.current[element.id];
        if (!card) {
          return;
        }
        const cardRect = card.getBoundingClientRect();
        const cardCenter =
          cardRect.top - containerRect.top + container.scrollTop + cardRect.height / 2;
        const distance = Math.abs(cardCenter - centerY);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = { categoryId, elementIndex };
        }
      });
    });

    return nearest;
  }, [categoryIds, elementsByCategory, scrollTop, viewportHeight]);

  const sectionMetricById = useMemo(() => {
    return new Map(sectionMetrics.map((metric) => [metric.categoryId, metric]));
  }, [sectionMetrics]);

  const zoomTrackHeight = Math.max(viewportHeight - 24, 120);
  const categoryBadgeHeight = useMemo(() => {
    const count = Math.max(categoryIds.length, 1);
    const availablePerBadge = Math.floor((zoomTrackHeight - 8) / count) - ZOOM_RING_BADGE_GAP;
    return clamp(availablePerBadge, ZOOM_RING_BADGE_HEIGHT_MIN, ZOOM_RING_BADGE_HEIGHT_MAX);
  }, [categoryIds.length, zoomTrackHeight]);
  const scrollRange = Math.max(contentHeight - viewportHeight, 0);
  const tickDrift = scrollRange > 0 ? (scrollTop / scrollRange) * ZOOM_RING_MAX_DRIFT : 0;

  const categoryAnchors = useMemo(() => {
    const lastIndex = Math.max(categoryIds.length - 1, 1);
    const maxAnchorTop = Math.max(zoomTrackHeight - categoryBadgeHeight, 0);
    const rawAnchors = categoryIds.map((categoryId, index) => {
      const metric = sectionMetricById.get(categoryId);
      const fallback = categoryIds.length <= 1 ? 0 : index / lastIndex;
      const normalizedTop = metric
        ? clamp(metric.top / Math.max(contentHeight - 1, 1), 0, 1)
        : fallback;
      return normalizedTop * maxAnchorTop;
    });

    let adjustedAnchors: number[] = rawAnchors;
    if (rawAnchors.length > 1) {
      const minGap = categoryBadgeHeight + ZOOM_RING_BADGE_GAP;
      if (minGap * (rawAnchors.length - 1) > maxAnchorTop) {
        const step = maxAnchorTop / (rawAnchors.length - 1);
        adjustedAnchors = rawAnchors.map((_, index) => index * step);
      } else {
        adjustedAnchors = [...rawAnchors];
        for (let index = 1; index < adjustedAnchors.length; index += 1) {
          adjustedAnchors[index] = Math.max(
            adjustedAnchors[index],
            adjustedAnchors[index - 1] + minGap,
          );
        }
        if (adjustedAnchors[adjustedAnchors.length - 1] > maxAnchorTop) {
          adjustedAnchors[adjustedAnchors.length - 1] = maxAnchorTop;
          for (let index = adjustedAnchors.length - 2; index >= 0; index -= 1) {
            adjustedAnchors[index] = Math.min(
              adjustedAnchors[index],
              adjustedAnchors[index + 1] - minGap,
            );
          }
        }
      }
    }

    return categoryIds.map((categoryId, index) => {
      return {
        categoryId,
        anchorTop: adjustedAnchors[index] ?? 0,
        elementCount: (elementsByCategory[categoryId] ?? []).length,
        color: getCategoryColor(categoryId),
        label: getCategoryLabel(categoryId),
      };
    });
  }, [
    categoryIds,
    zoomTrackHeight,
    categoryBadgeHeight,
    sectionMetricById,
    contentHeight,
    elementsByCategory,
    getCategoryColor,
    getCategoryLabel,
  ]);

  const jumpToCategory = useCallback(
    (categoryId: string) => {
      const container = scrollContainerRef.current;
      const section = categorySectionRefs.current[categoryId];
      if (!container || !section) {
        return;
      }

      clearHideRingTimer();
      suppressRingUntilRef.current = Date.now() + 650;
      setZoomRingVisible(false);
      lastScrollVelocityRef.current = 0;
      lastScrollTimeRef.current = null;
      container.scrollTo({
        top: Math.max(section.offsetTop - 8, 0),
        behavior: 'smooth',
      });
    },
    [clearHideRingTimer],
  );

  const renderElementCard = (element: BookElement, categoryId: string, elementIndex: number) => {
    const selected = element.id === selectedBookElementId;

    return (
      <div
        key={element.id}
        ref={(node) => {
          if (node) {
            elementCardRefs.current[element.id] = node;
            return;
          }
          delete elementCardRefs.current[element.id];
        }}
        data-category-id={categoryId}
        data-element-index={elementIndex}
        className="bg-paper shadow-paper hover:shadow-paper-lg transition-shadow"
        style={{
          border: selected
            ? '1px solid var(--accent, #b89968)'
            : '1px solid var(--accent-border, #e8dcc8)',
          padding: '14px 16px',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          cursor: 'pointer',
          marginBottom: 8,
        }}
        onClick={() => {
          setElementSelection(element.id, 'ui');
        }}
      >
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
        >
          <div
            style={{
              flex: 1,
              fontSize: 14,
              fontWeight: 600,
              color: '#3a2a1a',
            }}
          >
            {editingElementId === element.id ? (
              <input
                type="text"
                value={editingElementName}
                onChange={(event) => setEditingElementName(event.target.value)}
                onBlur={() => {
                  void handleSaveElementName(element.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void handleSaveElementName(element.id);
                  }
                  if (event.key === 'Escape') {
                    setEditingElementId(null);
                    setEditingElementName('');
                  }
                }}
                onFocus={(event) => event.target.select()}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                style={{
                  width: '100%',
                  fontSize: 14,
                  fontWeight: 600,
                  padding: '2px 4px',
                  border: '1px solid var(--accent-border, #e8dcc8)',
                  borderRadius: 4,
                  background: 'var(--bg-paper)',
                  color: '#3a2a1a',
                }}
              />
            ) : (
              <span
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  setEditingElementId(element.id);
                  setEditingElementName(element.name);
                }}
                style={{ cursor: 'text' }}
              >
                {element.name}
              </span>
            )}
          </div>

          <div style={{ position: 'relative' }} onClick={(event) => event.stopPropagation()}>
            <button
              onClick={() => {
                setOpenMenuId(openMenuId === element.id ? null : element.id);
              }}
              className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
              style={{
                border: '1px solid var(--accent-border, #e8dcc8)',
                borderRadius: 6,
                padding: 6,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
              title="Options"
            >
              <MoreVertical size={14} />
            </button>

            {openMenuId === element.id && (
              <>
                <div
                  style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 10,
                  }}
                  onClick={() => setOpenMenuId(null)}
                />
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 4,
                    background: '#fefdfb',
                    border: '1px solid var(--accent-border, #e8dcc8)',
                    borderRadius: 8,
                    boxShadow: '0 4px 12px rgba(139, 115, 85, 0.15)',
                    minWidth: 120,
                    zIndex: 20,
                    overflow: 'hidden',
                  }}
                >
                  <button
                    onClick={() => {
                      void handleDeleteElement(element.id);
                      setOpenMenuId(null);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 12px',
                      border: 'none',
                      background: 'transparent',
                      color: '#dc2626',
                      fontSize: 13,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ fontSize: 11, color: '#8b7355' }}>
          {new Date(element.updatedAt).toLocaleDateString()}
        </div>
      </div>
    );
  };

  const hasElements = bookElements.length > 0;

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <div
        style={{
          height: panelHeight,
          display: 'flex',
          flexDirection: 'column',
          padding: 5,
        }}
      >
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '4px 8px 10px',
          }}
        >
          <button
            onClick={() => {
              void handleCreateCategory();
            }}
            className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid var(--accent-border, #e8dcc8)',
              fontSize: 12,
              fontWeight: 600,
              color: '#5a4a3a',
              cursor: 'pointer',
            }}
          >
            <Plus size={13} />
            New Category
          </button>
        </div>

        <div
          ref={scrollContainerRef}
          onScroll={handlePanelScroll}
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            paddingRight: 6,
          }}
        >
          {categoryIds.map((categoryId) => (
            <div
              key={categoryId}
              ref={(node) => {
                if (node) {
                  categorySectionRefs.current[categoryId] = node;
                  return;
                }
                delete categorySectionRefs.current[categoryId];
              }}
              style={{ marginBottom: 16 }}
            >
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'rgba(0, 0, 0, 0.5)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '6px 8px 6px 0',
                  background: 'var(--bg-paper, #fefdfb)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {editingCategoryId === categoryId ? (
                    <input
                      type="text"
                      value={editingCategoryName}
                      onChange={(event) => setEditingCategoryName(event.target.value)}
                      onBlur={() => {
                        void handleSaveCategoryName(categoryId);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === 'Escape') {
                          setEditingCategoryId(null);
                          setEditingCategoryName('');
                        }
                      }}
                      onFocus={(event) => event.target.select()}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      style={{
                        minWidth: 120,
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'rgba(0, 0, 0, 0.75)',
                        padding: '2px 6px',
                        border: '1px solid var(--accent-border, #e8dcc8)',
                        borderRadius: 4,
                        background: 'var(--bg-paper, #fefdfb)',
                        textTransform: 'none',
                        letterSpacing: 'normal',
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <span
                      onDoubleClick={(event) => {
                        if (!categoryById.get(categoryId) || isReservedCategory(categoryId)) {
                          return;
                        }
                        event.stopPropagation();
                        setEditingCategoryId(categoryId);
                        setEditingCategoryName(getCategoryLabel(categoryId));
                      }}
                      title={
                        isReservedCategory(categoryId)
                          ? 'Reserved category'
                          : 'Double-click to rename'
                      }
                      style={{
                        cursor:
                          categoryById.get(categoryId) && !isReservedCategory(categoryId)
                            ? 'text'
                            : 'default',
                      }}
                    >
                      {getCategoryLabel(categoryId)}
                    </span>
                  )}
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: getCategoryColor(categoryId),
                    }}
                  />
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => navigateToCategory(encodeURIComponent(categoryId))}
                    className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
                    style={{
                      padding: '4px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--accent-border, #e8dcc8)',
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#5a4a3a',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <Edit3 size={11} />
                    Edit
                  </button>

                  <button
                    onClick={() => {
                      void handleCreateElement(categoryId);
                    }}
                    className="bg-accent hover:bg-accent-hover text-paper transition-colors"
                    style={{
                      padding: '4px 12px',
                      borderRadius: 6,
                      border: 'none',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <Plus size={12} />
                    New
                  </button>
                </div>
              </div>

              {(elementsByCategory[categoryId] ?? []).map((element, elementIndex) =>
                renderElementCard(element, categoryId, elementIndex),
              )}
            </div>
          ))}

          {!hasElements && (
            <div
              style={{
                fontSize: 13,
                color: '#8b7355',
                padding: '32px 20px',
                textAlign: 'center',
                background: '#f9f6f1',
                borderRadius: 12,
                border: '1px dashed var(--accent-border, #e8dcc8)',
              }}
            >
              No elements yet.
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          right: -144,
          top: 0,
          height: panelHeight,
          width: 132,
          zIndex: 12,
          opacity: zoomRingVisible ? 1 : 0,
          pointerEvents: zoomRingVisible ? 'auto' : 'none',
          transform: zoomRingVisible ? 'translateX(0)' : 'translateX(-10px)',
          transition: 'opacity 180ms ease, transform 220ms ease',
          display: 'flex',
          alignItems: 'stretch',
        }}
        onMouseEnter={() => {
          setZoomRingHovered(true);
          showZoomRing();
        }}
        onMouseLeave={() => {
          setZoomRingHovered(false);
          scheduleHideZoomRing();
        }}
      >
        <div
          style={{
            margin: '12px 0',
            width: '100%',
            borderRadius: 12,
            border: '1px solid rgba(90, 74, 58, 0.25)',
            background: zoomRingHovered ? 'rgba(250, 245, 237, 0.96)' : 'rgba(250, 245, 237, 0.86)',
            boxShadow: zoomRingHovered
              ? '0 10px 22px rgba(50, 40, 30, 0.18)'
              : '0 6px 16px rgba(50, 40, 30, 0.12)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: ZOOM_RING_COLUMN_LEFT + ZOOM_RING_AXIS_OFFSET,
              width: 1,
              background: 'rgba(80, 65, 48, 0.45)',
            }}
          />

          <div
            style={{
              position: 'absolute',
              left: ZOOM_RING_COLUMN_LEFT + ZOOM_RING_AXIS_OFFSET - 7,
              top: '50%',
              width: 14,
              height: 1,
              background: 'rgba(66, 54, 40, 0.7)',
              transform: 'translateY(-0.5px)',
            }}
          />

          <div
            style={{
              position: 'absolute',
              inset: 0,
              transform: `translateY(${tickDrift}px)`,
            }}
          >
            {categoryAnchors.map((anchor, index) => {
              const nextAnchorTop = categoryAnchors[index + 1]?.anchorTop ?? zoomTrackHeight - 2;
              const tickRegionTopBase = anchor.anchorTop + categoryBadgeHeight + 4;
              const tickRegionBottomBase = Math.max(nextAnchorTop - 5, tickRegionTopBase + 8);
              const tickRegionHeight = Math.max(tickRegionBottomBase - tickRegionTopBase, 8);
              const tickRegionTop = clamp(tickRegionTopBase, 0, Math.max(zoomTrackHeight - 8, 0));
              const isActiveCategory = activeTick?.categoryId === anchor.categoryId;
              const activeTickIndex = isActiveCategory ? (activeTick?.elementIndex ?? -1) : -1;

              return (
                <div key={anchor.categoryId}>
                  <button
                    onClick={() => jumpToCategory(anchor.categoryId)}
                    title={anchor.label}
                    style={{
                      position: 'absolute',
                      top: anchor.anchorTop,
                      left: ZOOM_RING_COLUMN_LEFT,
                      width: ZOOM_RING_COLUMN_WIDTH,
                      height: categoryBadgeHeight,
                      borderRadius: 0,
                      border: `1px solid ${isActiveCategory ? anchor.color : 'rgba(90, 74, 58, 0.45)'}`,
                      background: '#f8f3ea',
                      color: '#2f2418',
                      fontSize: 11,
                      fontWeight: isActiveCategory ? 700 : 600,
                      textAlign: 'left',
                      padding: '0 10px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      boxShadow: isActiveCategory ? `0 0 0 1px ${anchor.color}33` : 'none',
                      transition: 'border-color 120ms ease, box-shadow 120ms ease',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: anchor.color,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {anchor.label}
                    </span>
                  </button>

                  {anchor.elementCount > 0 && (
                    <div
                      style={{
                        position: 'absolute',
                        top: tickRegionTop,
                        left: ZOOM_RING_COLUMN_LEFT,
                        width: ZOOM_RING_COLUMN_WIDTH,
                        height: tickRegionHeight,
                        pointerEvents: 'none',
                      }}
                    >
                      {Array.from({ length: anchor.elementCount }).map((_, tickIndex) => {
                        const progress = (tickIndex + 0.5) / anchor.elementCount;
                        const isActiveTick = activeTickIndex === tickIndex;
                        return (
                          <div
                            key={`${anchor.categoryId}-${tickIndex}`}
                            style={{
                              position: 'absolute',
                              left: 0,
                              top: `${progress * 100}%`,
                              width: isActiveTick ? 24 : 16,
                              height: isActiveTick ? 3 : 2,
                              borderRadius: 2,
                              transform: 'translateY(-50%)',
                              background: isActiveTick ? anchor.color : 'rgba(58, 45, 30, 0.8)',
                              boxShadow: isActiveTick ? `0 0 0 1px ${anchor.color}33` : 'none',
                              opacity: isActiveTick || isActiveCategory ? 1 : 0.8,
                              transition: 'width 100ms ease, background 100ms ease',
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
