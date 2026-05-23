import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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

// 宽度低于此值时隐藏 cell 上的日期，优先保证 title 显示。
const DATE_HIDE_WIDTH = 200;

const formatShortDate = (input: string | number | Date) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return sameYear ? `${month}/${day}` : `${d.getFullYear() % 100}/${month}/${day}`;
};

export function ElementPanel() {
  const { bookElements, bookElementCategories } = useDataStore();
  const { elementUi } = useUiStore();
  const sidebarWidth = useUiStore((s) => s.sidebars.left.width);
  const showDate = sidebarWidth >= DATE_HIDE_WIDTH;
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

  const { getCategoryColor } = useElementCategory({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(new Set());

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const categorySectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const footerScrollRef = useRef<HTMLDivElement | null>(null);
  const footerChipRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  // While a manual chip click is in effect, ignore scroll-driven updates so
  // the highlighted chip stays put even when the section can't fully scroll
  // to the anchor (e.g. last category near the end of the list).
  const manualActiveLockUntilRef = useRef<number>(0);

  // Footer height. null means "use natural one-row height + horizontal scroll".
  // Once dragged taller than the natural row, the inner scroll switches to
  // vertical with chips wrapping onto multiple lines. Persisted in ui-store.
  const footerHeight = useUiStore((s) => s.elementCategoryFooterHeight);
  const setFooterHeight = useUiStore((s) => s.setElementCategoryFooterHeight);
  const minFooterHeightRef = useRef<number>(0);
  const [hoverPreview, setHoverPreview] = useState<{
    element: BookElement;
    categoryColor: string;
    top: number;
    left: number;
  } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

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

  // Track which category section is currently at the top of the scroll
  // viewport, so the footer chip can highlight it.
  const updateActiveFromScroll = useCallback(() => {
    if (Date.now() < manualActiveLockUntilRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    // anchor a little below the top edge so the highlight flips as a category
    // header crosses past it
    const anchorY = containerRect.top + 8;

    let bestId: string | null = null;
    let bestTop = -Infinity;
    categorySectionRefs.current.forEach((el, id) => {
      const rect = el.getBoundingClientRect();
      // pick the last section whose top is at or above the anchor
      if (rect.top <= anchorY && rect.top > bestTop) {
        bestTop = rect.top;
        bestId = id;
      }
    });
    // fallback: first visible section
    if (!bestId) {
      let firstId: string | null = null;
      let firstTop = Infinity;
      categorySectionRefs.current.forEach((el, id) => {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > containerRect.top && rect.top < firstTop) {
          firstTop = rect.top;
          firstId = id;
        }
      });
      bestId = firstId;
    }
    setActiveCategoryId((prev) => (prev === bestId ? prev : bestId));
  }, []);

  // Auto-scroll the footer so the active chip stays in view.
  useEffect(() => {
    if (!activeCategoryId) return;
    const footer = footerScrollRef.current;
    const chip = footerChipRefs.current.get(activeCategoryId);
    if (!footer || !chip) return;
    const footerRect = footer.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    if (chipRect.left < footerRect.left + 8) {
      footer.scrollBy({ left: chipRect.left - footerRect.left - 16, behavior: 'smooth' });
    } else if (chipRect.right > footerRect.right - 8) {
      footer.scrollBy({ left: chipRect.right - footerRect.right + 16, behavior: 'smooth' });
    }
  }, [activeCategoryId]);

  const startFooterResize = useCallback((event: React.MouseEvent) => {
    if (!footerScrollRef.current) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = footerScrollRef.current.offsetHeight;
    const min = minFooterHeightRef.current || startHeight;

    const onMove = (ev: MouseEvent) => {
      const next = startHeight + (startY - ev.clientY);
      const max = Math.max(min, Math.round(window.innerHeight * 0.5));
      const clamped = Math.max(min, Math.min(max, next));
      // Snap back to "natural" when within a couple px of the min.
      setFooterHeight(clamped <= min + 2 ? null : clamped);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [setFooterHeight]);

  const scrollToCategory = useCallback((categoryId: string) => {
    // Lock the highlight to the clicked chip first. If the section can fully
    // scroll to the anchor, normal tracking would arrive at the same chip
    // once the lock expires; if it can't (last category near the bottom), the
    // chip stays selected until the user manually scrolls again.
    setActiveCategoryId(categoryId);
    manualActiveLockUntilRef.current = Date.now() + 700;
    const section = categorySectionRefs.current.get(categoryId);
    const container = scrollContainerRef.current;
    if (!section || !container) return;
    const sectionRect = section.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const delta = sectionRect.top - containerRect.top;
    container.scrollBy({ top: delta, behavior: 'smooth' });
  }, []);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleRowHoverEnter = useCallback(
    (element: BookElement, categoryColor: string, rect: DOMRect) => {
      clearHoverTimer();
      hoverTimerRef.current = window.setTimeout(() => {
        setHoverPreview({
          element,
          categoryColor,
          top: rect.top,
          left: rect.right + 8,
        });
      }, 220);
    },
    [clearHoverTimer],
  );

  const handleRowHoverLeave = useCallback(() => {
    clearHoverTimer();
    setHoverPreview(null);
  }, [clearHoverTimer]);

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

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

  // Lower bound for the resize gesture = natural one-row footer height.
  // Prefer measuring directly when footerHeight is null (the footer is at its
  // natural size). Otherwise derive it from a single chip's height plus the
  // footer's own padding+border — measuring offsetHeight while an explicit
  // height is applied would lock min to the persisted value, causing later
  // drags to jump straight past the 2-row size.
  useLayoutEffect(() => {
    if (!footerScrollRef.current) return;
    if (footerHeight == null) {
      minFooterHeightRef.current = footerScrollRef.current.offsetHeight;
      return;
    }
    const firstChip = footerChipRefs.current.values().next().value;
    if (firstChip) {
      // footer paddingTop + paddingBottom + borderTop
      minFooterHeightRef.current = firstChip.offsetHeight + 6 + 6 + 1;
    }
  }, [footerHeight, categoryIds.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    updateActiveFromScroll();
    container.addEventListener('scroll', updateActiveFromScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', updateActiveFromScroll);
    };
  }, [updateActiveFromScroll, categoryIds, collapsedCategoryIds]);

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

  const renderElementCard = (element: BookElement, categoryId: string, elementIndex: number) => {
    const selected = element.id === selectedBookElementId;
    const categoryColor = getCategoryColor(categoryId);

    return (
      <div
        key={element.id}
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
          handleRowHoverEnter(
            element,
            categoryColor,
            event.currentTarget.getBoundingClientRect(),
          );
        }}
        onMouseLeave={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'transparent';
          }
          handleRowHoverLeave();
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
        {showDate && (
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
        )}

      </div>
    );
  };

  const hasElements = bookElements.length > 0;

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        <div
          ref={scrollContainerRef}
          className="left-panel-scroll"
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
              ref={(el) => {
                if (el) categorySectionRefs.current.set(categoryId, el);
                else categorySectionRefs.current.delete(categoryId);
              }}
              data-category-section={categoryId}
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
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9.5,
                      textTransform: 'uppercase',
                      letterSpacing: '0.12em',
                      color: 'hsl(var(--ink-3))',
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {getCategoryLabel(categoryId)}
                  </span>
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

        {/* Category footer — horizontal chips; highlights the section currently
            scrolled into view and lets the user jump between categories. */}
        {categoryIds.length > 0 && (
          <div
            ref={footerScrollRef}
            className="left-panel-cat-footer"
            style={{
              position: 'relative',
              flexShrink: 0,
              display: 'flex',
              alignItems: footerHeight == null ? 'center' : 'flex-start',
              flexWrap: footerHeight == null ? 'nowrap' : 'wrap',
              alignContent: 'flex-start',
              gap: 4,
              padding: '6px 8px',
              overflowX: footerHeight == null ? 'auto' : 'hidden',
              overflowY: footerHeight == null ? 'hidden' : 'auto',
              borderTop: '1px solid hsl(var(--rule))',
              background: 'hsl(var(--paper))',
              whiteSpace: footerHeight == null ? 'nowrap' : 'normal',
              height: footerHeight ?? undefined,
            }}
          >
            {/* Invisible drag handle on the top border — no extra UI. */}
            <div
              onMouseDown={startFooterResize}
              title="拖拽调整高度"
              style={{
                position: 'absolute',
                top: -3,
                left: 0,
                right: 0,
                height: 6,
                cursor: 'ns-resize',
                zIndex: 5,
              }}
            />
            {categoryIds.map((categoryId) => {
              const active = categoryId === activeCategoryId;
              const color = getCategoryColor(categoryId);
              return (
                <button
                  key={categoryId}
                  ref={(el) => {
                    if (el) footerChipRefs.current.set(categoryId, el);
                    else footerChipRefs.current.delete(categoryId);
                  }}
                  onClick={() => scrollToCategory(categoryId)}
                  title={getCategoryLabel(categoryId)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    flexShrink: 0,
                    padding: '3px 8px',
                    border: '1px solid',
                    borderColor: active ? 'hsl(var(--ink-1))' : 'hsl(var(--rule))',
                    borderRadius: 3,
                    background: active ? 'hsl(var(--ink-1))' : 'transparent',
                    color: active ? 'hsl(var(--paper))' : 'hsl(var(--ink-3))',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    transition: 'background 0.12s, color 0.12s, border-color 0.12s',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 2,
                      background: color,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      maxWidth: 96,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {getCategoryLabel(categoryId)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {hoverPreview && (
        <ElementHoverPreview
          element={hoverPreview.element}
          categoryColor={hoverPreview.categoryColor}
          top={hoverPreview.top}
          left={hoverPreview.left}
        />
      )}

      {/* Hide the vertical scrollbar on the inner scroll container and the
          horizontal scrollbar on the category footer (scroll still works). */}
      <style>{`
        .left-panel-scroll { scrollbar-width: none; }
        .left-panel-scroll::-webkit-scrollbar { width: 0; height: 0; display: none; }
        .left-panel-cat-footer { scrollbar-width: none; }
        .left-panel-cat-footer::-webkit-scrollbar { width: 0; height: 0; display: none; }
      `}</style>
    </div>
  );
}

function ElementHoverPreview({
  element,
  categoryColor,
  top,
  left,
}: {
  element: BookElement;
  categoryColor: string;
  top: number;
  left: number;
}) {
  const summary = element.summary?.trim() ?? '';
  return (
    <div
      style={{
        position: 'fixed',
        top,
        left,
        width: 260,
        maxHeight: 200,
        background: 'hsl(var(--surface))',
        border: '1px solid hsl(var(--rule-strong))',
        boxShadow: '0 6px 18px hsl(var(--ink-1) / 0.15)',
        zIndex: 10000,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid hsl(var(--rule) / 0.6)',
          background: 'hsl(var(--paper))',
        }}
      >
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 11,
            color: categoryColor,
            lineHeight: 1,
          }}
        >
          ◆
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'hsl(var(--ink-1))',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {element.name || 'Untitled'}
        </span>
      </div>
      <div
        style={{
          padding: '8px 10px',
          fontSize: 11.5,
          lineHeight: 1.5,
          color: summary ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
          fontStyle: summary ? 'normal' : 'italic',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 8,
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
        }}
      >
        {summary || 'No summary'}
      </div>
    </div>
  );
}
