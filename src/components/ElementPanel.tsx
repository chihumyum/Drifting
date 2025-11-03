import { useState, useMemo, useCallback, useEffect } from 'react';
import { useAppStore } from '../store';
import { useBookElementUsecases } from '../hooks/useBookElementUsecases';
import { Plus, Trash2, Edit2 } from 'lucide-react';
import type { BookElement } from '../domain/book_element';


export function ElementPanel() {
  const { bookElements, bookElementCategories, selectedElementId: selectedBookElementId, setSelectedElementId: setSelectedBookElementId } = useAppStore();
  const { createElement: create, updateElement: update, removeElement: remove, loadInitial } = useBookElementUsecases();

  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');


  const categoryNames = useMemo(() => {
    const names = new Set<string>(['others']);
    bookElementCategories.forEach(c => names.add(c.name));
    bookElements.forEach(e => names.add(e.category));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [bookElementCategories, bookElements]);

  const filtered = useMemo(() => {
    if (filterCategory === 'all') return bookElements;
    return bookElements.filter(e => e.category === filterCategory);
  }, [bookElements, filterCategory]);

  const beginCreate = () => {
    setCreating(true);
    setFormName('');
    setFormCategory(categoryNames[0] || 'others');
  };

  const submitCreate = useCallback(async () => {
    if (!formName.trim() || !formCategory.trim()) return;
    console.log(`Submit create ${formName} in category ${formCategory}`);
    await create({ name: formName.trim(), category: formCategory.trim() });
    setCreating(false);
  }, [create, formName, formCategory]);

  const cancelCreate = () => {
    setCreating(false);
  };

  const startEdit = (el: BookElement) => {
    setEditingId(el.id);
    setEditingName(el.name);
  };

  const submitEdit = useCallback(async () => {
    if (!editingId) return;
    await update(editingId, { name: editingName });
    setEditingId(null);
  }, [editingId, editingName, update]);

  const deleteElement = useCallback(async (id: string) => {
    await remove(id);
    if (selectedBookElementId === id) setSelectedBookElementId(null);
  }, [remove, selectedBookElementId, setSelectedBookElementId]);

  useEffect(() => {
    console.log('Loading initial book elements');
    loadInitial().catch(err => {
      console.error('Failed to load book elements', err);
    });
  }, [loadInitial]);

  return (
    <div style={{ 
      height: '100%',
      display: 'flex', 
      flexDirection: 'column',
      padding: '20px',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: '20px',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
            style={{
              flex: 1,
              padding: '8px 12px',
              fontSize: 13,
              border: '1px solid rgba(180, 170, 200, 0.3)',
              borderRadius: 8,
              background: '#fff',
              color: '#3a2d4a',
              cursor: 'pointer',
            }}
          >
            <option value="all">All Categories</option>
            {categoryNames.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <button
            onClick={beginCreate}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(102, 126, 234, 0.3)',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 6px 16px rgba(102, 126, 234, 0.4)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.3)';
            }}
          >
            <Plus size={16} /> New
          </button>
        </div>
      </div>

      {/* Create Form */}
      {creating && (
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(200, 190, 220, 0.3)',
          background: 'rgba(255, 255, 255, 0.95)',
          backdropFilter: 'blur(8px)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder="Element name..."
              autoFocus
              style={{
                fontSize: 13,
                padding: '10px 12px',
                border: '2px solid rgba(102, 126, 234, 0.3)',
                borderRadius: 8,
                outline: 'none',
                background: '#fff',
              }}
            />
            <select
              value={formCategory}
              onChange={e => setFormCategory(e.target.value)}
              style={{
                fontSize: 13,
                padding: '10px 12px',
                border: '1px solid rgba(180, 170, 200, 0.3)',
                borderRadius: 8,
                background: '#fff',
                cursor: 'pointer',
              }}
            >
              {categoryNames.map(name => <option key={name}>{name}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={submitCreate}
                style={{
                  flex: 1,
                  background: '#667eea',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Create
              </button>
              <button
                onClick={cancelCreate}
                style={{
                  flex: 1,
                  background: 'rgba(150, 140, 180, 0.1)',
                  color: '#6a5d7a',
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Elements List */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}>
        {filtered.map(el => {
          const selected = el.id === selectedBookElementId;
          return (
            <div
              key={el.id}
              style={{
                border: selected ? '2px solid #667eea' : '1px solid rgba(200, 190, 220, 0.25)',
                background: selected ? 'rgba(102, 126, 234, 0.05)' : '#fff',
                padding: '14px 16px',
                borderRadius: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                boxShadow: selected ? '0 4px 16px rgba(102, 126, 234, 0.15)' : '0 2px 8px rgba(100, 90, 120, 0.08)',
                transition: 'all 0.2s ease',
                cursor: 'pointer',
              }}
              onClick={() => !editingId && setSelectedBookElementId(el.id)}
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
                {editingId === el.id ? (
                  <input
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      flex: 1,
                      fontSize: 14,
                      fontWeight: 600,
                      padding: '6px 8px',
                      border: '2px solid #667eea',
                      borderRadius: 6,
                      outline: 'none',
                    }}
                  />
                ) : (
                  <div style={{
                    flex: 1,
                    fontSize: 14,
                    fontWeight: 600,
                    color: selected ? '#667eea' : '#2d1f3a',
                  }}>
                    {el.name}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  {editingId === el.id ? (
                    <button
                      onClick={submitEdit}
                      style={{
                        background: '#667eea',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        padding: '4px 10px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Save
                    </button>
                  ) : (
                    <button
                      onClick={() => startEdit(el)}
                      style={{
                        background: 'rgba(102, 126, 234, 0.1)',
                        color: '#667eea',
                        border: 'none',
                        borderRadius: 6,
                        padding: '6px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      title="Edit"
                    >
                      <Edit2 size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => deleteElement(el.id)}
                    style={{
                      background: 'rgba(239, 68, 68, 0.1)',
                      color: '#ef4444',
                      border: 'none',
                      borderRadius: 6,
                      padding: '6px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div style={{
                fontSize: 11,
                color: '#8a7d9a',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span style={{
                  background: 'rgba(102, 126, 234, 0.1)',
                  color: '#667eea',
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontWeight: 600,
                }}>
                  {el.category}
                </span>
                <span>{new Date(el.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{
            fontSize: 13,
            color: '#9b8ea8',
            padding: '32px 20px',
            textAlign: 'center',
            background: 'rgba(255, 255, 255, 0.5)',
            borderRadius: 12,
            border: '1px dashed rgba(150, 140, 180, 0.3)',
          }}>
            No elements yet. Click "New" to create one.
          </div>
        )}
      </div>
    </div>
  );
}
