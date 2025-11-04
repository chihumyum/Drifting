import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store';
import { useBookElementUsecases } from '../hooks/useBookElementUsecases';
import { Plus, Trash2, MoreVertical, Edit3 } from 'lucide-react';
import type { BookElement } from '../domain/book_element';

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
  const { bookElements, bookElementCategories, selectedElementId: selectedBookElementId, setSelectedElementId: setSelectedBookElementId } = useAppStore();
  const { createElement: create, removeElement: remove, loadInitial, _deps } = useBookElementUsecases();

  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showNewCategoryModal, setShowNewCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');


  const categoryNames = useMemo(() => {
    const names = new Set<string>(['others']);
    bookElementCategories.forEach(c => names.add(c.name));
    bookElements.forEach(e => names.add(e.category));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
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
    return bookElements.filter(e => e.category === filterCategory);
  }, [bookElements, filterCategory]);

  const deleteElement = useCallback(async (id: string) => {
    await remove(id);
    if (selectedBookElementId === id) setSelectedBookElementId(null);
  }, [remove, selectedBookElementId, setSelectedBookElementId]);

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return;
    await _deps.categoryRepo.create(newCategoryName.trim());
    await loadInitial();
    setShowNewCategoryModal(false);
    setNewCategoryName('');
  };

  // Group elements by category for "all" view
  const elementsByCategory = useMemo(() => {
    const grouped: Record<string, BookElement[]> = {};
    bookElements.forEach(el => {
      const cat = el.category || 'others';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(el);
    });
    return grouped;
  }, [bookElements]);

  useEffect(() => {
    console.log('Loading initial book elements');
    loadInitial().catch(err => {
      console.error('Failed to load book elements', err);
    });
  }, [loadInitial]);

  return (
    <div style={{ 
      height: '100%',
      position: 'relative',
    }}>
      {/* Left: Elements List - This container handles scrolling */}
      <div style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px',
        overflow: 'hidden',
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
              <span style={{
                fontSize: 16,
                fontWeight: 700,
                color: 'rgba(0, 0, 0, 0.75)',
              }}>
                {filterCategory}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => navigate(`/category/${encodeURIComponent(filterCategory)}`)}
                className="bg-button"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  borderRadius: 8,
                  border: 'none',
                  color: 'rgba(0, 0, 0, 0.75)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'opacity 0.2s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.opacity = '0.8';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.opacity = '1';
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
                      category: filterCategory,
                      tags: [],
                      summary_json: '',
                      content_json: JSON.stringify({
                        type: 'doc',
                        content: [{ type: 'paragraph' }],
                      }),
                    });
                    navigate(`/element/${newElement.id}`);
                  } catch (error) {
                    console.error('Failed to create element:', error);
                  }
                }}
                className="bg-button"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  borderRadius: 8,
                  border: 'none',
                  color: 'rgba(0, 0, 0, 0.75)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'opacity 0.2s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.opacity = '0.8';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.opacity = '1';
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
          minHeight: 0, // Critical: allows scrolling in flex layout
          overflowY: 'auto',
          overflowX: 'hidden',
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
                      className="bg-button"
                      style={{
                        padding: '4px 12px',
                        borderRadius: 6,
                        border: 'none',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'rgba(0, 0, 0, 0.75)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        transition: 'opacity 0.2s ease',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.opacity = '0.8';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.opacity = '1';
                      }}
                    >
                      <Edit3 size={11} />
                      Edit
                    </button>
                    <button
                      onClick={async () => {
                        const newElement = await create({
                          name: 'New Element',
                          category: category,
                          tags: [],
                          summary_json: '',
                          content_json: JSON.stringify({
                            type: 'doc',
                            content: [{ type: 'paragraph' }],
                          }),
                        });
                        navigate(`/element/${newElement.id}`);
                      }}
                      className="bg-button"
                      style={{
                        padding: '4px 12px',
                        borderRadius: 6,
                        border: 'none',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'rgba(0, 0, 0, 0.75)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      transition: 'opacity 0.2s ease',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.opacity = '0.8';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.opacity = '1';
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
                      className="bg-card"
                      style={{
                        border: selected ? '2px solid rgba(255, 214, 189, 1)' : '1px solid rgba(200, 190, 220, 0.25)',
                        padding: '14px 16px',
                        borderRadius: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        marginBottom: 8,
                        boxShadow: selected ? '0 4px 16px rgba(102, 126, 234, 0.15)' : '0 2px 8px rgba(100, 90, 120, 0.08)',
                        transition: 'all 0.2s ease',
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        setSelectedBookElementId(el.id);
                        navigate(`/element/${el.id}`);
                      }}
                      onMouseEnter={(e) => {
                        if (!selected) {
                          e.currentTarget.style.boxShadow = '0 4px 12px rgba(100, 90, 120, 0.12)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!selected) {
                          e.currentTarget.style.boxShadow = '0 2px 8px rgba(100, 90, 120, 0.08)';
                        }
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{
                          flex: 1,
                          fontSize: 14,
                          fontWeight: 600,
                          color: 'rgba(71, 71, 71, 1)',
                        }}>
                          {el.name}
                        </div>
                        <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => setOpenMenuId(openMenuId === el.id ? null : el.id)}
                            className="bg-button"
                            style={{
                              color: 'rgba(0, 0, 0, 0.75)',
                              border: 'none',
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
                                  background: 'white',
                                  border: '1px solid rgba(0, 0, 0, 0.1)',
                                  borderRadius: 8,
                                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
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
                        color: '#8a7d9a',
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
                  className="bg-card"
                  style={{
                    border: selected ? '2px solid rgba(255, 214, 189, 1)' : '1px solid rgba(200, 190, 220, 0.25)',
                    padding: '14px 16px',
                    borderRadius: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    boxShadow: selected ? '0 4px 16px rgba(102, 126, 234, 0.15)' : '0 2px 8px rgba(100, 90, 120, 0.08)',
                    transition: 'all 0.2s ease',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setSelectedBookElementId(el.id);
                    navigate(`/element/${el.id}`);
                  }}
                  onMouseEnter={(e) => {
                    if (!selected) {
                      e.currentTarget.style.boxShadow = '0 4px 12px rgba(100, 90, 120, 0.12)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!selected) {
                      e.currentTarget.style.boxShadow = '0 2px 8px rgba(100, 90, 120, 0.08)';
                    }
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{
                      flex: 1,
                      fontSize: 14,
                      fontWeight: 600,
                      color: 'rgba(71, 71, 71, 1)',
                    }}>
                      {el.name}
                    </div>
                    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setOpenMenuId(openMenuId === el.id ? null : el.id)}
                        className="bg-button"
                        style={{
                          color: 'rgba(0, 0, 0, 0.75)',
                          border: 'none',
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
                              background: 'white',
                              border: '1px solid rgba(0, 0, 0, 0.1)',
                              borderRadius: 8,
                              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
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
                    color: '#8a7d9a',
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
              color: '#9b8ea8',
              padding: '32px 20px',
              textAlign: 'center',
              background: 'rgba(255, 255, 255, 0.5)',
              borderRadius: 12,
              border: '1px dashed rgba(150, 140, 180, 0.3)',
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
        height: 'calc(100vh - 240px)', // Adjusted to fit within viewport minus other UI elements
        width: 48,
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 0',
        gap: 4,
        background: 'transparent', // No background since it's outside
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
            color: filterCategory === 'all' ? '#fff' : 'rgba(0, 0, 0, 0.6)',
            background: filterCategory === 'all' 
              ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
              : 'rgba(240, 240, 245, 0.95)',
            borderRadius: '8px 0 0 8px', // Rounded on left side only
            marginRight: 0,
            transition: 'all 0.2s ease',
            boxShadow: filterCategory === 'all' 
              ? '0 2px 8px rgba(102, 126, 234, 0.3)' 
              : '0 2px 4px rgba(0, 0, 0, 0.1)',
            border: '1px solid rgba(200, 190, 220, 0.25)',
            borderRight: 'none',
          }}
          onMouseEnter={e => {
            if (filterCategory !== 'all') {
              e.currentTarget.style.background = 'rgba(0, 0, 0, 0.08)';
            }
          }}
          onMouseLeave={e => {
            if (filterCategory !== 'all') {
              e.currentTarget.style.background = 'rgba(240, 240, 245, 0.95)';
            }
          }}
        >
          All
        </div>

        {/* Add New Category Tab - Fixed below "All" */}
        <div
          onClick={() => setShowNewCategoryModal(true)}
          style={{
            height: 40,
            flexShrink: 0, // Don't shrink
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            border: '2px dashed rgba(0, 0, 0, 0.2)',
            borderRadius: '8px 0 0 8px', // Rounded on left side only
            borderRight: 'none',
            color: 'rgba(0, 0, 0, 0.5)',
            background: 'rgba(240, 240, 245, 0.95)',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'rgba(102, 126, 234, 0.6)';
            e.currentTarget.style.color = 'rgba(102, 126, 234, 0.8)';
            e.currentTarget.style.background = 'rgba(102, 126, 234, 0.1)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.2)';
            e.currentTarget.style.color = 'rgba(0, 0, 0, 0.5)';
            e.currentTarget.style.background = 'rgba(240, 240, 245, 0.95)';
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
                minHeight: 56,
                flexShrink: 0,
                position: 'relative',
                cursor: 'pointer',
                borderRadius: '6px 0 0 6px', // Rounded on left side only
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
                maxHeight: 48,
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
            background: 'white',
            borderRadius: 12,
            padding: 24,
            minWidth: 320,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
          }}
          onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px 0', fontSize: 18, fontWeight: 600 }}>
              New Category
            </h3>
            <input
              type="text"
              value={newCategoryName}
              onChange={e => setNewCategoryName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreateCategory();
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
                border: '1px solid rgba(0, 0, 0, 0.2)',
                borderRadius: 6,
                padding: '8px 12px',
                outline: 'none',
                marginBottom: 16,
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowNewCategoryModal(false);
                  setNewCategoryName('');
                }}
                style={{
                  padding: '6px 16px',
                  borderRadius: 6,
                  border: '1px solid rgba(0, 0, 0, 0.2)',
                  background: 'white',
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateCategory}
                className="bg-button"
                style={{
                  padding: '6px 16px',
                  borderRadius: 6,
                  border: 'none',
                  color: 'rgba(0, 0, 0, 0.75)',
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
