import { useState, useMemo, useCallback, useEffect, useRef, type UIEvent } from 'react';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';
import loglevel from 'loglevel';

import type { BookElement } from '../../domain/book-element';
import { useDataStore } from '../../store/data-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookElement } from '../../usecase/useBookElement';
import { useElementCategory } from '../../usecase/useElementCategory';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';

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

const formatShortDate = (input: string | number | Date) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return sameYear ? `${month}/${day}` : `${d.getFullYear() % 100}/${month}/${day}`;
};

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
  const { elementUi, timelineHeight } = useUiStore();
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedBookElementId = elementUi.selectedId;

  const activeProjectId = useMemo(() => {
    if (!projectId) {
      throw new Error('ElementPanel requires a non-empty projectId');
    }
    return projectId;
  }, [projectId]);

  const { createElement } = useBookElement({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const { updateCategory, getCategoryColor } = useElementCategory({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(new Set());

  const toggleCategoryCollapsed = useCallback((id: string) => {
    setCollapsedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Sub-header collapse-all toggles between "expand all" and "collapse all".
  useEffect(() => {
    const handler = () => {
      setCollapsedCategoryIds((prev) => {
        if (prev.size === 0) return new Set(bookElementCategories.map((c) => c.id));
        return new Set();
      });
    };
    events.on('left-sidebar:collapse-all', handler);
    return () => events.off('left-sidebar:collapse-all', handler);
  }, [bookElementCategories]);

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

  // Shell now owns the LeftSidebarHeader + LeftSidebarSubHeader chrome, so we
  // no longer need the internal create-category toolbar's height.
  const panelHeight = useMemo(
    () => `calc(100vh - 114px - ${timelineHeight}px)`,
    [timelineHeight],
  );

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

  // Secondary grouping inside a category. Elements with the same groupName
  // are clumped together; null groupName goes into the "ungrouped" bucket and
  // is rendered last with no header. Named groups are sorted alphabetically.
  // Within a group we preserve the parent ordering (updatedAt desc, from
  // bookElements load).
  const groupedByCategory = useMemo(() => {
    const out: Record<string, { groupName: string | null; items: BookElement[] }[]> = {};
    categoryIds.forEach((categoryId) => {
      const items = elementsByCategory[categoryId] ?? [];
      const buckets = new Map<string | null, BookElement[]>();
      items.forEach((el) => {
        const key = el.groupName?.trim() || null;
        const arr = buckets.get(key) ?? [];
        arr.push(el);
        buckets.set(key, arr);
      });
      const named: { groupName: string; items: BookElement[] }[] = [];
      let ungrouped: BookElement[] = [];
      buckets.forEach((arr, key) => {
        if (key === null) {
          ungrouped = arr;
        } else {
          named.push({ groupName: key, items: arr });
        }
      });
      named.sort((a, b) => a.groupName.localeCompare(b.groupName));
      out[categoryId] = [
        ...named.map((g) => ({ groupName: g.groupName as string | null, items: g.items })),
        ...(ungrouped.length > 0 ? [{ groupName: null as string | null, items: ungrouped }] : []),
      ];
    });
    return out;
  }, [categoryIds, elementsByCategory]);

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

  const handleCreateElement = useCallback(
    async (categoryId: string) => {
      try {
        const created = await createElement({ categoryId });
        openEntity({ entityType: 'element', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create element', error);
      }
    },
    [createElement, openEntity],
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
    const categoryColor = getCategoryColor(categoryId);

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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px 7px 14px',
          cursor: 'pointer',
          position: 'relative',
          background: selected ? 'hsl(var(--accent) / 0.08)' : 'transparent',
          transition: 'background 0.12s ease',
        }}
        onMouseEnter={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'hsl(var(--paper-deep))';
          }
        }}
        onMouseLeave={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'transparent';
          }
        }}
        onClick={() => {
          openEntity({ entityType: 'element', id: element.id });
        }}
        onDoubleClick={() => {
          promoteCurrentTab();
        }}
      >
        {selected && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: 5,
              bottom: 5,
              width: 2,
              background: 'hsl(var(--accent))',
            }}
          />
        )}

        {/* Element mark — diamond in category color */}
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12,
            color: categoryColor,
            flexShrink: 0,
            lineHeight: 1,
            width: 10,
            textAlign: 'center',
          }}
        >
          ◆
        </span>

        {/* Name */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            color: 'hsl(var(--ink-1))',
            fontWeight: selected ? 500 : 400,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span>{element.name}</span>
        </div>

        {/* Date */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            color: 'hsl(var(--ink-4))',
            flexShrink: 0,
            letterSpacing: '0.04em',
          }}
        >
          {formatShortDate(element.updatedAt)}
        </span>

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
          padding: 0,
        }}
      >
        <div
          ref={scrollContainerRef}
          onScroll={handlePanelScroll}
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
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
              style={{ marginBottom: 8 }}
            >
              <div
                onClick={() => openEntity({ entityType: 'category', id: categoryId })}
                onDoubleClick={() => promoteCurrentTab()}
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 2,
                  padding: '14px 10px 6px 12px',
                  background: 'hsl(var(--paper))',
                  borderBottom: '1px solid hsl(var(--rule) / 0.5)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleCategoryCollapsed(categoryId);
                    }}
                    title={collapsedCategoryIds.has(categoryId) ? 'Expand' : 'Collapse'}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 16,
                      height: 16,
                      border: 'none',
                      background: 'transparent',
                      color: 'hsl(var(--ink-4))',
                      cursor: 'pointer',
                      padding: 0,
                      flexShrink: 0,
                    }}
                  >
                    {collapsedCategoryIds.has(categoryId) ? (
                      <ChevronRight size={12} strokeWidth={2} />
                    ) : (
                      <ChevronDown size={12} strokeWidth={2} />
                    )}
                  </button>
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 2,
                      background: getCategoryColor(categoryId),
                      flexShrink: 0,
                    }}
                  />
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
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        color: 'hsl(var(--ink-2))',
                        padding: '2px 4px',
                        border: '1px solid hsl(var(--rule))',
                        borderRadius: 3,
                        background: 'hsl(var(--surface))',
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
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9.5,
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        color: 'hsl(var(--ink-3))',
                        fontWeight: 500,
                        cursor:
                          categoryById.get(categoryId) && !isReservedCategory(categoryId)
                            ? 'text'
                            : 'default',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {getCategoryLabel(categoryId)}
                    </span>
                  )}
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9.5,
                      color: 'hsl(var(--ink-4))',
                      flexShrink: 0,
                    }}
                  >
                    · {(elementsByCategory[categoryId] ?? []).length}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 2 }}>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCreateElement(categoryId);
                    }}
                    title="New element in this category"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      borderRadius: 3,
                      border: 'none',
                      background: 'transparent',
                      color: 'hsl(var(--ink-4))',
                      cursor: 'pointer',
                      padding: 0,
                      transition: 'background 0.12s, color 0.12s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                      e.currentTarget.style.color = 'hsl(var(--ink-1))';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = 'hsl(var(--ink-4))';
                    }}
                  >
                    <Plus size={13} strokeWidth={1.6} />
                  </button>
                </div>
              </div>

              {!collapsedCategoryIds.has(categoryId) &&
                (() => {
                  const groups = groupedByCategory[categoryId] ?? [];
                  let elementIndex = 0;
                  return groups.map((group) => {
                    const cards = group.items.map((element) => {
                      const card = renderElementCard(element, categoryId, elementIndex);
                      elementIndex += 1;
                      return card;
                    });
                    return (
                      <div key={`${categoryId}::${group.groupName ?? '__ungrouped__'}`}>
                        {group.groupName !== null && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '6px 10px 2px 26px',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 9,
                              textTransform: 'uppercase',
                              letterSpacing: '0.1em',
                              color: 'hsl(var(--ink-4))',
                            }}
                          >
                            <span
                              aria-hidden
                              style={{
                                width: 8,
                                height: 1,
                                background: 'hsl(var(--rule))',
                                flexShrink: 0,
                              }}
                            />
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {group.groupName}
                            </span>
                            <span style={{ color: 'hsl(var(--ink-4))' }}>· {group.items.length}</span>
                          </div>
                        )}
                        {cards}
                      </div>
                    );
                  });
                })()}
            </div>
          ))}

          {!hasElements && (
            <div
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-serif)',
                fontStyle: 'italic',
                color: 'hsl(var(--ink-3))',
                padding: '40px 20px',
                textAlign: 'center',
              }}
            >
              no elements yet.
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
            margin: '8px 0',
            width: '100%',
            borderRadius: 4,
            border: '1px solid hsl(var(--rule))',
            background: zoomRingHovered ? 'hsl(var(--surface) / 0.98)' : 'hsl(var(--surface) / 0.92)',
            boxShadow: zoomRingHovered
              ? '0 6px 18px hsl(var(--ink-1) / 0.12)'
              : '0 2px 8px hsl(var(--ink-1) / 0.06)',
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
              background: 'hsl(var(--ink-4))',
            }}
          />

          <div
            style={{
              position: 'absolute',
              left: ZOOM_RING_COLUMN_LEFT + ZOOM_RING_AXIS_OFFSET - 7,
              top: '50%',
              width: 14,
              height: 1,
              background: 'hsl(var(--ink-3))',
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
                      borderRadius: 2,
                      border: 'none',
                      borderLeft: `2px solid ${isActiveCategory ? anchor.color : 'transparent'}`,
                      background: isActiveCategory ? 'hsl(var(--paper-deep))' : 'transparent',
                      color: isActiveCategory ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9.5,
                      fontWeight: 500,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      textAlign: 'left',
                      padding: '0 8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      transition: 'background 120ms ease, color 120ms ease',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 1,
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
                              background: isActiveTick ? anchor.color : 'hsl(var(--ink-2))',
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
