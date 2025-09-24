import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Link2, ExternalLink, PenSquare, X } from 'lucide-react';
import { query, run } from '../lib/db';
import type { StoryNode, NodeEdge } from '../model/schema';
import { useAppStore } from '../store';
import { events as eventsBus } from '../lib/events';
import { ensureProjectId } from '../lib/entity';
import { createChapter } from '../lib/nodes';

type NodeWithEntities = StoryNode & {
  entities: Array<{ id: string; name: string; type: string; role: string }>;
};

type PositionMap = Record<string, { x: number; y: number }>;
type CardMetricsMap = Record<string, { width: number; height: number }>;

const CARD_WIDTH = 280;
const CARD_MIN_HEIGHT = 200;
const GRID_MARGIN = 120;
const GRID_GAP_X = 160;
const GRID_GAP_Y = 180;
const LINKING_HIGHLIGHT = '#d6f5e0';

const STATUS_COLORS: Record<StoryNode['status'], string> = {
  draft: '#FFF1F1',
  in_progress: '#FFF9EB',
  complete: '#EEFBEF',
  archived: '#F4F4F6',
};

const ENTRY_BADGE: Record<string, { bg: string; color: string }> = {
  character: { bg: '#ffe5e7', color: '#c83c4a' },
  location: { bg: '#e8f3ff', color: '#3f6cb2' },
  object: { bg: '#fff1e2', color: '#c26d1d' },
  faction: { bg: '#e5f5ef', color: '#2f7f62' },
  concept: { bg: '#f1e9ff', color: '#6d4aa8' },
};

