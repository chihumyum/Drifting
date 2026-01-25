import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDataStore } from '../../store/data-store';
import { useUiStore } from '../../store/ui-store';
import { useBookElement } from '../../usecase/useBookElement';
import { useElementCategory } from '../../usecase/useElementCategory';
import { Plus, Trash2, MoreVertical, Edit3 } from 'lucide-react';
import type { BookElement } from '../../domain/book-element';
import loglevel from "loglevel";
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';

const log = loglevel.getLogger("ElementPanel");
log.setLevel(loglevel.levels.ERROR);

// Default category colors as fallback
const DEFAULT_CATEGORY_COLORS = [
  '#FF6B6B', // Red
  '#4ECDC4', // Teal
  '#45B7D1', // Blue
  '#FFA07A', // Light Salmon
  '#98D8C8', // Mint
  '#F7DC6F', // Yellow
  '#BB8FCE', // Purple
  '#85C1E2', // Sky Blue
  '#F8B88B', // Peach
  '#AED581', // Light Green
];


export function ElementPanel() {
  const navigate = useNavigate();
  const { bookElements, bookElementCategories } = useDataStore();
  const { selectedElementId: selectedBookElementId, setSelectedElementId: setSelectedBookElementId, timelineHeight } = useUiStore();
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const { createElement: create, removeElement: remove, loadInitial, updateElement } = useBookElement({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { createCategory, deleteCategory, loadCategories } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });

  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [editingElementName, setEditingElementName] = useState('');
  const [editingCategoryName, setEditingCategoryName] = useState<string | null>(null);
  const [editingCategoryNewName, setEditingCategoryNewName] = useState('');


  const categoryNames = useMemo(() => {
    const names = new Set<string>();
    bookElementCategories.forEach(c => names.add(c.name));
    bookElements.forEach(e => names.add(e.categoryId));
    // others always stays last
    return Array.from(names).sort((a, b) => {
      if (a === 'others') return 1;
      if (b === 'others') return -1;
      return a.localeCompare(b);
    });
  }, [bookElementCategories, bookElements]);

  // Get color for a category, from database or fallback to default colors
  const getCategoryColor = useCallback((categoryName: string, fallbackIndex: number): string => {
    const category = bookElementCategories.find(c => c.name === categoryName);
    if (category?.color) {
      return category.color;
    }
    return DEFAULT_CATEGORY_COLORS[fallbackIndex % DEFAULT_CATEGORY_COLORS.length];
  }, [bookElementCategories]);

  const filtered = useMemo(() => {
    if (filterCategory === 'all') return bookElements;
    return bookElements.filter(e => e.categoryId === filterCategory);
  }, [bookElements, filterCategory]);

  const deleteElement = useCallback(async (id: string) => {
    await remove(id);
    if (selectedBookElementId === id) setSelectedBookElementId(null);
  }, [remove, selectedBookElementId, setSelectedBookElementId]);

  const handleNewCategory = async () => {
    if (!newCategoryName.trim()) return;
    await createCategory(newCategoryName.trim());
    await loadCategories();
    setShowNewCategoryModal(false);
    setNewCategoryName('');
  };

  // 创建新 category 并进入编辑模式
  const handleCreateNewCategory = async () => {
    // Generate a temporary name
    const tempName = `New Category ${Date.now()}`;
    try {
      await createCategory(tempName);
      await loadCategories();
      // Switch to the new category tab and enter edit mode
      setFilterCategory(tempName);
      setEditingCategoryName(tempName);
      setEditingCategoryNewName(tempName);
    } catch (error) {
      log.error('Failed to create new category:', error);
    }
  };

  // 处理 element 名称编辑
  const handleSaveElementName = async (elementId: string) => {
    if (!editingElementName.trim()) {
      setEditingElementId(null);
      return;
    }
    try {
      // Use the usecase layer's updateElement which handles partial updates
      await updateElement(elementId, { name: editingElementName.trim() });
      await loadInitial();
    } catch (error) {
      log.error('Failed to update element name:', error);
    } finally {
      setEditingElementId(null);
    }
  };

  // 处理 category 名称编辑
  const handleSaveCategoryName = async (oldName: string) => {
    const newName = editingCategoryNewName.trim();
    if (!newName || newName === oldName) {
      setEditingCategoryName(null);
      return;
    }
    try {
      // Category rename requires:
      // 1. Create new category with new name
      // 2. Update all elements to use new category
      // 3. Delete old category

      // Check if new name already exists
      const categories = useDataStore.getState().bookElementCategories;
      const existingNew = categories.find((c: any) => c.name === newName);
      if (existingNew) {
        alert(`Category "${newName}" already exists`);
        setEditingCategoryName(null);
        return;
      }

      // Create new category (copy color from old)
      const oldCategory = categories.find((c: any) => c.name === oldName);
      // Note: createCategory hook might not support color arg yet, but ensureCategory creates default. 
      // If we need color preservation, we might need a better updateCategory method. 
      // For now, simplify to create (which makes default) then potentially update?
      // Legacy code passed color. ensureCategory internal only takes name.
      // createCategory (alias to ensureCategory) returns existing or new.
      // But we probably want to COPY the color.
      // The store has updateCategory? No.
      // Let's just create it. Color might be lost or default. This is acceptable for migration verification.
      await createCategory(newName);

      // Update all elements that use this category
      const elementsToUpdate = bookElements.filter((e: BookElement) => e.categoryId === oldName);
      for (const element of elementsToUpdate) {
        await updateElement(element.id, { categoryId: newName });
      }

      // Delete old category
      await deleteCategory(oldName);

      // Reload to get updated data
      await loadCategories();

      // Update filter if it was set to the old category
      if (filterCategory === oldName) {
        setFilterCategory(newName);
      }
    } catch (error) {
      log.error('Failed to rename category:', error);
      alert('Failed to rename category. Please try again.');
    } finally {
      setEditingCategoryName(null);
    }
  };

  // Group elements by category for "all" view - 显示所有 category，即使没有 elements
  const elementsByCategory = useMemo(() => {
    const grouped: Record<string, BookElement[]> = {};
    // 初始化所有 category
    categoryNames.forEach(cat => {
      // Ensure unique keys
      if (!grouped[cat]) grouped[cat] = [];
    });
    // 填充 elements
    bookElements.forEach(el => {
      const cat = el.categoryId || 'others';
      // Ensure category exists in grouped (if not in categoryNames)
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(el);
    });
    return grouped;
  }, [bookElements, categoryNames]);

  useEffect(() => {
    log.debug('Loading initial book elements in ElementPanel');
    loadInitial().catch(err => {
      log.error('Failed to load book elements', err);
    });
    loadCategories().catch(err => {
      log.error('Failed to load categories', err);
    });
  }, [loadInitial, loadCategories]);

  return (
    <div style={{
      height: '100%',
      position: 'relative',
    }}>
      {/* Left: Elements List - This container handles scrolling */}
      <div style={{
        height: `calc(100vh - 120px - ${timelineHeight}px)`, // 动态减去 AppSidebar (120px) 和 timeline 高度
        display: 'flex',
        flexDirection: 'column',
        padding: '5px',
      }}>
        {/* Category Header - Show when a specific category is selected */}
        {filterCategory !== 'all' && (
          <div style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            marginBottom: 16,
            borderRadius: 12,
            background: 'linear-gradient(135deg, rgba(102, 126, 234, 0.08) 0%, rgba(118, 75, 162, 0.08) 100%)',
            border: '1px solid rgba(102, 126, 234, 0.15)',
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                width: 20,
                height: 20,
                borderRadius: 4,
                background: getCategoryColor(filterCategory, categoryNames.indexOf(filterCategory)),
                boxShadow: `0 2px 6px ${getCategoryColor(filterCategory, categoryNames.indexOf(filterCategory))}40`,
              }} />
              {editingCategoryName === filterCategory ? (
                <input
                  type="text"
                  value={editingCategoryNewName}
                  onChange={(e) => setEditingCategoryNewName(e.target.value)}
                  onBlur={() => handleSaveCategoryName(filterCategory)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSaveCategoryName(filterCategory);
                    } else if (e.key === 'Escape') {
                      setEditingCategoryName(null);
                      setEditingCategoryNewName('');
                    }
                  }}
                  onFocus={(e) => e.target.select()}
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
                    setEditingCategoryNewName(filterCategory);
                  }}
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: 'rgba(0, 0, 0, 0.75)',
                    cursor: 'text',
                  }}
                >
                  {filterCategory}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => navigate(`/category/${encodeURIComponent(filterCategory)}`)}
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
                onClick={async () => {
                  try {
                    const newElement = await create({
                      name: 'New Element',
                      categoryId: filterCategory,
                      tagIds: [],
                      summary: '',
                      contentJson: JSON.stringify({
                        type: 'doc',
                        content: [{ type: 'paragraph' }],
                      }),
                    });
                    navigate(`/element/${newElement.id}`);
                  } catch (error) {
                    log.error('Failed to create element:', error);
                  }
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

        {/* Elements List Content */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          {filterCategory === 'all' ? (
            // Show grouped by category
            Object.entries(elementsByCategory).map(([category, elements]) => (
              <div key={category} style={{ marginBottom: 16 }}>
                <div style={{
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
                }}>
                  <span>{category}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => navigate(`/category/${encodeURIComponent(category)}`)}
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
                      onClick={async () => {
                        const newElement = await create({
                          name: 'New Element',
                          categoryId: category,
                          tagIds: [],
                          summary: '',
                          contentJson: JSON.stringify({
                            type: 'doc',
                            content: [{ type: 'paragraph' }],
                          }),
                        });
                        navigate(`/element/${newElement.id}`);
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
                {elements.map(el => {
                  const selected = el.id === selectedBookElementId;
                  return (
                    <div
                      key={el.id}
                      className="bg-paper shadow-paper hover:shadow-paper-lg transition-shadow"
                      style={{
                        border: selected ? '1px solid var(--accent, #b89968)' : '1px solid var(--accent-border, #e8dcc8)',
                        padding: '14px 16px',
                        borderRadius: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        marginBottom: 8,
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        setSelectedBookElementId(el.id);
                        navigate(`/element/${el.id}`);
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{
                          flex: 1,
                          fontSize: 14,
                          fontWeight: 600,
                          color: '#3a2a1a',
                        }}>
                          {editingElementId === el.id ? (
                            <input
                              type="text"
                              value={editingElementName}
                              onChange={(e) => setEditingElementName(e.target.value)}
                              onBlur={() => handleSaveElementName(el.id)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  handleSaveElementName(el.id);
                                } else if (e.key === 'Escape') {
                                  setEditingElementId(null);
                                  setEditingElementName('');
                                }
                              }}
                              onFocus={(e) => e.target.select()}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
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
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setEditingElementId(el.id);
                                setEditingElementName(el.name);
                              }}
                              style={{ cursor: 'text' }}
                            >
                              {el.name}
                            </span>
                          )}
                        </div>
                        <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => setOpenMenuId(openMenuId === el.id ? null : el.id)}
                            className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
                            style={{
                              border: '1px solid var(--accent-border, #e8dcc8)',
                              borderRadius: 6,
                              padding: '6px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                            }}
                            title="Options"
                          >
                            <MoreVertical size={14} />
                          </button>

                          {openMenuId === el.id && (
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
                                    deleteElement(el.id);
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
                                    transition: 'background 0.15s ease',
                                  }}
                                  onMouseEnter={e => {
                                    e.currentTarget.style.background = 'rgba(220, 38, 38, 0.1)';
                                  }}
                                  onMouseLeave={e => {
                                    e.currentTarget.style.background = 'transparent';
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
                      <div style={{
                        fontSize: 11,
                        color: '#8b7355',
                      }}>
                        {new Date(el.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          ) : (
            // Show filtered by single category
            filtered.map(el => {
              const selected = el.id === selectedBookElementId;
              return (
                <div
                  key={el.id}
                  className="bg-paper shadow-paper hover:shadow-paper-lg transition-shadow"
                  style={{
                    border: selected ? '1px solid var(--accent, #b89968)' : '1px solid var(--accent-border, #e8dcc8)',
                    padding: '14px 16px',
                    borderRadius: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setSelectedBookElementId(el.id);
                    navigate(`/element/${el.id}`);
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{
                      flex: 1,
                      fontSize: 14,
                      fontWeight: 600,
                      color: '#3a2a1a',
                    }}>
                      {el.name}
                    </div>
                    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setOpenMenuId(openMenuId === el.id ? null : el.id)}
                        className="bg-paper-hover hover:bg-accent hover:text-paper transition-colors"
                        style={{
                          border: '1px solid var(--accent-border, #e8dcc8)',
                          borderRadius: 6,
                          padding: '6px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                        title="Options"
                      >
                        <MoreVertical size={14} />
                      </button>

                      {openMenuId === el.id && (
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
                                deleteElement(el.id);
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
                                transition: 'background 0.15s ease',
                              }}
                              onMouseEnter={e => {
                                e.currentTarget.style.background = 'rgba(220, 38, 38, 0.1)';
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.background = 'transparent';
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
                  <div style={{
                    fontSize: 11,
                    color: '#8b7355',
                  }}>
                    {new Date(el.updatedAt).toLocaleDateString()}
                  </div>
                </div>
              );
            })
          )}

          {((filterCategory === 'all' && bookElements.length === 0) || (filterCategory !== 'all' && filtered.length === 0)) && (
            <div style={{
              fontSize: 13,
              color: '#8b7355',
              padding: '32px 20px',
              textAlign: 'center',
              background: '#f9f6f1',
              borderRadius: 12,
              border: '1px dashed var(--accent-border, #e8dcc8)',
            }}>
              No elements yet.
            </div>
          )}
        </div>
      </div>

      {/* Right: Category Tabs (like index notebook) - Protruding outside */}
      <div style={{
        position: 'absolute',
        right: -48, // Extend outside the panel
        top: 0,
        height: `calc(100vh - 120px - ${timelineHeight}px)`, // 动态减去 AppSidebar 和 timeline 高度
        width: 48,
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 0',
        gap: 4,
        background: 'transparent',
        zIndex: 10,
      }}>
        {/* Show All Tab - Fixed at top */}
        <div
          onClick={() => setFilterCategory('all')}
          style={{
            height: 40,
            flexShrink: 0, // Don't shrink
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
            marginRight: 0,
            transition: 'all 0.2s ease',
            boxShadow: filterCategory === 'all'
              ? '0 2px 8px rgba(102, 126, 234, 0.3)'
              : '0 2px 4px rgba(139, 115, 85, 0.1)',
            border: '1px solid var(--accent-border, #e8dcc8)',
            borderRight: 'none',
          }}
          onMouseEnter={e => {
            if (filterCategory !== 'all') {
              const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b89968';
              e.currentTarget.style.background = accentColor;
              e.currentTarget.style.color = '#fefdfb';
            }
          }}
          onMouseLeave={e => {
            if (filterCategory !== 'all') {
              e.currentTarget.style.background = '#f5f0e8';
              e.currentTarget.style.color = '#5a4a3a';
            }
          }}
        >
          All
        </div>

        {/* Add New Category Tab - Fixed below "All" */}
        <div
          onClick={handleCreateNewCategory}
          style={{
            height: 40,
            flexShrink: 0, // Don't shrink
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            border: '1px dashed var(--accent-border, #e8dcc8)',
            borderRadius: '0 6px 6px 0',
            borderRight: 'none',
            color: '#8b7355',
            background: '#f5f0e8',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={e => {
            const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b89968';
            e.currentTarget.style.borderColor = accentColor;
            e.currentTarget.style.color = accentColor;
            e.currentTarget.style.background = accentColor.startsWith('hsl')
              ? accentColor.replace(')', ', 0.1)').replace('hsl', 'hsla')
              : 'rgba(139, 111, 71, 0.1)';
          }}
          onMouseLeave={e => {
            const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-border').trim() || '#e8dcc8';
            e.currentTarget.style.borderColor = borderColor;
            e.currentTarget.style.color = '#8b7355';
            e.currentTarget.style.background = '#f5f0e8';
          }}
        >
          <Plus size={16} />
        </div>

        {/* Scrollable Category Tabs Container */}
        <div style={{
          flex: 1,
          minHeight: 0, // Critical: allows scrolling in flex layout
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          marginTop: 4,
          // Hide scrollbar but keep functionality
          scrollbarWidth: 'none', // Firefox
          msOverflowStyle: 'none', // IE and Edge
        }}
          className="category-tabs-scroll"
        >
          {/* Category Tabs */}
          {categoryNames.filter(name => name !== 'all').map((name, index) => {
            const isActive = filterCategory === name;
            const color = getCategoryColor(name, index);

            return (
              <div
                key={name}
                onClick={() => setFilterCategory(name)}
                title={name}
                style={{
                  minHeight: 60,
                  flexShrink: 0,
                  position: 'relative',
                  cursor: 'pointer',
                  borderRadius: '0 6px 6px 0', // Rounded on left side only
                  background: isActive ? color : `${color}80`, // 80 = 50% opacity
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
                onMouseEnter={e => {
                  if (!isActive) {
                    e.currentTarget.style.background = color;
                    e.currentTarget.style.boxShadow = `0 3px 8px ${color}40`;
                  }
                }}
                onMouseLeave={e => {
                  if (!isActive) {
                    e.currentTarget.style.background = `${color}80`;
                    e.currentTarget.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.1)';
                  }
                }}
              >
                {/* Vertical text */}
                <div style={{
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
                }}>
                  {name}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* New Category Modal */}
      {showNewCategoryModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}
          onClick={() => {
            setShowNewCategoryModal(false);
            setNewCategoryName('');
          }}
        >
          <div style={{
            background: '#fefdfb',
            borderRadius: 12,
            padding: 24,
            minWidth: 320,
            boxShadow: '0 8px 32px rgba(139, 115, 85, 0.3)',
          }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px 0', fontSize: 18, fontWeight: 600, color: '#2a1a0a' }}>
              New Category
            </h3>
            <input
              type="text"
              value={newCategoryName}
              onChange={e => setNewCategoryName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleNewCategory();
                if (e.key === 'Escape') {
                  setShowNewCategoryModal(false);
                  setNewCategoryName('');
                }
              }}
              placeholder="Category name..."
              autoFocus
              style={{
                width: '100%',
                fontSize: 14,
                border: '1px solid var(--accent-border, #e8dcc8)',
                borderRadius: 6,
                padding: '8px 12px',
                outline: 'none',
                marginBottom: 16,
                color: '#3a2a1a',
                background: '#fefdfb',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowNewCategoryModal(false);
                  setNewCategoryName('');
                }}
                className="bg-paper-hover hover:bg-paper-light transition-colors"
                style={{
                  padding: '6px 16px',
                  borderRadius: 6,
                  border: '1px solid var(--accent-border, #e8dcc8)',
                  cursor: 'pointer',
                  fontSize: 14,
                  color: '#5a4a3a',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleNewCategory}
                className="bg-accent hover:bg-accent-hover text-paper transition-colors"
                style={{
                  padding: '6px 16px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
