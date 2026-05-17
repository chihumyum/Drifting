import { useState, useMemo, useCallback } from 'react';
import { Plus, Trash2, MoreVertical, Edit3, AlignLeft, GitBranch } from 'lucide-react';
import loglevel from 'loglevel';

import type { BookNode } from '../../domain/book-node';
import { useDataStore } from '../../store/data-store';
import { useUiStore } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';

const log = loglevel.getLogger('NodesPanel');
log.setLevel(loglevel.levels.ERROR);

type ViewMode = 'global' | 'storyline';

const formatShortDate = (input: string | number | Date) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return sameYear ? `${month}/${day}` : `${d.getFullYear() % 100}/${month}/${day}`;
};

export function NodesPanel() {
  const { bookNodes, storylines, storylineNodeMapping } = useDataStore();
  const { nodeUi, setNodeSelection, timelineHeight } = useUiStore();
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, navigateToStoryline } = useProjectNavigation();
  const selectedNodeId = nodeUi.selectedId;

  const activeProjectId = useMemo(() => {
    if (!projectId) {
      throw new Error('NodesPanel requires a non-empty projectId');
    }
    return projectId;
  }, [projectId]);

  const { createNode, renameNode, deleteNode } = useBookNode({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const { createStoryline, updateStoryline } = useStoryline({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const [viewMode, setViewMode] = useState<ViewMode>('global');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingNodeName, setEditingNodeName] = useState('');
  const [editingStorylineId, setEditingStorylineId] = useState<string | null>(null);
  const [editingStorylineName, setEditingStorylineName] = useState('');

  const panelHeight = useMemo(() => `calc(100vh - 120px - ${timelineHeight}px)`, [timelineHeight]);

  const storylineById = useMemo(
    () => new Map(storylines.map((s) => [s.id, s])),
    [storylines],
  );
  const nodeById = useMemo(() => new Map(bookNodes.map((n) => [n.id, n])), [bookNodes]);

  // Global view: every node, sorted by timeline start.
  const sortedNodesGlobal = useMemo(
    () => bookNodes.slice().sort((a, b) => a.start - b.start),
    [bookNodes],
  );

  // Grouped view: each storyline lists its mapped nodes (mirrors timeline rows).
  const nodesByStoryline = useMemo(() => {
    const grouped: Record<string, BookNode[]> = {};
    storylines.forEach((s) => {
      const ids = storylineNodeMapping[s.id] ?? [];
      grouped[s.id] = ids
        .map((id) => nodeById.get(id))
        .filter((n): n is BookNode => Boolean(n))
        .sort((a, b) => a.start - b.start);
    });
    return grouped;
  }, [storylines, storylineNodeMapping, nodeById]);

  const handleCreateNode = useCallback(
    async (preferredStorylineId: string | null) => {
      try {
        let mainStorylineId = preferredStorylineId;
        if (!mainStorylineId) {
          mainStorylineId = storylines[0]?.id ?? null;
        }
        if (!mainStorylineId) {
          const createdStoryline = await createStoryline({ projectId: activeProjectId });
          mainStorylineId = createdStoryline.id;
        }

        const maxEnd = bookNodes.reduce((max, n) => Math.max(max, n.end ?? n.start), 0);
        const newStart = maxEnd + 1;
        const newEnd = newStart + 10;

        const created = await createNode({
          title: 'New Chapter',
          start: newStart,
          end: newEnd,
          mainStorylineId,
        });
        setNodeSelection(created.id, 'ui');
      } catch (error) {
        log.error('Failed to create node', error);
      }
    },
    [storylines, bookNodes, createNode, createStoryline, activeProjectId, setNodeSelection],
  );

  const handleCreateStoryline = useCallback(async () => {
    try {
      await createStoryline({ projectId: activeProjectId, name: 'New Storyline' });
    } catch (error) {
      log.error('Failed to create storyline', error);
    }
  }, [createStoryline, activeProjectId]);

  const handleDeleteNode = useCallback(
    async (id: string) => {
      try {
        await deleteNode(id);
        if (selectedNodeId === id) {
          setNodeSelection(null, 'ui');
        }
      } catch (error) {
        log.error('Failed to delete node', error);
      }
    },
    [deleteNode, selectedNodeId, setNodeSelection],
  );

  const handleSaveNodeName = useCallback(
    async (id: string) => {
      const nextName = editingNodeName.trim();
      if (!nextName) {
        setEditingNodeId(null);
        setEditingNodeName('');
        return;
      }
      try {
        await renameNode(id, nextName);
      } catch (error) {
        log.error('Failed to rename node', error);
      } finally {
        setEditingNodeId(null);
        setEditingNodeName('');
      }
    },
    [editingNodeName, renameNode],
  );

  const handleSaveStorylineName = useCallback(
    async (id: string) => {
      const existing = storylineById.get(id);
      const nextName = editingStorylineName.trim();
      if (!existing || !nextName || nextName === existing.name) {
        setEditingStorylineId(null);
        setEditingStorylineName('');
        return;
      }
      try {
        await updateStoryline({ id, name: nextName });
      } catch (error) {
        log.error('Failed to rename storyline', error);
      } finally {
        setEditingStorylineId(null);
        setEditingStorylineName('');
      }
    },
    [editingStorylineName, storylineById, updateStoryline],
  );

  const renderNodeCard = (node: BookNode) => {
    const selected = node.id === selectedNodeId;
    const storyline = storylineById.get(node.mainStorylineId);
    const color = storyline?.color || 'hsl(var(--ink-3))';

    return (
      <div
        key={node.id}
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
          setNodeSelection(node.id, 'ui');
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

        {/* Node mark — small horizontal bar tinted in the main-storyline color, echoing the timeline */}
        <span
          aria-hidden
          style={{
            width: 12,
            height: 3,
            borderRadius: 1,
            background: color,
            flexShrink: 0,
          }}
        />

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
          {editingNodeId === node.id ? (
            <input
              type="text"
              value={editingNodeName}
              onChange={(event) => setEditingNodeName(event.target.value)}
              onBlur={() => {
                void handleSaveNodeName(node.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleSaveNodeName(node.id);
                }
                if (event.key === 'Escape') {
                  setEditingNodeId(null);
                  setEditingNodeName('');
                }
              }}
              onFocus={(event) => event.target.select()}
              autoFocus
              onClick={(event) => event.stopPropagation()}
              style={{
                width: '100%',
                fontSize: 13,
                padding: '1px 4px',
                border: '1px solid hsl(var(--rule))',
                borderRadius: 3,
                background: 'hsl(var(--surface))',
                color: 'hsl(var(--ink-1))',
                outline: 'none',
              }}
            />
          ) : (
            <span
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingNodeId(node.id);
                setEditingNodeName(node.title);
              }}
              style={{ cursor: 'text' }}
            >
              {node.title || 'Untitled'}
            </span>
          )}
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
          {formatShortDate(node.updatedAt)}
        </span>

        {/* Overflow menu */}
        <div style={{ position: 'relative' }} onClick={(event) => event.stopPropagation()}>
          <button
            onClick={() => {
              setOpenMenuId(openMenuId === node.id ? null : node.id);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              borderRadius: 3,
              border: 'none',
              background: 'transparent',
              color: 'hsl(var(--ink-4))',
              cursor: 'pointer',
              padding: 0,
              opacity: openMenuId === node.id ? 1 : 0.6,
              transition: 'opacity 0.12s, background 0.12s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '1';
              e.currentTarget.style.background = 'hsl(var(--ink-1) / 0.06)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = openMenuId === node.id ? '1' : '0.6';
              e.currentTarget.style.background = 'transparent';
            }}
            title="Options"
          >
            <MoreVertical size={13} strokeWidth={1.6} />
          </button>

          {openMenuId === node.id && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                onClick={() => setOpenMenuId(null)}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 4,
                  background: 'hsl(var(--surface))',
                  border: '1px solid hsl(var(--rule))',
                  borderRadius: 6,
                  boxShadow:
                    '0 8px 24px hsl(var(--ink-1) / 0.12), 0 1px 2px hsl(var(--ink-1) / 0.06)',
                  minWidth: 120,
                  zIndex: 20,
                  overflow: 'hidden',
                }}
              >
                <button
                  onClick={() => {
                    void handleDeleteNode(node.id);
                    setOpenMenuId(null);
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    border: 'none',
                    background: 'transparent',
                    color: 'hsl(var(--destructive))',
                    fontSize: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'hsl(var(--destructive) / 0.08)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <Trash2 size={13} strokeWidth={1.6} />
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderViewToggle = () => {
    const baseStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 26,
      height: 22,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'hsl(var(--rule))',
      background: 'transparent',
      color: 'hsl(var(--ink-3))',
      cursor: 'pointer',
      padding: 0,
      transition: 'background 0.12s, color 0.12s, border-color 0.12s',
    } as const;

    const activeStyle = {
      background: 'hsl(var(--ink-1))',
      color: 'hsl(var(--paper))',
      borderColor: 'hsl(var(--ink-1))',
    } as const;

    return (
      <div style={{ display: 'inline-flex' }}>
        <button
          onClick={() => setViewMode('global')}
          title="By order"
          style={{
            ...baseStyle,
            borderRadius: '3px 0 0 3px',
            ...(viewMode === 'global' ? activeStyle : {}),
          }}
        >
          <AlignLeft size={12} strokeWidth={1.8} />
        </button>
        <button
          onClick={() => setViewMode('storyline')}
          title="By storyline"
          style={{
            ...baseStyle,
            borderRadius: '0 3px 3px 0',
            marginLeft: -1,
            ...(viewMode === 'storyline' ? activeStyle : {}),
          }}
        >
          <GitBranch size={12} strokeWidth={1.8} />
        </button>
      </div>
    );
  };

  const renderCreateButton = () => {
    const label = viewMode === 'global' ? 'New Chapter' : 'New Storyline';
    const onClick = () => {
      if (viewMode === 'global') {
        void handleCreateNode(null);
      } else {
        void handleCreateStoryline();
      }
    };

    return (
      <button
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          borderRadius: 3,
          border: '1px solid hsl(var(--rule))',
          background: 'transparent',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontWeight: 500,
          color: 'hsl(var(--ink-2))',
          cursor: 'pointer',
          transition: 'background 0.12s, border-color 0.12s, color 0.12s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'hsl(var(--ink-1))';
          e.currentTarget.style.borderColor = 'hsl(var(--ink-1))';
          e.currentTarget.style.color = 'hsl(var(--paper))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.borderColor = 'hsl(var(--rule))';
          e.currentTarget.style.color = 'hsl(var(--ink-2))';
        }}
      >
        <Plus size={11} strokeWidth={2} />
        {label}
      </button>
    );
  };

  const hasNodes = bookNodes.length > 0;
  const hasStorylines = storylines.length > 0;

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <div
        style={{
          height: panelHeight,
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 10px 8px 12px',
            borderBottom: '1px solid hsl(var(--rule))',
          }}
        >
          {renderViewToggle()}
          {renderCreateButton()}
        </div>

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
          {viewMode === 'global' && (
            <>
              {sortedNodesGlobal.map((node) => renderNodeCard(node))}
              {!hasNodes && (
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
                  no chapters yet.
                </div>
              )}
            </>
          )}

          {viewMode === 'storyline' && (
            <>
              {storylines.map((storyline) => (
                <div key={storyline.id} style={{ marginBottom: 8 }}>
                  <div
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
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 2,
                          background: storyline.color || 'hsl(var(--ink-3))',
                          flexShrink: 0,
                        }}
                      />
                      {editingStorylineId === storyline.id ? (
                        <input
                          type="text"
                          value={editingStorylineName}
                          onChange={(event) => setEditingStorylineName(event.target.value)}
                          onBlur={() => {
                            void handleSaveStorylineName(storyline.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                            if (event.key === 'Escape') {
                              setEditingStorylineId(null);
                              setEditingStorylineName('');
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
                            event.stopPropagation();
                            setEditingStorylineId(storyline.id);
                            setEditingStorylineName(storyline.name);
                          }}
                          title="Double-click to rename"
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 9.5,
                            textTransform: 'uppercase',
                            letterSpacing: '0.12em',
                            color: 'hsl(var(--ink-3))',
                            fontWeight: 500,
                            cursor: 'text',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {storyline.name}
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
                        · {(nodesByStoryline[storyline.id] ?? []).length}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 2 }}>
                      <button
                        onClick={() => navigateToStoryline(storyline.id)}
                        title="Open storyline"
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
                        <Edit3 size={12} strokeWidth={1.6} />
                      </button>

                      <button
                        onClick={() => {
                          void handleCreateNode(storyline.id);
                        }}
                        title="New chapter in this storyline"
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

                  {(nodesByStoryline[storyline.id] ?? []).map((node) => renderNodeCard(node))}
                </div>
              ))}

              {!hasStorylines && (
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
                  no storylines yet.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
