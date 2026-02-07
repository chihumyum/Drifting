import { useState, useMemo, useCallback, useEffect } from 'react';
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

export function ElementPanel() {
  const { bookElements, bookElementCategories } = useDataStore();
  const {
    elementUi,
    setElementSelection,
    timelineHeight,
  } = useUiStore();
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, navigateToCategory } = useProjectNavigation();
  const selectedBookElementId = elementUi.selectedId;

  const activeProjectId = useMemo(() => {
    if (!projectId) {
      throw new Error('ElementPanel requires a non-empty projectId');
    }
    return projectId;
  }, [projectId]);

  const {
    createElement,
    removeElement,
    loadInitial,
    updateElement,
  } = useBookElement({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const {
    createCategory,
    updateCategory,
    loadCategories,
    getCategoryColor,
  } = useElementCategory({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [editingElementName, setEditingElementName] = useState('');
  const [editingCategoryName, setEditingCategoryName] = useState<string | null>(null);
  const [editingCategoryNewName, setEditingCategoryNewName] = useState('');

  const panelHeight = useMemo(
    () => `calc(100vh - 120px - ${timelineHeight}px)`,
    [timelineHeight],
  );

  const categoryById = useMemo(() => (
    new Map(bookElementCategories.map(category => [category.id, category]))
  ), [bookElementCategories]);

  const getCategoryLabel = useCallback((categoryId: string) => {
    return categoryById.get(categoryId)?.name ?? categoryId;
  }, [categoryById]);

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

  const filteredElements = useMemo(() => {
    if (filterCategory === 'all') {
      return bookElements;
    }
    return bookElements.filter((element) => element.categoryId === filterCategory);
  }, [bookElements, filterCategory]);

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

  useEffect(() => {
    loadInitial().catch((error) => {
      log.error('Failed to load book elements', error);
    });
    loadCategories().catch((error) => {
      log.error('Failed to load categories', error);
    });
  }, [loadInitial, loadCategories]);

  const handleDeleteElement = useCallback(async (id: string) => {
    try {
      await removeElement(id);
      if (selectedBookElementId === id) {
        setElementSelection(null, 'ui');
      }
    } catch (error) {
      log.error('Failed to delete element', error);
    }
  }, [removeElement, selectedBookElementId, setElementSelection]);

  const handleCreateElement = useCallback(async (categoryId: string) => {
    try {
      const created = await createElement({ categoryId });
      setElementSelection(created.id, 'ui');
    } catch (error) {
      log.error('Failed to create element', error);
    }
  }, [createElement, setElementSelection]);

  const handleCreateCategory = useCallback(async () => {
    try {
      const created = await createCategory();
      await loadCategories();

      setFilterCategory(created.id);
      setEditingCategoryName(created.id);
      setEditingCategoryNewName(created.name);
    } catch (error) {
      log.error('Failed to create new category', error);
    }
  }, [createCategory, loadCategories]);

  const handleSaveElementName = useCallback(async (elementId: string) => {
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
  }, [editingElementName, updateElement]);

  const handleSaveCategoryName = useCallback(async (categoryId: string) => {
    const newName = editingCategoryNewName.trim();
    const existingCategory = categoryById.get(categoryId);
    if (!newName || newName === existingCategory?.name) {
      setEditingCategoryName(null);
      setEditingCategoryNewName('');
      return;
    }
    if (!existingCategory) {
      setEditingCategoryName(null);
      setEditingCategoryNewName('');
      return;
    }

    try {
      await updateCategory(categoryId, { name: newName });
      await loadCategories();
    } catch (error) {
      log.error('Failed to rename category', error);
      alert('Failed to rename category. Please try again.');
    } finally {
      setEditingCategoryName(null);
      setEditingCategoryNewName('');
    }
  }, [
    categoryById,
    editingCategoryNewName,
    loadCategories,
    updateCategory,
  ]);

  const renderElementCard = (element: BookElement) => {
    const selected = element.id === selectedBookElementId;

    return (
      <div
        key={element.id}
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
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

  const hasElements = filterCategory === 'all' ? bookElements.length > 0 : filteredElements.length > 0;

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
        {filterCategory !== 'all' && (
          <div
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              marginBottom: 16,
              borderRadius: 12,
              background: 'linear-gradient(135deg, rgba(102, 126, 234, 0.08) 0%, rgba(118, 75, 162, 0.08) 100%)',
              border: '1px solid rgba(102, 126, 234, 0.15)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  background: getCategoryColor(filterCategory),
                }}
              />
              {editingCategoryName === filterCategory ? (
                <input
                  type="text"
                  value={editingCategoryNewName}
                  onChange={(event) => setEditingCategoryNewName(event.target.value)}
                  onBlur={() => {
                    void handleSaveCategoryName(filterCategory);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void handleSaveCategoryName(filterCategory);
                    }
                    if (event.key === 'Escape') {
                      setEditingCategoryName(null);
                      setEditingCategoryNewName('');
                    }
                  }}
                  onFocus={(event) => event.target.select()}
                  autoFocus
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: 'rgba(0, 0, 0, 0.75)',
                    border: '1px solid var(--accent-border, #e8dcc8)',
                    borderRadius: 4,
                    padding: '2px 6px',
                    background: 'var(--bg-paper)',
                    outline: 'none',
                  }}
                />
              ) : (
                <span
                  onDoubleClick={() => {
                    setEditingCategoryName(filterCategory);
                    setEditingCategoryNewName(getCategoryLabel(filterCategory));
                  }}
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: 'rgba(0, 0, 0, 0.75)',
                    cursor: 'text',
                  }}
                >
                  {getCategoryLabel(filterCategory)}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => navigateToCategory(encodeURIComponent(filterCategory))}
                className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--accent-border, #e8dcc8)',
                  color: '#5a4a3a',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Edit3 size={14} />
                Edit Category
              </button>

              <button
                onClick={() => {
                  void handleCreateElement(filterCategory);
                }}
                className="bg-accent hover:bg-accent-hover text-paper transition-colors"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  borderRadius: 8,
                  border: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Plus size={14} />
                New Element
              </button>
            </div>
          </div>
        )}

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {filterCategory === 'all' ? (
            categoryIds.map((categoryId) => (
              <div key={categoryId} style={{ marginBottom: 16 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'rgba(0, 0, 0, 0.5)',
                    marginBottom: 8,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    paddingRight: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{getCategoryLabel(categoryId)}</span>
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

                {(elementsByCategory[categoryId] ?? []).map(renderElementCard)}
              </div>
            ))
          ) : (
            filteredElements.map(renderElementCard)
          )}

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
          right: -48,
          top: 0,
          height: panelHeight,
          width: 48,
          display: 'flex',
          flexDirection: 'column',
          padding: '12px 0',
          gap: 4,
          background: 'transparent',
          zIndex: 10,
        }}
      >
        <div
          onClick={() => setFilterCategory('all')}
          style={{
            height: 40,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
            color: filterCategory === 'all' ? '#fefdfb' : '#5a4a3a',
            background: filterCategory === 'all'
              ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
              : '#f5f0e8',
            borderRadius: '0 6px 6px 0',
            border: '1px solid var(--accent-border, #e8dcc8)',
            borderRight: 'none',
          }}
        >
          All
        </div>

        <div
          onClick={() => {
            void handleCreateCategory();
          }}
          style={{
            height: 40,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            border: '1px dashed var(--accent-border, #e8dcc8)',
            borderRadius: '0 6px 6px 0',
            borderRight: 'none',
            color: '#8b7355',
            background: '#f5f0e8',
          }}
        >
          <Plus size={16} />
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            marginTop: 4,
            scrollbarWidth: 'none',
          }}
          className="category-tabs-scroll"
        >
          {categoryIds.map((categoryId) => {
            const isActive = filterCategory === categoryId;
            const color = getCategoryColor(categoryId);

            return (
              <div
                key={categoryId}
                onClick={() => setFilterCategory(categoryId)}
                title={getCategoryLabel(categoryId)}
                style={{
                  minHeight: 60,
                  flexShrink: 0,
                  position: 'relative',
                  cursor: 'pointer',
                  borderRadius: '0 6px 6px 0',
                  background: isActive ? color : `${color}80`,
                  boxShadow: isActive ? `0 3px 12px ${color}60` : '0 2px 4px rgba(0, 0, 0, 0.1)',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  borderTop: `1px solid ${color}40`,
                  borderBottom: `1px solid ${color}40`,
                  borderLeft: `1px solid ${color}40`,
                  borderRight: 'none',
                }}
              >
                <div
                  style={{
                    writingMode: 'vertical-rl',
                    textOrientation: 'mixed',
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#fff',
                    textShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxHeight: 60,
                  }}
                >
                  {getCategoryLabel(categoryId)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