export function GraphView() {
  const navigate = useNavigate();
  const { selectedChapterId: selectedNodeId, setSelectedChapterId: setSelectedNodeId } = useAppStore();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeWithEntities[]>([]);
  const [edges, setEdges] = useState<NodeEdge[]>([]);
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [positions, setPositions] = useState<PositionMap>({});
  const [cardMetrics, setCardMetrics] = useState<CardMetricsMap>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [recentlyDraggedId, setRecentlyDraggedId] = useState<string | null>(null);
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [summaryDraft, setSummaryDraft] = useState('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1200, height: 800 });
  const dragState = useRef<{
    nodeId: string;
    pointerId: number;
    startPointer: { x: number; y: number };
    startPosition: { x: number; y: number };
    moved: boolean;
  } | null>(null);
  const positionsRef = useRef<PositionMap>({});
  const dragTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setCanvasSize((prev) => (
        prev.width === width && prev.height === height ? prev : { width, height }
      ));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadGraph = useCallback(async () => {
    try {
      setIsLoading(true);
      const pid = await ensureProjectId();
      setProjectId(pid);

      const chapterRows = await query<StoryNode>(
        `SELECT * FROM story_node WHERE project_id='${pid}' AND type='chapter' ORDER BY order_key`
      );
      const edgeRows = await query<NodeEdge>(
        `SELECT * FROM node_edge WHERE project_id='${pid}'`
      );
      const entryRows = await query<{ node_id: string; entry_id: string; name: string; type: string; role: string }>(
        `SELECT nel.node_id, nel.entity_id AS entry_id, e.name, e.type, nel.role
         FROM node_entity_link nel
         JOIN entity e ON e.id = nel.entity_id
         WHERE nel.node_id IN (SELECT id FROM story_node WHERE project_id='${pid}')`
      );

      const grouped = entryRows.reduce<Record<string, NodeWithEntities['entities']>>((acc, row) => {
        (acc[row.node_id] = acc[row.node_id] || []).push({
          id: row.entry_id,
          name: row.name,
          type: row.type,
          role: row.role,
        });
        return acc;
      }, {});

      const withEntities = chapterRows.map<NodeWithEntities>((node) => ({
        ...node,
        entities: grouped[node.id] || [],
      }));

      setNodes(withEntities);
      setEdges(edgeRows);
    } catch (error) {
      console.error('Failed to load graph', error);
      setNodes([]);
      setEdges([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGraph();
    eventsBus.on('nodes:changed', loadGraph);
    eventsBus.on('graph:edge-created', loadGraph);
    eventsBus.on('graph:edge-deleted', loadGraph);
    eventsBus.on('codex:entry-created', loadGraph);
    eventsBus.on('codex:entry-deleted', loadGraph);
    eventsBus.on('db:ready', loadGraph);
    return () => {
      eventsBus.off('nodes:changed', loadGraph);
      eventsBus.off('graph:edge-created', loadGraph);
      eventsBus.off('graph:edge-deleted', loadGraph);
      eventsBus.off('codex:entry-created', loadGraph);
      eventsBus.off('codex:entry-deleted', loadGraph);
      eventsBus.off('db:ready', loadGraph);
    };
  }, [loadGraph]);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => () => {
    if (dragTimeoutRef.current) window.clearTimeout(dragTimeoutRef.current);
  }, []);

  useEffect(() => {
    setCardMetrics((prev) => {
      const next = { ...prev } as CardMetricsMap;
      let changed = false;
      Object.keys(next).forEach((id) => {
        if (!nodes.some((node) => node.id === id)) {
          delete next[id];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [nodes]);

  useEffect(() => {
    if (!nodes.length) {
      setPositions({});
      return;
    }

    setPositions((prev) => {
      const next: PositionMap = {};
      const fallback: NodeWithEntities[] = [];

      nodes.forEach((node) => {
        if (node.pos_x != null && node.pos_y != null) {
          next[node.id] = { x: node.pos_x, y: node.pos_y };
        } else if (prev[node.id]) {
          next[node.id] = prev[node.id];
        } else {
          fallback.push(node);
        }
      });

      if (fallback.length > 0) {
        const availableWidth = Math.max(canvasSize.width, 960);
        const columns = Math.max(1, Math.floor((availableWidth - GRID_MARGIN * 2) / (CARD_WIDTH + GRID_GAP_X)) || 1);
        fallback.forEach((node, idx) => {
          const col = idx % columns;
          const row = Math.floor(idx / columns);
          const x = GRID_MARGIN + col * (CARD_WIDTH + GRID_GAP_X);
          const y = GRID_MARGIN + row * (CARD_MIN_HEIGHT + GRID_GAP_Y);
          next[node.id] = { x, y };
        });
      }

      return next;
    });
  }, [nodes, canvasSize.width]);

  const canvasBounds = useMemo(() => {
    let maxWidth = canvasSize.width;
    let maxHeight = canvasSize.height;

    Object.entries(positions).forEach(([id, pos]) => {
      const metrics = cardMetrics[id] || { width: CARD_WIDTH, height: CARD_MIN_HEIGHT };
      maxWidth = Math.max(maxWidth, pos.x + metrics.width + GRID_MARGIN);
      maxHeight = Math.max(maxHeight, pos.y + metrics.height + GRID_MARGIN);
    });

    return {
      width: Math.max(maxWidth, canvasSize.width),
      height: Math.max(maxHeight, canvasSize.height),
    };
  }, [positions, cardMetrics, canvasSize]);

  const linkingSource = useMemo(
    () => (linkingFrom ? nodes.find((node) => node.id === linkingFrom) ?? null : null),
    [linkingFrom, nodes]
  );

  const registerMetrics = useCallback((nodeId: string, metrics: { width: number; height: number }) => {
    setCardMetrics((prev) => {
      const current = prev[nodeId];
      if (current && Math.abs(current.width - metrics.width) < 0.5 && Math.abs(current.height - metrics.height) < 0.5) {
        return prev;
      }
      return { ...prev, [nodeId]: metrics };
    });
  }, []);

  const persistNodePosition = useCallback(async (nodeId: string, pos: { x: number; y: number }) => {
    try {
      const now = new Date().toISOString();
      await run(`UPDATE story_node SET pos_x=${pos.x.toFixed(2)}, pos_y=${pos.y.toFixed(2)}, updated_at='${now}' WHERE id='${nodeId}'`);
      setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, pos_x: pos.x, pos_y: pos.y, updated_at: now } : node)));
    } catch (error) {
      console.error('Failed to persist node position', error);
    }
  }, []);

  const handlePointerDown = useCallback((nodeId: string, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-no-drag="true"]')) return;
    const position = positionsRef.current[nodeId];
    if (!position) return;

    dragState.current = {
      nodeId,
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startPosition: { ...position },
      moved: false,
    };
    setDraggingNodeId(nodeId);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((nodeId: string, event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.nodeId !== nodeId || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startPointer.x;
    const dy = event.clientY - state.startPointer.y;
    if (!state.moved && Math.hypot(dx, dy) > 3) {
      state.moved = true;
    }
    const next = { x: state.startPosition.x + dx, y: state.startPosition.y + dy };
    setPositions((prev) => ({ ...prev, [nodeId]: next }));
  }, []);

  const handlePointerUp = useCallback((nodeId: string, event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.nodeId !== nodeId || state.pointerId !== event.pointerId) return;
    dragState.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    setDraggingNodeId(null);

    if (state.moved) {
      const finalPos = positionsRef.current[nodeId];
      if (finalPos) {
        void persistNodePosition(nodeId, finalPos);
        setRecentlyDraggedId(nodeId);
        if (dragTimeoutRef.current) window.clearTimeout(dragTimeoutRef.current);
        dragTimeoutRef.current = window.setTimeout(() => {
          setRecentlyDraggedId(null);
          dragTimeoutRef.current = null;
        }, 200);
      }
    }
  }, [persistNodePosition]);

  const handlePointerCancel = useCallback((nodeId: string, event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.nodeId !== nodeId || state.pointerId !== event.pointerId) return;
    dragState.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    setDraggingNodeId(null);
  }, []);

  const createEdge = useCallback(async (sourceId: string, targetId: string) => {
    if (!projectId) return;
    try {
      const id = `edge_${Date.now()}`;
      const createdAt = new Date().toISOString();
      const newEdge: NodeEdge = {
        id,
        project_id: projectId,
        src_node_id: sourceId,
        dst_node_id: targetId,
        kind: 'chronology',
        weight: 1.0,
        created_at: createdAt,
      };
      await run(`
        INSERT INTO node_edge (id, project_id, src_node_id, dst_node_id, kind, weight, created_at)
        VALUES ('${newEdge.id}', '${newEdge.project_id}', '${newEdge.src_node_id}', '${newEdge.dst_node_id}', '${newEdge.kind}', ${newEdge.weight}, '${newEdge.created_at}')
      `);
      eventsBus.emit('graph:edge-created', { edge: newEdge });
      await loadGraph();
    } catch (error) {
      console.error('Failed to create edge', error);
    }
  }, [projectId, loadGraph]);

  const handleNodeClick = useCallback((nodeId: string) => {
    if (recentlyDraggedId === nodeId) {
      return;
    }
    if (linkingFrom && linkingFrom !== nodeId) {
      if (!edges.some((edge) => edge.src_node_id === linkingFrom && edge.dst_node_id === nodeId)) {
        void createEdge(linkingFrom, nodeId);
      }
      setLinkingFrom(null);
      return;
    }
    if (linkingFrom === nodeId) {
      setLinkingFrom(null);
      return;
    }
    setSelectedNodeId(nodeId);
    eventsBus.emit('graph:select', { nodeId });
  }, [edges, linkingFrom, setSelectedNodeId, createEdge, recentlyDraggedId]);

  const handleAddChapter = useCallback(async () => {
    const id = await createChapter('新章节');
    setSelectedNodeId(id);
    eventsBus.emit('nodes:changed');
  }, [setSelectedNodeId]);

  const handleOpenEditor = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    navigate('/editor');
  }, [navigate, setSelectedNodeId]);

  const handleStartSummaryEdit = useCallback((node: NodeWithEntities) => {
    setEditingSummaryId(node.id);
    setSummaryDraft(node.summary ?? '');
  }, []);

  const handleCancelSummaryEdit = useCallback(() => {
    setEditingSummaryId(null);
    setSummaryDraft('');
  }, []);

  const handleSaveSummary = useCallback(async (nodeId: string) => {
    const text = summaryDraft.trim();
    try {
      const now = new Date().toISOString();
      await run(`UPDATE story_node SET summary='${escapeSql(text)}', updated_at='${now}' WHERE id='${nodeId}'`);
      setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, summary: text, updated_at: now } : node)));
      eventsBus.emit('nodes:changed');
    } catch (error) {
      console.error('Failed to update summary', error);
    } finally {
      handleCancelSummaryEdit();
    }
  }, [summaryDraft, handleCancelSummaryEdit]);

  return (
    <div style={{ height: '100%', overflow: 'auto', position: 'relative' }} ref={containerRef}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          left: 0,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 24px',
          pointerEvents: 'none',
          gap: 16,
        }}
      >
        <div style={{ pointerEvents: 'auto' }}>
          <button onClick={handleAddChapter} style={toolbarButton}>
            <Plus size={16} />
            新建章节
          </button>
        </div>
        {linkingSource ? (
          <div
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px',
              borderRadius: 999,
              background: '#ffffff',
              border: '1px solid #dcd3e3',
              boxShadow: '0 8px 24px rgba(58, 44, 72, 0.14)',
              fontSize: 12,
              color: '#53475f',
            }}
          >
            <Link2 size={16} color="#4a8f6c" />
            <span>
              选择一个章节，与「{linkingSource.title}」建立关系
            </span>
            <button
              data-no-drag="true"
              onClick={() => setLinkingFrom(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                border: 'none',
                background: '#f4f0f8',
                color: '#6b5c7a',
                borderRadius: 999,
                padding: '4px 10px',
                cursor: 'pointer',
              }}
            >
              <X size={14} />
              取消
            </button>
          </div>
        ) : (
          <div style={{ pointerEvents: 'auto', fontSize: 12, color: '#7b7282' }}>
            双击章节打开编辑器 · 拖拽卡片调整布局
          </div>
        )}
      </div>

      <div
        style={{
          position: 'relative',
          width: canvasBounds.width,
          height: canvasBounds.height,
          backgroundImage: 'radial-gradient(#e4dfeb 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      >
        <svg
          width={canvasBounds.width}
          height={canvasBounds.height}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          {edges.map((edge) => {
            const sourcePos = positions[edge.src_node_id];
            const targetPos = positions[edge.dst_node_id];
            if (!sourcePos || !targetPos) return null;
            const sourceMetrics = cardMetrics[edge.src_node_id] || { width: CARD_WIDTH, height: CARD_MIN_HEIGHT };
            const targetMetrics = cardMetrics[edge.dst_node_id] || { width: CARD_WIDTH, height: CARD_MIN_HEIGHT };
            const startX = sourcePos.x + sourceMetrics.width / 2;
            const startY = sourcePos.y + sourceMetrics.height;
            const endX = targetPos.x + targetMetrics.width / 2;
            const endY = targetPos.y;
            const midY = startY + (endY - startY) / 2;
            return (
              <path
                key={edge.id}
                d={`M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`}
                stroke="#c5bed0"
                strokeWidth={2}
                fill="none"
              />
            );
          })}
        </svg>

        {nodes.map((node) => {
          const position = positions[node.id];
          if (!position) return null;
          const summaryEditing = editingSummaryId === node.id;
          return (
            <ChapterCard
              key={node.id}
              node={node}
              position={position}
              selected={node.id === selectedNodeId}
              dragging={draggingNodeId === node.id}
              linkingSource={linkingFrom === node.id}
              linkingTarget={Boolean(linkingFrom && linkingFrom !== node.id)}
              summaryEditing={summaryEditing}
              summaryDraft={summaryEditing ? summaryDraft : node.summary ?? ''}
              onSummaryDraftChange={setSummaryDraft}
              onSummaryEditStart={() => handleStartSummaryEdit(node)}
              onSummaryCancel={handleCancelSummaryEdit}
              onSummarySave={() => handleSaveSummary(node.id)}
              onSelect={() => handleNodeClick(node.id)}
              onDoubleClick={() => handleOpenEditor(node.id)}
              onOpenEditor={() => handleOpenEditor(node.id)}
              onStartLink={() => {
                if (linkingFrom === node.id) {
                  setLinkingFrom(null);
                  return;
                }
                setSelectedNodeId(node.id);
                eventsBus.emit('graph:select', { nodeId: node.id });
                setLinkingFrom(node.id);
              }}
              onPointerDown={(event) => handlePointerDown(node.id, event)}
              onPointerMove={(event) => handlePointerMove(node.id, event)}
              onPointerUp={(event) => handlePointerUp(node.id, event)}
              onPointerCancel={(event) => handlePointerCancel(node.id, event)}
              registerMetrics={(metrics) => registerMetrics(node.id, metrics)}
            />
          );
        })}

        {isLoading && (
          <div
            style={{
              position: 'absolute',
              top: 40,
              right: 40,
              padding: '6px 12px',
              background: '#ffffff',
              borderRadius: 12,
              border: '1px solid #e0dce8',
              color: '#6b6172',
              fontSize: 12,
            }}
          >
            正在载入章节…
          </div>
        )}
      </div>
    </div>
  );
}

