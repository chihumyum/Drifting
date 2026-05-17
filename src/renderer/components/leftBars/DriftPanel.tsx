import { useMemo, useCallback } from 'react';
import { Plus } from 'lucide-react';
import loglevel from 'loglevel';

import type { BookNode } from '../../domain/book-node';
import { useDataStore } from '../../store/data-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useBookNode } from '../../usecase/useBookNode';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';

const log = loglevel.getLogger('DriftPanel');
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

export function DriftPanel() {
  const { bookNodes } = useDataStore();
  const { nodeUi, timelineHeight } = useUiStore();
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedNodeId = nodeUi.selectedId;

  const activeProjectId = useMemo(() => {
    if (!projectId) throw new Error('DriftPanel requires a non-empty projectId');
    return projectId;
  }, [projectId]);

  const { createNode } = useBookNode({
    projectId: activeProjectId,
    userId: userId ?? '',
  });

  const panelHeight = useMemo(() => `calc(100vh - 120px - ${timelineHeight}px)`, [timelineHeight]);

  // Drift nodes are book nodes with no main storyline membership.
  // We sort by recency since drift is for inspiration/notes, not chapter order.
  const driftNodes = useMemo(
    () =>
      bookNodes
        .filter((n) => n.mainStorylineId == null)
        .slice()
        .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)),
    [bookNodes],
  );

  const handleCreateDrift = useCallback(async () => {
    try {
      // Drift nodes are off-timeline. We still write a `start` because the
      // column is NOT NULL; using a value beyond the regular range keeps the
      // domain invariant satisfied without colliding with on-timeline nodes.
      const maxEnd = bookNodes.reduce((max, n) => Math.max(max, n.end ?? n.start), 0);
      const newStart = maxEnd + 1;
      const created = await createNode({
        title: 'New Drift',
        start: newStart,
        end: newStart,
        mainStorylineId: null,
      });
      openEntity({ entityType: 'node', id: created.id }, { preview: false });
    } catch (error) {
      log.error('Failed to create drift node', error);
    }
  }, [bookNodes, createNode, openEntity]);

  const renderNodeCard = (node: BookNode) => {
    const selected = node.id === selectedNodeId;
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
              top: 5,
              bottom: 5,
              width: 2,
              background: 'hsl(var(--accent))',
            }}
          />
        )}

        {/* Drift marker — open dot, distinct from storyline-colored bar in NodesPanel */}
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            border: '1px solid hsl(var(--ink-3))',
            background: 'transparent',
            flexShrink: 0,
          }}
        />

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

  const renderCreateButton = () => (
    <button
      onClick={() => void handleCreateDrift()}
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
      New Drift
    </button>
  );

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
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: 'hsl(var(--ink-3))',
              fontWeight: 500,
            }}
          >
            Drift · {driftNodes.length}
          </span>
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
          {driftNodes.map((node) => renderNodeCard(node))}
          {driftNodes.length === 0 && (
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
              no drift notes yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
