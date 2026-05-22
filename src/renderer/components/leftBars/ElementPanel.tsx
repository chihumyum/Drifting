import { useState, useMemo, useCallback, useEffect } from 'react';
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
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        <div
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
            <div key={categoryId} style={{ marginBottom: 8 }}>
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

    </div>
  );
}
