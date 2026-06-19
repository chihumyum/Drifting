import { useMemo, useState } from 'react';

import { isDrift, type BookNode } from '../../domain/book-node';
import { useDataStore } from '../../store/data-store';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { EntityCellContextMenu } from './EntityCellContextMenu';
import { PanelHoverPreview, useHoverPreview } from './PanelHoverPreview';
import { AgentCountBadge } from './AgentCountBadge';
import { aggregateActivity } from './agentActivityBubble';
import { CollapsibleFooter } from '../ui/CollapsibleFooter';
import { useEntityCellAction } from '../../hooks/useEntityCellAction';
import { entityKey } from '../../lib/agent/tool-entity-ref';

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

export function DriftPanel() {
  const { bookNodes } = useDataStore();
  const { nodeUi } = useUiStore();
  const sidebarWidth = useUiStore((s) => s.sidebars.left.width);
  const showDate = sidebarWidth >= DATE_HIDE_WIDTH;
  const sortMode = useUiStore((s) => s.driftSortMode);
  const { projectId, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const selectedNodeId = nodeUi.selectedId;
  const agentActive = useAgentActivityStore((s) => s.active);
  const agentTouched = useAgentActivityStore((s) => s.touched);
  // Persisted pending agent edits — keeps "M" visible after a reload.
  const agentPending = useAgentEditStore((s) => s.pending);

  // Split drift nodes by DriftStatus. Anything that isn't explicitly
  // 'resting' falls into the active list — that includes 'drifting' plus
  // legacy values like 'draft' from pre-migration rows. Sort key is driven
  // by the SortMenu in the sub-header; createdAt is the default since
  // updatedAt gets bumped by wordCount sync and other materialized-field
  // writes on open (which would reorder the list just from clicking around).
  const { driftingNodes, restingNodes } = useMemo(() => {
    const cmp = (a: BookNode, b: BookNode) => {
      if (sortMode === 'title') {
        return (a.title || '').localeCompare(b.title || '', undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      }
      const key = sortMode === 'updatedAt' ? 'updatedAt' : 'createdAt';
      const av = a[key];
      const bv = b[key];
      if (av === bv) return 0;
      return bv > av ? 1 : -1;
    };
    const drift = bookNodes.filter(isDrift).slice().sort(cmp);
    const resting: BookNode[] = [];
    const drifting: BookNode[] = [];
    for (const node of drift) {
      if (node.writingStatus === 'resting') resting.push(node);
      else drifting.push(node);
    }
    return { driftingNodes: drifting, restingNodes: resting };
  }, [bookNodes, sortMode]);

  // Per-cell context menu — reuses the editor top-bar three-dot menu items
  // via EntityCellContextMenu so drift context options match the editor.
  const dispatchEntityAction = useEntityCellAction();
  const [contextMenu, setContextMenu] = useState<
    | { x: number; y: number; nodeId: string; writingStatus: BookNode['writingStatus'] }
    | null
  >(null);
  // Hover summary card (same affordance as the element panel's).
  const {
    preview: hoverPreview,
    onEnter: hoverEnter,
    onLeave: hoverLeave,
  } = useHoverPreview<BookNode>();

  const renderNodeCard = (node: BookNode, opts?: { muted?: boolean }) => {
    const selected = node.id === selectedNodeId;
    const agentBusy = `node:${node.id}` in agentActive;
    const agentChanged =
      !agentBusy && (`node:${node.id}` in agentTouched || `node:${node.id}` in agentPending);
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
          hoverEnter(node, event.currentTarget.getBoundingClientRect());
        }}
        onMouseLeave={(event) => {
          if (!selected) {
            event.currentTarget.style.background = 'transparent';
          }
          hoverLeave();
        }}
        onClick={() => {
          hoverLeave();
          if (agentChanged) useAgentActivityStore.getState().clearTouched('node', node.id);
          openEntity({ entityType: 'node', id: node.id });
        }}
        onDoubleClick={() => {
          promoteCurrentTab();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          hoverLeave();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            nodeId: node.id,
            writingStatus: node.writingStatus,
          });
        }}
      >
        {selected && (
          <span
            aria-hidden
            className="cell-accent-stripe"
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

        {/* Drift mark — ❦ glyph, sized to the same 12px-wide chrome slot the
            chapter stripe / element diamond use so the three left-panel
            cells line up visually. The leading icon was the drift tab's
            glyph before it moved here; the tab itself now wears a
            different glyph. */}
        <span
          aria-hidden
          className={agentBusy ? 'agent-glyph-busy' : undefined}
          title={agentBusy ? 'Agent 正在处理' : agentChanged ? 'Agent 刚改动了这里' : undefined}
          style={{
            // Done swaps the ❦ mark for a plain mono "M" marker; working/rest
            // keep the italic serif mark.
            fontFamily: agentChanged ? 'var(--font-mono)' : 'var(--font-serif)',
            fontStyle: agentChanged ? 'normal' : 'italic',
            fontSize: agentChanged ? 10 : 11,
            fontWeight: agentChanged ? 600 : undefined,
            // Agent status overrides the mark's resting tint: accent (lit) while
            // working, muted ink for the done "M". At rest, the ❦ tint.
            color: agentBusy
              ? 'hsl(var(--accent))'
              : agentChanged
                ? 'hsl(var(--ink-2))'
                : muted
                  ? 'hsl(var(--ink-4))'
                  : 'hsl(var(--ink-3))',
            flexShrink: 0,
            lineHeight: 1,
            width: 12,
            textAlign: 'center',
          }}
        >
          {agentChanged ? 'M' : '❦'}
        </span>

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

  const totalDrift = driftingNodes.length + restingNodes.length;

  // Agent activity rolled up over resting drifts — surfaced on the footer
  // header (as a badge or busy glyph) so changes hidden inside the
  // (default-collapsed) drawer still register (#17).
  const restingActivity = aggregateActivity(
    agentActive,
    agentTouched,
    restingNodes.map((n) => entityKey('node', n.id)),
  );
  const restingHeaderExtra =
    !restingActivity.busy && restingActivity.doneCount > 0 ? (
      <AgentCountBadge count={restingActivity.doneCount} title="未查看的 Agent 改动" />
    ) : restingActivity.busy ? (
      <span
        aria-hidden
        className="agent-glyph-busy"
        title="Agent 正在处理"
        style={{
          width: 7,
          height: 7,
          borderRadius: 2,
          background: 'hsl(var(--accent))',
          flexShrink: 0,
        }}
      />
    ) : null;

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

      {/* Resting footer is always visible so the user has a permanent
          affordance to park / surface resting drifts, regardless of whether
          there's anything resting at the moment. Expanding into an empty list
          is fine — it shows a "no resting drifts" placeholder. */}
      <CollapsibleFooter
        label="休眠"
        count={restingNodes.length}
        headerExtra={restingHeaderExtra}
        expandTitle="展开休眠"
        collapseTitle="收起休眠"
        bodyStyle={{ padding: '4px 0 12px' }}
      >
        {restingNodes.length > 0 ? (
          restingNodes.map((node) => renderNodeCard(node, { muted: true }))
        ) : (
          <div
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              color: 'hsl(var(--ink-4))',
              padding: '16px 20px',
              textAlign: 'center',
            }}
          >
            no resting drifts.
          </div>
        )}
      </CollapsibleFooter>

      {hoverPreview && (
        <PanelHoverPreview
          glyph="❦"
          accentColor="hsl(var(--ink-3))"
          title={hoverPreview.data.title}
          summary={hoverPreview.data.summary}
          top={hoverPreview.top}
          left={hoverPreview.left}
        />
      )}

      {contextMenu && (
        <EntityCellContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          editorType="node"
          nodeStatusKind="drift"
          nodeWritingStatus={contextMenu.writingStatus}
          onAction={(action) => {
            void dispatchEntityAction({
              entityType: 'node',
              id: contextMenu.nodeId,
              action,
            });
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      <style>{`
        .left-panel-scroll-hidden { scrollbar-width: none; }
        .left-panel-scroll-hidden::-webkit-scrollbar { width: 0; height: 0; display: none; }
      `}</style>
    </div>
  );
}
