import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { query, run } from '../lib/db';
import type { StoryNode, NodeEdge } from '../model/schema';
import { createChapter } from '../lib/nodes';
import { events } from '../lib/events';
import { useAppStore } from '../store';

type NavigatorMode = 'list' | 'map';

const cardColors: Record<string, string> = {
  draft: '#F5F1FF',
  in_progress: '#FFF7E6',
  complete: '#E9FCE8',
  archived: '#F0F0F0',
};

export function ChapterNavigator() {
  const navigate = useNavigate();
  const { selectedChapterId: selectedNodeId, setSelectedChapterId: setSelectedNodeId } = useAppStore();
  const [chapters, setChapters] = useState<StoryNode[]>([]);
  const [mode, setMode] = useState<NavigatorMode>('list');
  const [isLoading, setIsLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [search, setSearch] = useState('');
  const [edges, setEdges] = useState<NodeEdge[]>([]);

  const loadChapters = useCallback(async () => {
    try {
      setIsLoading(true);
      const rows = await query<StoryNode>(
        "SELECT * FROM story_node WHERE type='chapter' ORDER BY order_key ASC"
      );
      setChapters(rows);
    } catch (error) {
      console.error('Failed to load chapters', error);
      setChapters([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadEdges = useCallback(async () => {
    try {
      const rows = await query<NodeEdge>('SELECT * FROM node_edge ORDER BY created_at');
      setEdges(rows);
    } catch (error) {
      console.error('Failed to load edges', error);
      setEdges([]);
    }
  }, []);

  useEffect(() => {
    const reload = () => {
      void loadChapters();
      void loadEdges();
    };
    reload();
    events.on('nodes:changed', reload);
    events.on('db:ready', reload);
    events.on('graph:edge-created', reload);
    events.on('graph:edge-deleted', reload);
    return () => {
      events.off('nodes:changed', reload);
      events.off('db:ready', reload);
      events.off('graph:edge-created', reload);
      events.off('graph:edge-deleted', reload);
    };
  }, [loadChapters, loadEdges]);

  const filteredChapters = useMemo(() => {
    if (!search.trim()) return chapters;
    const term = search.toLowerCase();
    return chapters.filter((ch) => ch.title.toLowerCase().includes(term));
  }, [chapters, search]);

  const openChapter = useCallback((id: string) => {
    setSelectedNodeId(id);
    navigate('/editor');
  }, [navigate, setSelectedNodeId]);

  const onAddChapter = useCallback(async () => {
    const id = await createChapter('New Chapter');
    await loadChapters();
    setSelectedNodeId(id);
    navigate('/editor');
  }, [loadChapters, navigate, setSelectedNodeId]);

  const startRename = useCallback((chapter: StoryNode) => {
    setEditingId(chapter.id);
    setEditingTitle(chapter.title);
  }, []);

  const commitRename = useCallback(async () => {
    if (!editingId) return;
    const nextTitle = editingTitle.trim() || 'Untitled Chapter';
    try {
      await run(`UPDATE story_node SET title='${escapeSql(nextTitle)}', updated_at='${new Date().toISOString()}' WHERE id='${editingId}'`);
      events.emit('nodes:changed');
    } catch (error) {
      console.error('Failed to rename chapter', error);
    } finally {
      setEditingId(null);
      setEditingTitle('');
    }
  }, [editingId, editingTitle]);

  const moveChapter = useCallback(async (id: string, direction: 'up' | 'down') => {
    const index = chapters.findIndex((c) => c.id === id);
    if (index === -1) return;
    const swapIdx = direction === 'up' ? index - 1 : index + 1;
    if (swapIdx < 0 || swapIdx >= chapters.length) return;

    const current = chapters[index];
    const target = chapters[swapIdx];
    try {
      await run(`UPDATE story_node SET order_key=${target.order_key}, updated_at='${new Date().toISOString()}' WHERE id='${current.id}'`);
      await run(`UPDATE story_node SET order_key=${current.order_key}, updated_at='${new Date().toISOString()}' WHERE id='${target.id}'`);
      events.emit('nodes:changed');
      await loadChapters();
    } catch (error) {
      console.error('Failed to reorder chapters', error);
    }
  }, [chapters, loadChapters]);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#f6f4f6',
      borderRight: '1px solid #d8d3d8'
    }}>
      <div style={{ padding: '16px 18px 12px 18px', borderBottom: '1px solid #ddd6dd' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, textTransform: 'uppercase', color: '#978297', letterSpacing: '0.08em' }}>Chapters</div>
            <h2 style={{ fontSize: 16, margin: '4px 0 0 0', color: '#352f35' }}>Outline</h2>
          </div>
          <button
            onClick={onAddChapter}
            style={{
              border: 'none',
              backgroundColor: '#4c915d',
              color: '#fff',
              borderRadius: 18,
              fontSize: 12,
              padding: '6px 14px',
              cursor: 'pointer'
            }}
          >
            + New Chapter
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            type="text"
            placeholder="Search chapters"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid #d4c8d4',
              backgroundColor: '#fff'
            }}
          />
          <div style={{ display: 'flex', borderRadius: 999, border: '1px solid #d4c8d4', overflow: 'hidden' }}>
            <button
              onClick={() => setMode('list')}
              style={{
                padding: '6px 12px',
                fontSize: 11,
                backgroundColor: mode === 'list' ? '#fff' : 'transparent',
                color: mode === 'list' ? '#30222f' : '#836f84',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              List
            </button>
            <button
              onClick={() => setMode('map')}
              style={{
                padding: '6px 12px',
                fontSize: 11,
                backgroundColor: mode === 'map' ? '#fff' : 'transparent',
                color: mode === 'map' ? '#30222f' : '#836f84',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              Map
            </button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {isLoading && <div style={{ fontSize: 12, color: '#998a99' }}>Loading chapters…</div>}

        {!isLoading && filteredChapters.length === 0 && (
          <div style={{ fontSize: 12, color: '#998a99' }}>No chapters yet. Create one to get started.</div>
        )}

        {!isLoading && mode === 'list' && filteredChapters.map((chapter, index) => {
          const isSelected = chapter.id === selectedNodeId;
          const background = cardColors[chapter.status] || '#ffffff';
          return (
            <div
              key={chapter.id}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: isSelected ? '1px solid #5a8f62' : '1px solid #e1d7e1',
                backgroundColor: background,
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                boxShadow: isSelected ? '0 0 0 2px rgba(74, 158, 99, 0.2)' : 'none'
              }}
              onClick={() => openChapter(chapter.id)}
            >
              {editingId === chapter.id ? (
                <input
                  value={editingTitle}
                  autoFocus
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') {
                      setEditingId(null);
                      setEditingTitle('');
                    }
                  }}
                  style={{
                    fontSize: 13,
                    padding: '6px 8px',
                    borderRadius: 8,
                    border: '1px solid #cbbcc9',
                    backgroundColor: '#fff'
                  }}
                />
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#2c222c' }}>{chapter.title}</div>
                    <div style={{ fontSize: 11, color: '#8b7c8b' }}>#{index + 1} · {chapter.status.replace('_', ' ')}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); moveChapter(chapter.id, 'up'); }}
                      style={iconButtonStyle}
                      title="Move up"
                    >↑</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); moveChapter(chapter.id, 'down'); }}
                      style={iconButtonStyle}
                      title="Move down"
                    >↓</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); startRename(chapter); }}
                      style={iconButtonStyle}
                      title="Rename"
                    >✎</button>
                  </div>
                </div>
              )}

              {chapter.summary && (
                <div style={{
                  fontSize: 12,
                  lineHeight: 1.4,
                  color: '#625762'
                }}>
                  {chapter.summary.length > 120 ? `${chapter.summary.slice(0, 120)}…` : chapter.summary}
                </div>
              )}
            </div>
          );
        })}

        {!isLoading && mode === 'map' && (
          <MiniMap
            chapters={filteredChapters}
            edges={edges}
            onSelect={openChapter}
            selectedId={selectedNodeId}
          />
        )}
      </div>
    </div>
  );
}

