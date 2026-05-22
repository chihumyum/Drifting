import { useMemo } from 'react';

import type { BookNode } from '../../domain/book-node';
import { useDataStore } from '../../store/data-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';

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
  const { nodeUi } = useUiStore();
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedNodeId = nodeUi.selectedId;

  // Drift nodes — off-timeline notes, sorted by recency.
  const driftNodes = useMemo(
    () =>
      bookNodes
        .filter((n) => n.mainStorylineId == null)
        .slice()
        .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)),
    [bookNodes],
  );

  const renderNodeCard = (node: BookNode) => {
    const selected = node.id === selectedNodeId;
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

  return (
    <div
      className="left-panel-scroll-hidden"
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '6px 0 24px',
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
      <style>{`
        .left-panel-scroll-hidden { scrollbar-width: none; }
        .left-panel-scroll-hidden::-webkit-scrollbar { width: 0; height: 0; display: none; }
      `}</style>
    </div>
  );
}
