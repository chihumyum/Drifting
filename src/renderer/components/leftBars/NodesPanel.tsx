import { useState, useMemo, useCallback, useEffect } from 'react';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';
import loglevel from 'loglevel';

import type { BookNode } from '../../domain/book-node';
import { useDataStore } from '../../store/data-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';

const log = loglevel.getLogger('NodesPanel');
log.setLevel(loglevel.levels.ERROR);

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
  const { nodeUi } = useUiStore();
  const viewMode = useUiStore((s) => s.nodesPanelViewMode);
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedNodeId = nodeUi.selectedId;

  const activeProjectId = useMemo(() => {
    if (!projectId) {
      throw new Error('NodesPanel requires a non-empty projectId');
    }
    return projectId;
  }, [projectId]);

  const { createNode } = useBookNode({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const { createStoryline, updateStoryline } = useStoryline({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const [editingStorylineId, setEditingStorylineId] = useState<string | null>(null);
  const [editingStorylineName, setEditingStorylineName] = useState('');
  const [collapsedStorylineIds, setCollapsedStorylineIds] = useState<Set<string>>(new Set());

  const toggleStorylineCollapsed = useCallback((id: string) => {
    setCollapsedStorylineIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Sub-header broadcasts a collapse-all request. Toggle between "all open"
  // and "all collapsed" based on current state.
  useEffect(() => {
    const handler = () => {
      setCollapsedStorylineIds((prev) => {
        if (prev.size === 0) {
          return new Set(storylines.map((s) => s.id));
        }
        return new Set();
      });
    };
    events.on('left-sidebar:collapse-all', handler);
    return () => events.off('left-sidebar:collapse-all', handler);
  }, [storylines]);

  const storylineById = useMemo(
    () => new Map(storylines.map((s) => [s.id, s])),
    [storylines],
  );
  const nodeById = useMemo(() => new Map(bookNodes.map((n) => [n.id, n])), [bookNodes]);

  const sortedNodesGlobal = useMemo(
    () =>
      bookNodes
        .filter((n) => n.mainStorylineId != null)
        .slice()
        .sort((a, b) => a.bookOrder - b.bookOrder),
    [bookNodes],
  );

  const nodesByStoryline = useMemo(() => {
    const grouped: Record<string, BookNode[]> = {};
    storylines.forEach((s) => {
      const ids = storylineNodeMapping[s.id] ?? [];
      grouped[s.id] = ids
        .map((id) => nodeById.get(id))
        .filter((n): n is BookNode => Boolean(n))
        .sort((a, b) => a.bookOrder - b.bookOrder);
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

        const maxOrder = bookNodes.reduce((max, n) => Math.max(max, n.bookOrder), 0);
        const nextOrder = maxOrder + 1;

        const created = await createNode({
          title: 'New Chapter',
          bookOrder: nextOrder,
          mainStorylineId,
        });
        openEntity({ entityType: 'node', id: created.id }, { preview: false });
      } catch (error) {
        log.error('Failed to create node', error);
      }
    },
    [storylines, bookNodes, createNode, createStoryline, activeProjectId, openEntity],
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

  const renderNodeCard = (node: BookNode, numbered?: { num: number }) => {
    const selected = node.id === selectedNodeId;
    const storyline = node.mainStorylineId ? storylineById.get(node.mainStorylineId) : undefined;
    const color = storyline?.color || 'hsl(var(--ink-3))';

    return (
      <div
        key={node.id}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 14px 5px 22px',
          cursor: 'pointer',
          position: 'relative',
          background: selected ? 'hsl(var(--accent) / 0.10)' : 'transparent',
          color: selected ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
          fontSize: 12.5,
          lineHeight: 1.35,
          transition: 'background 0.1s',
        }}
        onMouseEnter={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'hsl(var(--ink-1) / 0.03)';
          }
        }}
        onMouseLeave={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'transparent';
          }
        }}
        onClick={() => {
          openEntity({ entityType: 'node', id: node.id });
        }}
        onDoubleClick={() => {
          promoteCurrentTab();
        }}
      >
        {selected && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: 4,
              bottom: 4,
              width: 2,
              background: 'hsl(var(--accent))',
            }}
          />
        )}

        {numbered ? (
          <span
            aria-hidden
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'hsl(var(--ink-4))',
              width: 18,
              flexShrink: 0,
              letterSpacing: 0,
            }}
          >
            {numbered.num.toString().padStart(2, '0')}
          </span>
        ) : (
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
        )}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: 'inherit',
            fontWeight: selected ? 500 : 400,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span>{node.title || 'Untitled'}</span>
        </div>

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
      </div>
    );
  };

  const hasNodes = bookNodes.length > 0;
  const hasStorylines = storylines.length > 0;

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '6px 0 24px',
      }}
    >
      {viewMode === 'global' && (
        <>
          {sortedNodesGlobal.map((node, idx) => renderNodeCard(node, { num: idx + 1 }))}
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
          {storylines.map((storyline) => {
            const sNodes = nodesByStoryline[storyline.id] ?? [];
            const collapsed = collapsedStorylineIds.has(storyline.id);
            const color = storyline.color || 'hsl(var(--ink-4))';
            return (
              <div
                key={storyline.id}
                className="left-sb-group"
                style={{ marginBottom: 10 }}
              >
                <div
                  onClick={() => openEntity({ entityType: 'storyline', id: storyline.id })}
                  onDoubleClick={() => promoteCurrentTab()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 12px 4px 14px',
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 0,
                      flex: 1,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9.5,
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                      color: 'hsl(var(--ink-3))',
                    }}
                  >
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleStorylineCollapsed(storyline.id);
                      }}
                      title={collapsed ? 'Expand' : 'Collapse'}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 14,
                        height: 14,
                        border: 'none',
                        background: 'transparent',
                        color: 'hsl(var(--ink-4))',
                        cursor: 'pointer',
                        padding: 0,
                        flexShrink: 0,
                      }}
                    >
                      {collapsed ? (
                        <ChevronRight size={11} strokeWidth={2} />
                      ) : (
                        <ChevronDown size={11} strokeWidth={2} />
                      )}
                    </button>
                    <span
                      aria-hidden
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 2,
                        background: color,
                        flexShrink: 0,
                      }}
                    />
                    {editingStorylineId === storyline.id ? (
                      <input
                        type="text"
                        value={editingStorylineName}
                        onChange={(event) => setEditingStorylineName(event.target.value)}
                        onBlur={() => void handleSaveStorylineName(storyline.id)}
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
                          minWidth: 100,
                          fontSize: 10,
                          fontFamily: 'var(--font-mono)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.12em',
                          color: 'hsl(var(--ink-2))',
                          padding: '1px 4px',
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
                      · {sNodes.length}
                    </span>
                  </div>

                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCreateNode(storyline.id);
                    }}
                    title="New chapter in this storyline"
                    className="left-sb-group-add"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 18,
                      height: 18,
                      borderRadius: 3,
                      border: 'none',
                      background: 'transparent',
                      color: 'hsl(var(--ink-4))',
                      cursor: 'pointer',
                      padding: 0,
                      opacity: 0,
                      transition: 'opacity 0.12s, background 0.12s, color 0.12s',
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
                    <Plus size={12} strokeWidth={1.6} />
                  </button>
                </div>

                {!collapsed && sNodes.map((node) => renderNodeCard(node))}
              </div>
            );
          })}

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

      {/* Reveal the per-group + button on hover (no extra chrome at rest). */}
      <style>{`
        .left-sb-group:hover .left-sb-group-add { opacity: 1; }
      `}</style>
    </div>
  );
}