function MiniMap({
  chapters,
  edges,
  onSelect,
  selectedId,
}: {
  chapters: StoryNode[];
  edges: NodeEdge[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const positioned = chapters.filter((chapter) => chapter.pos_x != null && chapter.pos_y != null);
  const unpositioned = chapters.filter((chapter) => chapter.pos_x == null || chapter.pos_y == null);
  const hasPositions = positioned.length > 0;

  if (!hasPositions) {
    const cardWidth = 120;
    const cardHeight = 70;
    const gap = 12;
    const columns = 2;

    return (
      <div style={{ position: 'relative', minHeight: 300, width: 280, margin: '0 auto', background: '#fefcfe', borderRadius: 16, border: '1px solid #e6dfea', padding: 12 }}>
        {chapters.length === 0 && (
          <div style={{ fontSize: 12, color: '#b3a4b3', textAlign: 'center', marginTop: 120 }}>No chapters yet</div>
        )}
        {chapters.map((chapter, idx) => {
          const row = Math.floor(idx / columns);
          const col = idx % columns;
          const x = col * (cardWidth + gap);
          const y = row * (cardHeight + gap);
          const isSelected = chapter.id === selectedId;
          return (
            <button
              key={chapter.id}
              type="button"
              onClick={() => onSelect(chapter.id)}
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: cardWidth,
                height: cardHeight,
                borderRadius: 14,
                border: isSelected ? '2px solid #4a9e63' : '1px solid #dacfe2',
                backgroundColor: '#fff',
                boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                padding: '10px 12px',
                cursor: 'pointer',
                transition: 'transform 0.15s ease',
                display: 'flex',
                flexDirection: 'column',
                textAlign: 'left',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: '#352c36', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chapter.title}</div>
              <div style={{ fontSize: 10, color: '#9a8fa4', marginTop: 4 }}>{chapter.status.replace('_', ' ')}</div>
              <div style={{ fontSize: 10, color: '#b2a6bc', marginTop: 'auto' }}>#{idx + 1}</div>
            </button>
          );
        })}
      </div>
    );
  }

  const width = 280;
  const height = 320;
  const margin = 36;
  const xs = positioned.map((chapter) => Number(chapter.pos_x ?? 0));
  const ys = positioned.map((chapter) => Number(chapter.pos_y ?? 0));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX === 0 ? 1 : maxX - minX;
  const spanY = maxY - minY === 0 ? 1 : maxY - minY;
  const innerWidth = width - margin * 2;
  const innerHeight = height - margin * 2;

  const positions = new Map<string, { x: number; y: number; node: StoryNode }>();
  positioned.forEach((chapter) => {
    const rawX = Number(chapter.pos_x ?? 0);
    const rawY = Number(chapter.pos_y ?? 0);
    const x = margin + ((rawX - minX) / spanX) * innerWidth;
    const y = margin + ((rawY - minY) / spanY) * innerHeight;
    positions.set(chapter.id, { x, y, node: chapter });
  });

  if (unpositioned.length) {
    const step = innerWidth / (unpositioned.length + 1);
    const fallbackY = height - margin * 0.7;
    unpositioned.forEach((chapter, index) => {
      const x = margin + step * (index + 1);
      positions.set(chapter.id, { x, y: fallbackY, node: chapter });
    });
  }

  const visibleEdges = edges.filter((edge) => positions.has(edge.src_node_id) && positions.has(edge.dst_node_id));

  return (
    <div style={{ position: 'relative', minHeight: height, width: width, margin: '0 auto', background: '#fefcfe', borderRadius: 16, border: '1px solid #e6dfea', padding: 0, overflow: 'hidden' }}>
      {chapters.length === 0 && (
        <div style={{ fontSize: 12, color: '#b3a4b3', textAlign: 'center', marginTop: 120 }}>No chapters yet</div>
      )}

      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        {visibleEdges.map((edge) => {
          const src = positions.get(edge.src_node_id)!;
          const dst = positions.get(edge.dst_node_id)!;
          return (
            <line
              key={edge.id}
              x1={src.x}
              y1={src.y}
              x2={dst.x}
              y2={dst.y}
              stroke="rgba(121, 108, 146, 0.35)"
              strokeWidth={2}
              strokeLinecap="round"
            />
          );
        })}
      </svg>

      {[...positions.values()].map(({ x, y, node }) => {
        const isSelected = node.id === selectedId;
        return (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelect(node.id)}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              transform: 'translate(-50%, -50%)',
              minWidth: 104,
              maxWidth: 140,
              borderRadius: 14,
              border: isSelected ? '2px solid #4a9e63' : '1px solid #d6cfe4',
              background: '#ffffff',
              boxShadow: isSelected ? '0 6px 16px rgba(69, 122, 92, 0.22)' : '0 3px 10px rgba(52, 37, 70, 0.12)',
              padding: '10px 12px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: '#352c36', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {node.title}
            </span>
            <span style={{ fontSize: 10, color: '#9a8fa4', textTransform: 'capitalize' }}>
              {node.status.replace('_', ' ')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const iconButtonStyle: CSSProperties = {
  border: '1px solid #c6b9c6',
  backgroundColor: '#f0e8f0',
  color: '#514451',
  fontSize: 11,
  padding: '4px 8px',
  borderRadius: 8,
  cursor: 'pointer'
};

function escapeSql(value: string) {
  return value.replaceAll("'", "''");
}