interface ChapterCardProps {
  node: NodeWithEntities;
  position: { x: number; y: number };
  selected: boolean;
  dragging: boolean;
  linkingSource: boolean;
  linkingTarget: boolean;
  summaryEditing: boolean;
  summaryDraft: string;
  onSummaryDraftChange: (value: string) => void;
  onSummaryEditStart: () => void;
  onSummaryCancel: () => void;
  onSummarySave: () => void;
  onSelect: () => void;
  onDoubleClick: () => void;
  onOpenEditor: () => void;
  onStartLink: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  registerMetrics: (metrics: { width: number; height: number }) => void;
}

function ChapterCard({
  node,
  position,
  selected,
  dragging,
  linkingSource,
  linkingTarget,
  summaryEditing,
  summaryDraft,
  onSummaryDraftChange,
  onSummaryEditStart,
  onSummaryCancel,
  onSummarySave,
  onSelect,
  onDoubleClick,
  onOpenEditor,
  onStartLink,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  registerMetrics,
}: ChapterCardProps) {
  const statusColor = STATUS_COLORS[node.status] || '#ffffff';
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        registerMetrics({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [registerMetrics]);

  const cardBackground = linkingTarget ? LINKING_HIGHLIGHT : '#ffffff';
  const borderColor = linkingSource
    ? '#4b8b6e'
    : linkingTarget
      ? '#4b8b6e'
      : selected
        ? '#4b8b6e'
        : '#dfd6e6';

  const handleSummaryKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onSummarySave();
    }
  };

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        width: CARD_WIDTH,
        minHeight: CARD_MIN_HEIGHT,
        borderRadius: 20,
        border: linkingTarget ? `2px dashed ${borderColor}` : selected ? `2px solid ${borderColor}` : `1px solid ${borderColor}`,
        background: cardBackground,
        boxShadow: selected || dragging ? '0 12px 24px rgba(57, 44, 76, 0.18)' : '0 10px 18px rgba(49, 39, 62, 0.08)',
        cursor: summaryEditing ? 'text' : dragging ? 'grabbing' : 'grab',
        userSelect: summaryEditing ? 'text' : 'none',
        transition: dragging ? 'none' : 'transform 0.2s ease',
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div
        style={{
          background: statusColor,
          padding: '14px 18px 12px 18px',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#352c3d' }}>{node.title}</div>
          <div style={{ fontSize: 11, color: '#7b7381', marginTop: 4 }}>
            {node.status.replace('_', ' ')} · {new Date(node.updated_at).toLocaleDateString()}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            data-no-drag="true"
            onClick={(event) => {
              event.stopPropagation();
              onOpenEditor();
            }}
            style={{
              border: 'none',
              background: '#ffffff',
              color: '#5f516c',
              borderRadius: 12,
              padding: '6px 8px',
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
            }}
          >
            <ExternalLink size={16} />
          </button>
          <button
            data-no-drag="true"
            onClick={(event) => {
              event.stopPropagation();
              onStartLink();
            }}
            style={{
              border: 'none',
              background: linkingSource ? '#4b8b6e' : '#ffffff',
              color: linkingSource ? '#ffffff' : '#5f516c',
              borderRadius: 12,
              padding: '6px 8px',
              cursor: 'pointer',
              boxShadow: linkingSource ? '0 2px 6px rgba(74, 139, 110, 0.4)' : '0 1px 3px rgba(0,0,0,0.12)',
            }}
          >
            <Link2 size={16} />
          </button>
        </div>
      </div>

      <div style={{ padding: '14px 18px 16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {summaryEditing ? (
          <div data-no-drag="true" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              value={summaryDraft}
              onChange={(event) => onSummaryDraftChange(event.target.value)}
              onKeyDown={handleSummaryKeyDown}
              rows={4}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 12,
                border: '1px solid #c9bfd9',
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
              autoFocus
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                data-no-drag="true"
                onClick={(event) => {
                  event.stopPropagation();
                  onSummaryCancel();
                }}
                style={{
                  border: '1px solid #d7cfe3',
                  background: '#f5f1fb',
                  color: '#6c5f7a',
                  borderRadius: 10,
                  padding: '4px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
              <button
                data-no-drag="true"
                onClick={(event) => {
                  event.stopPropagation();
                  onSummarySave();
                }}
                style={{
                  border: 'none',
                  background: '#4b8b6e',
                  color: '#ffffff',
                  borderRadius: 10,
                  padding: '4px 14px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: '#625b68', lineHeight: 1.5 }}>
              {node.summary ? truncate(node.summary, 140) : '暂无章节梗概，点击下方按钮快速编辑。'}
            </div>
            <button
              data-no-drag="true"
              onClick={(event) => {
                event.stopPropagation();
                onSummaryEditStart();
              }}
              style={{
                alignSelf: 'flex-start',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                border: '1px solid #d9cfe1',
                background: '#f5f1fb',
                color: '#5f516c',
                borderRadius: 10,
                padding: '4px 10px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              <PenSquare size={14} />
              编辑梗概
            </button>
          </div>
        )}

        {node.entities.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {node.entities.slice(0, 4).map((entity) => {
              const colors = ENTRY_BADGE[entity.type] || { bg: '#f1eef6', color: '#514758' };
              return (
                <span
                  key={entity.id}
                  style={{
                    background: colors.bg,
                    color: colors.color,
                    fontSize: 11,
                    padding: '4px 8px',
                    borderRadius: 999,
                  }}
                >
                  {entity.name}
                </span>
              );
            })}
            {node.entities.length > 4 && (
              <span style={{ fontSize: 11, color: '#8a8190' }}>+{node.entities.length - 4}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const toolbarButton: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 24,
  border: '1px solid #d7d1dd',
  background: '#fff',
  color: '#40354b',
  fontSize: 12,
  cursor: 'pointer',
  boxShadow: '0 4px 10px rgba(71, 57, 91, 0.08)'
};

function truncate(text: string, length: number) {
  if (text.length <= length) return text;
  return `${text.slice(0, length)}…`;
}

function escapeSql(value: string) {
  return value.replaceAll("'", "''");
}
