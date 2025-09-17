import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { query, run } from '../lib/db';
import type { StoryNode } from '../lib/schema';
import { createChapter } from '../lib/nodes';
import { events } from '../lib/events';
import { useAppStore } from '../store';

export function OutlinePanel() {
  const navigate = useNavigate();
  const { setSelectedNodeId } = useAppStore();
  const [chapters, setChapters] = useState<StoryNode[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);

  const loadChapters = useCallback(async () => {
    try {
      setIsLoading(true);
      const rows = await query<StoryNode>(
        "SELECT * FROM story_node WHERE type='chapter' ORDER BY order_key ASC"
      );
      setChapters(rows);
    } catch (e) {
      console.error('Failed to load chapters', e);
      setChapters([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadChapters();
    const handler = () => loadChapters();
    events.on('nodes:changed', handler);
    return () => events.off('nodes:changed', handler);
  }, [loadChapters]);

  const onAddChapter = useCallback(async () => {
    const id = await createChapter('New Chapter');
    await loadChapters();
    setSelectedNodeId(id);
    navigate('/editor');
  }, [loadChapters, navigate, setSelectedNodeId]);

  const openChapter = useCallback((id: string) => {
    setSelectedNodeId(id);
    navigate('/editor');
  }, [navigate, setSelectedNodeId]);

  const startRename = (ch: StoryNode) => {
    setEditingId(ch.id);
    setEditTitle(ch.title);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const title = editTitle.trim() || 'Untitled';
    try {
      await run(`UPDATE story_node SET title='${escapeSql(title)}', updated_at='${new Date().toISOString()}' WHERE id='${editingId}'`);
      events.emit('nodes:changed');
    } catch (e) {
      console.error('Failed to rename chapter', e);
    } finally {
      setEditingId(null);
      setEditTitle('');
    }
  };

  const moveChapter = async (id: string, dir: 'up' | 'down') => {
    // swap order_key with prev/next chapter
    const idx = chapters.findIndex(c => c.id === id);
    if (idx === -1) return;
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= chapters.length) return;
    const a = chapters[idx];
    const b = chapters[swapIdx];
    try {
      await run(`UPDATE story_node SET order_key=${b.order_key}, updated_at='${new Date().toISOString()}' WHERE id='${a.id}'`);
      await run(`UPDATE story_node SET order_key=${a.order_key}, updated_at='${new Date().toISOString()}' WHERE id='${b.id}'`);
      events.emit('nodes:changed');
      await loadChapters();
    } catch (e) {
      console.error('Failed to reorder chapters', e);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 0', borderBottom: '1px solid #ccc', marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Outline</h2>
          <button
            onClick={onAddChapter}
            style={{ fontSize: 12, padding: '4px 8px', border: '1px solid #bbb', borderRadius: 6, background: 'white' }}
          >
            + Chapter
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {isLoading && <div style={{ fontSize: 12, color: '#666' }}>Loading…</div>}
        {!isLoading && chapters.map((ch) => (
          <div
            key={ch.id}
            style={{
              padding: 8,
              backgroundColor: '#fff',
              border: '1px solid #e0e0e0',
              borderRadius: 6,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              cursor: 'pointer'
            }}
            onClick={() => openChapter(ch.id)}
          >
            {editingId === ch.id ? (
              <input
                value={editTitle}
                autoFocus
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') { setEditingId(null); setEditTitle(''); }
                }}
                style={{ flex: 1, fontSize: 13, padding: '4px 6px', border: '1px solid #ccc', borderRadius: 4 }}
              />
            ) : (
              <>
                <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{ch.title}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    title="Move up"
                    onClick={(e) => { e.stopPropagation(); moveChapter(ch.id, 'up'); }}
                    style={{ fontSize: 11, border: '1px solid #ddd', background: '#f7f7f7', padding: '2px 6px', borderRadius: 4 }}
                  >↑</button>
                  <button
                    title="Move down"
                    onClick={(e) => { e.stopPropagation(); moveChapter(ch.id, 'down'); }}
                    style={{ fontSize: 11, border: '1px solid #ddd', background: '#f7f7f7', padding: '2px 6px', borderRadius: 4 }}
                  >↓</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); startRename(ch); }}
                    style={{ fontSize: 11, border: '1px solid #ddd', background: '#f7f7f7', padding: '2px 6px', borderRadius: 4 }}
                  >Rename</button>
                </div>
              </>
            )}
          </div>
        ))}
        {!isLoading && chapters.length === 0 && (
          <div style={{ fontSize: 12, color: '#777' }}>No chapters yet. Create one.</div>
        )}
      </div>
    </div>
  );
}

function escapeSql(s: string) {
  return s.replaceAll("'", "''");
}
