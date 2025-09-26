import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store';
import type { BookNode, BookNodeEdge } from '../domain/book_node';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';

type NavigatorMode = 'list' | 'map';

const cardColors: Record<string, string> = {
  draft: '#F5F1FF',
  in_progress: '#FFF7E6',
  complete: '#E9FCE8',
  archived: '#F0F0F0',
};

export function ChapterNavigator() {
  const navigate = useNavigate();
  const {
    selectedChapterId,
    setSelectedChapterId,
    bookNodes,
    nodeEdges,
  } = useAppStore();
  const { loadNodes, loadEdges, createNode, renameNode, reorderNode } = useBookNodeUsecases();

  const [mode, setMode] = useState<NavigatorMode>('list');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [search, setSearch] = useState('');

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      await Promise.all([
        loadNodes({ type: 'chapter' }),
        loadEdges(),
      ]);
    } catch (error) {
      console.error('Failed to load chapters', error);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [loadNodes, loadEdges]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const chapters = useMemo(
    () => bookNodes
      .filter((node) => node.type === 'chapter')
      .slice()
      .sort((a, b) => a.orderKey - b.orderKey),
    [bookNodes]
  );

  const filteredChapters = useMemo(() => {
    if (!search.trim()) return chapters;
    const term = search.toLowerCase();
    return chapters.filter((chapter) => chapter.title.toLowerCase().includes(term));
  }, [chapters, search]);

  const openChapter = useCallback((id: string) => {
    setSelectedChapterId(id);
    navigate('/editor');
  }, [navigate, setSelectedChapterId]);

  const onAddChapter = useCallback(async () => {
    try {
      const node = await createNode({ title: 'New Chapter', type: 'chapter' });
      setSelectedChapterId(node.id);
      navigate('/editor');
    } catch (error) {
      console.error('Failed to create chapter', error);
    }
  }, [createNode, navigate, setSelectedChapterId]);

  const startRename = useCallback((chapter: BookNode) => {
    setEditingId(chapter.id);
    setEditingTitle(chapter.title);
  }, []);

  const commitRename = useCallback(async () => {
    if (!editingId) return;
    const nextTitle = editingTitle.trim() || 'Untitled Chapter';
    try {
      await renameNode(editingId, nextTitle);
    } catch (error) {
      console.error('Failed to rename chapter', error);
    } finally {
      setEditingId(null);
      setEditingTitle('');
    }
  }, [editingId, editingTitle, renameNode]);

  const moveChapter = useCallback(async (id: string, direction: 'up' | 'down') => {
    try {
      await reorderNode(id, direction);
    } catch (error) {
      console.error('Failed to reorder chapters', error);
    }
  }, [reorderNode]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 320, background: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(16px)', borderRadius: 24, border: '1px solid rgba(220,210,230,0.7)', boxShadow: '0 18px 40px rgba(28,12,36,0.18)', overflow: 'hidden' }}>
      <div style={{ padding: '18px 18px 10px', borderBottom: '1px solid rgba(220,210,230,0.7)', background: 'linear-gradient(180deg, rgba(250,245,255,0.9) 0%, rgba(245,236,255,0.65) 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#2d1f2d' }}>章节</div>
            <div style={{ fontSize: 12, color: '#8c7d8c' }}>Manage your story flow</div>
          </div>
          <button
            type="button"
            onClick={onAddChapter}
            style={{
              border: '1px solid #bca2bc',
              backgroundColor: '#ffffff',
              color: '#4d3e4d',
              fontSize: 12,
              borderRadius: 999,
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
              type="button"
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
              type="button"
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
        {!isLoading && loadError && <div style={{ fontSize: 12, color: '#b85c5c' }}>Failed to load chapters: {loadError}</div>}
        {!isLoading && !loadError && filteredChapters.length === 0 && (
          <div style={{ fontSize: 12, color: '#998a99' }}>No chapters yet. Create one to get started.</div>
        )}

        {!isLoading && !loadError && mode === 'list' && filteredChapters.map((chapter, index) => {
          const isSelected = chapter.id === selectedChapterId;
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
                      type="button"
                      onClick={(e) => { e.stopPropagation(); moveChapter(chapter.id, 'up'); }}
                      style={iconButtonStyle}
                      title="Move up"
                    >↑</button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); moveChapter(chapter.id, 'down'); }}
                      style={iconButtonStyle}
                      title="Move down"
                    >↓</button>
                    <button
                      type="button"
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

        {!isLoading && !loadError && mode === 'map' && (
          <MiniMap
            chapters={filteredChapters}
            edges={nodeEdges}
            onSelect={openChapter}
            selectedId={selectedChapterId}
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
  chapters: BookNode[];
  edges: BookNodeEdge[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const positioned = chapters.filter((chapter) => chapter.position.x != null && chapter.position.y != null);
  const unpositioned = chapters.filter((chapter) => chapter.position.x == null || chapter.position.y == null);
  const hasPositions = positioned.length > 0;

  if (!hasPositions) {
    const cardWidth = 120;
    const cardHeight = 70;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
        {chapters.map((chapter, idx) => {
          const isSelected = chapter.id === selectedId;
          return (
            <button
              key={chapter.id}
              type="button"
              onClick={() => onSelect(chapter.id)}
              style={{
                minHeight: cardHeight,
                minWidth: cardWidth,
                borderRadius: 14,
                border: isSelected ? '2px solid #4a9e63' : '1px solid #d6cfe4',
                background: '#ffffff',
                boxShadow: isSelected ? '0 6px 16px rgba(69, 122, 92, 0.22)' : '0 3px 10px rgba(52, 37, 70, 0.12)',
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
  const xs = positioned.map((chapter) => Number(chapter.position.x ?? 0));
  const ys = positioned.map((chapter) => Number(chapter.position.y ?? 0));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX === 0 ? 1 : maxX - minX;
  const spanY = maxY - minY === 0 ? 1 : maxY - minY;
  const innerWidth = width - margin * 2;
  const innerHeight = height - margin * 2;

  const positions = new Map<string, { x: number; y: number; node: BookNode }>();
  positioned.forEach((chapter) => {
    const rawX = Number(chapter.position.x ?? 0);
    const rawY = Number(chapter.position.y ?? 0);
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

  const visibleEdges = edges.filter((edge) => positions.has(edge.sourceNodeId) && positions.has(edge.targetNodeId));

  return (
    <div style={{ position: 'relative', minHeight: height, width: width, margin: '0 auto', background: '#fefcfe', borderRadius: 16, border: '1px solid #e6dfea', padding: 0, overflow: 'hidden' }}>
      {chapters.length === 0 && (
        <div style={{ fontSize: 12, color: '#b3a4b3', textAlign: 'center', marginTop: 120 }}>No chapters yet</div>
      )}

      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        {visibleEdges.map((edge) => {
          const src = positions.get(edge.sourceNodeId)!;
          const dst = positions.get(edge.targetNodeId)!;
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
