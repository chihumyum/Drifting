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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#faf9fa', borderRight: '1px solid #e2dfea' }}>
      <div style={{ padding: 12, borderBottom: '1px solid #e4e0eb', display: 'flex', gap: 8, alignItems: 'center' }}>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={{ padding: '4px 8px', fontSize: 12 }}>
          <option value="all">全部类别</option>
          {categoryNames.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <button onClick={beginCreate} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#3a855a', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>
          <Plus size={14} /> 新建
        </button>
      </div>

      {creating && (
        <div style={{ padding: 12, borderBottom: '1px solid #e4e0eb', background: '#fff', display: 'flex', gap: 8 }}>
          <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="名称" style={{ flex: 1, fontSize: 12, padding: '6px 8px', border: '1px solid #d4c8d4', borderRadius: 6 }} />
          <select value={formCategory} onChange={e => setFormCategory(e.target.value)} style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #d4c8d4', borderRadius: 6 }}>
            {categoryNames.map(name => <option key={name}>{name}</option>)}
          </select>
          <button onClick={submitCreate} style={{ background: '#3a855a', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>保存</button>
          <button onClick={cancelCreate} style={{ background: '#eee', color: '#333', border: 'none', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>取消</button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filtered.map(el => {
          const selected = el.id === selectedBookElementId;
          return (
            <div key={el.id} style={{ border: selected ? '2px solid #3a855a' : '1px solid #e2dfea', background: '#fff', padding: '10px 12px', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                {editingId === el.id ? (
                  <input value={editingName} onChange={e => setEditingName(e.target.value)} style={{ flex: 1, fontSize: 13, padding: '4px 6px', border: '1px solid #d4c8d4', borderRadius: 6 }} />
                ) : (
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#352f3b', cursor: 'pointer' }} onClick={() => setSelectedBookElementId(el.id)}>{el.name}</div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  {editingId === el.id ? (
                    <button onClick={submitEdit} style={{ background: '#3a6ea5', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}>保存</button>
                  ) : (
                    <button onClick={() => startEdit(el)} style={{ background: '#ece7f6', color: '#51415f', border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer' }} title="重命名"><Edit2 size={14} /></button>
                  )}
                  <button onClick={() => deleteElement(el.id)} style={{ background: '#f7e4e4', color: '#a33a3a', border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer' }} title="删除"><Trash2 size={14} /></button>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#736878', display: 'flex', justifyContent: 'space-between' }}>
                <span>类别：{el.category}</span>
                <span style={{ fontStyle: 'italic' }}>更新时间：{new Date(el.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ fontSize: 12, color: '#9b8ea8', padding: 12 }}>暂无记录</div>
        )}
      </div>
    </div>
  );
}
