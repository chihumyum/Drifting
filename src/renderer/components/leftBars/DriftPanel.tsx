import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp } from 'lucide-react';

import type { BookNode } from '../../domain/book-node';
import { useDataStore } from '../../store/data-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';

// 宽度低于此值时隐藏 cell 上的日期，优先保证 title 显示。
const DATE_HIDE_WIDTH = 200;

const formatShortDate = (input: string | number | Date) => {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return sameYear ? `${month}/${day}` : `${d.getFullYear() % 100}/${month}/${day}`;
};

// Resting drawer sizing — purely component-local so it resets per session;
// no need for persistence layer churn.
const RESTING_MIN_HEIGHT = 80;
const RESTING_DEFAULT_HEIGHT = 200;
const RESTING_HEADER_HEIGHT = 28;

export function DriftPanel() {
  const { bookNodes } = useDataStore();
  const { nodeUi } = useUiStore();
  const sidebarWidth = useUiStore((s) => s.sidebars.left.width);
  const showDate = sidebarWidth >= DATE_HIDE_WIDTH;
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedNodeId = nodeUi.selectedId;

  // Split drift nodes by DriftStatus. Anything that isn't explicitly
  // 'resting' falls into the active list — that includes 'drifting' plus
  // legacy values like 'draft' from pre-migration rows. Sorted by recency.
  const { driftingNodes, restingNodes } = useMemo(() => {
    const drift = bookNodes
      .filter((n) => n.mainStorylineId == null)
      .slice()
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
    const resting: BookNode[] = [];
    const drifting: BookNode[] = [];
    for (const node of drift) {
      if (node.writingStatus === 'resting') resting.push(node);
      else drifting.push(node);
    }
    return { driftingNodes: drifting, restingNodes: resting };
  }, [bookNodes]);

  // Resting drawer state — collapsed by default. Height is the expanded
  // total (header + body); collapsed shows just the header strip.
  const [restingExpanded, setRestingExpanded] = useState(false);
  const [restingHeight, setRestingHeight] = useState(RESTING_DEFAULT_HEIGHT);

  // If the user empties the resting bucket, collapse the drawer so the
  // footer doesn't sit there with no content.
  useEffect(() => {
    if (restingNodes.length === 0 && restingExpanded) setRestingExpanded(false);
  }, [restingNodes.length, restingExpanded]);

  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleDragMove = useCallback((event: PointerEvent) => {
    const state = dragStateRef.current;
    if (!state) return;
    // Pointer moves down → drawer shrinks; moves up → grows.
    const delta = state.startY - event.clientY;
    const next = Math.max(RESTING_MIN_HEIGHT, state.startHeight + delta);
    setRestingHeight(next);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragStateRef.current = null;
    window.removeEventListener('pointermove', handleDragMove);
    window.removeEventListener('pointerup', handleDragEnd);
    window.removeEventListener('pointercancel', handleDragEnd);
  }, [handleDragMove]);

  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!restingExpanded) return;
      event.preventDefault();
      dragStateRef.current = { startY: event.clientY, startHeight: restingHeight };
      window.addEventListener('pointermove', handleDragMove);
      window.addEventListener('pointerup', handleDragEnd);
      window.addEventListener('pointercancel', handleDragEnd);
    },
    [handleDragEnd, handleDragMove, restingExpanded, restingHeight],
  );

  useEffect(() => {
    // Belt-and-braces: if the component unmounts mid-drag, tear down the
    // global listeners so we don't leak handlers.
    return () => {
      if (dragStateRef.current) {
        window.removeEventListener('pointermove', handleDragMove);
        window.removeEventListener('pointerup', handleDragEnd);
        window.removeEventListener('pointercancel', handleDragEnd);
      }
    };
  }, [handleDragEnd, handleDragMove]);

  const renderNodeCard = (node: BookNode, opts?: { muted?: boolean }) => {
    const selected = node.id === selectedNodeId;
    const muted = opts?.muted ?? false;
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
          color: selected
            ? 'hsl(var(--ink-1))'
            : muted
              ? 'hsl(var(--ink-3))'
              : 'hsl(var(--ink-2))',
          fontSize: 12.5,
          lineHeight: 1.35,
          opacity: muted && !selected ? 0.7 : 1,
          transition: 'background 0.1s, opacity 0.1s',
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
            background: muted ? 'hsl(var(--ink-4) / 0.3)' : 'transparent',
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

        {showDate && (
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
        )}
      </div>
    );
  };

  const showRestingFooter = restingNodes.length > 0;
  const footerHeight = restingExpanded ? restingHeight : RESTING_HEADER_HEIGHT;
  const totalDrift = driftingNodes.length + restingNodes.length;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        className="left-panel-scroll-hidden"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '6px 0 12px',
        }}
      >
        {driftingNodes.map((node) => renderNodeCard(node))}
        {totalDrift === 0 && (
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
        {driftingNodes.length === 0 && restingNodes.length > 0 && (
          <div
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              color: 'hsl(var(--ink-3))',
              padding: '28px 20px 8px',
              textAlign: 'center',
            }}
          >
            no active drifts · {restingNodes.length} resting below
          </div>
        )}
      </div>

      {showRestingFooter && (
        <div
          style={{
            height: footerHeight,
            borderTop: '1px solid hsl(var(--rule))',
            background: 'hsl(var(--paper-deep) / 0.5)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: RESTING_HEADER_HEIGHT,
            // Smooth the open/close toggle, but skip transitions while
            // actively drag-resizing so the cursor stays glued to the edge.
            transition: dragStateRef.current ? 'none' : 'height 0.18s ease',
            flexShrink: 0,
          }}
        >
          {/* Drag handle — only meaningful when expanded. Kept on top of
              the header so the visible affordance lines up with the seam
              between scroll list and footer. */}
          <div
            onPointerDown={handleDragStart}
            style={{
              height: 4,
              marginTop: -2,
              cursor: restingExpanded ? 'ns-resize' : 'default',
              userSelect: 'none',
            }}
            aria-hidden
          />
          <button
            type="button"
            onClick={() => setRestingExpanded((prev) => !prev)}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              height: RESTING_HEADER_HEIGHT - 4,
              padding: '0 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              cursor: 'pointer',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'hsl(var(--ink-3))',
              fontFamily: 'var(--font-mono)',
              flexShrink: 0,
            }}
            aria-expanded={restingExpanded}
            title={restingExpanded ? '收起休眠' : '展开休眠'}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>休眠</span>
              <span style={{ color: 'hsl(var(--ink-4))' }}>{restingNodes.length}</span>
            </span>
            <ChevronUp
              size={12}
              style={{
                transform: restingExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.18s ease',
              }}
            />
          </button>
          {restingExpanded && (
            <div
              className="left-panel-scroll-hidden"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: '4px 0 12px',
              }}
            >
              {restingNodes.map((node) => renderNodeCard(node, { muted: true }))}
            </div>
          )}
        </div>
      )}

      <style>{`
        .left-panel-scroll-hidden { scrollbar-width: none; }
        .left-panel-scroll-hidden::-webkit-scrollbar { width: 0; height: 0; display: none; }
      `}</style>
    </div>
  );
}
