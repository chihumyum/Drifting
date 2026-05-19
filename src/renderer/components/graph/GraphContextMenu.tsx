import { useLayoutEffect, useState } from 'react';
import type { Storyline } from '../../domain/storyline';
// Reuse the BottomTimeline context-menu CSS — the visual aesthetic is
// shared, and the file is small enough that duplicating selectors here
// would be churn for no gain.
import '../../../styles/bottom-timeline.css';

export interface GraphContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  nodeTitle?: string | null;
  nodeSummary?: string | null;
  nodeStorylines?: Storyline[];
  // Whether the node currently has a narrativeOrder. Drives whether the
  // "回到未放置" detach action is offered.
  hasNarrativeOrder: boolean;
  // The storyline rendered as this node's row in graph view. Needed by
  // the "从主故事线移除" action.
  mainStorylineId: string | null;
}

export type GraphContextMenuAction =
  | 'editChapter'
  | 'startEdgeFrom'
  | 'deleteAllEdges'
  | 'detachFromNarrative'
  | 'removeFromMainStoryline'
  | 'deleteNode';

interface Props {
  state: GraphContextMenuState;
  menuRef: React.RefObject<HTMLDivElement | null>;
  edgeCountForNode: number;
  isNarrative: boolean;
  onAction: (action: GraphContextMenuAction) => void;
  onClose: () => void;
}

interface ItemProps {
  glyph: string;
  label: string;
  action: GraphContextMenuAction;
  onAction: (action: GraphContextMenuAction) => void;
  variant?: 'default' | 'danger';
}

function Item({ glyph, label, action, onAction, variant = 'default' }: ItemProps) {
  return (
    <button
      type="button"
      className={`btl-cmenu__item${variant === 'danger' ? ' is-danger' : ''}`}
      onClick={() => onAction(action)}
    >
      <span className="btl-cmenu__glyph" aria-hidden>
        {glyph}
      </span>
      <span className="btl-cmenu__label">{label}</span>
    </button>
  );
}

export function GraphContextMenu({
  state,
  menuRef,
  edgeCountForNode,
  isNarrative,
  onAction,
}: Props) {
  // Nudge the menu inside the viewport after first render — same idea as
  // the timeline menu's getContextMenuPosition helper, but measured from
  // the real menu element so it works regardless of which actions appear.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: state.x, top: state.y });
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const pad = 8;
    let left = state.x;
    let top = state.y;
    if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
    if (top + rect.height + pad > window.innerHeight)
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    setPos({ left, top });
  }, [menuRef, state.x, state.y]);

  const hasMultipleStorylines = (state.nodeStorylines?.length ?? 0) > 1;

  return (
    <div
      ref={menuRef}
      className="btl-cmenu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="btl-cmenu__head">
        <div className="btl-cmenu__title">{state.nodeTitle || '未命名'}</div>
        {state.nodeSummary && <div className="btl-cmenu__summary">{state.nodeSummary}</div>}
        {state.nodeStorylines && state.nodeStorylines.length > 0 && (
          <div className="btl-cmenu__tags">
            {state.nodeStorylines.map((sl) => (
              <span
                key={sl.id}
                className="btl-cmenu__tag"
                style={{ background: sl.color || 'hsl(var(--accent))' }}
              >
                {sl.name || 'Untitled'}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="btl-cmenu__group">
        <Item glyph="✎" label="编辑章节" action="editChapter" onAction={onAction} />
        {isNarrative && state.hasNarrativeOrder && (
          <Item glyph="↺" label="回到未放置" action="detachFromNarrative" onAction={onAction} />
        )}
        {hasMultipleStorylines && state.mainStorylineId && (
          <Item
            glyph="⊖"
            label="从主故事线移除"
            action="removeFromMainStoryline"
            onAction={onAction}
          />
        )}
      </div>

      <div className="btl-cmenu__group">
        <Item glyph="↔" label="从此节点新建关联" action="startEdgeFrom" onAction={onAction} />
        {edgeCountForNode > 0 && (
          <Item
            glyph="⌫"
            label={`删除此节点的所有关联 (${edgeCountForNode})`}
            action="deleteAllEdges"
            onAction={onAction}
            variant="danger"
          />
        )}
      </div>

      <div className="btl-cmenu__group">
        <Item glyph="×" label="删除整个章节" action="deleteNode" onAction={onAction} variant="danger" />
      </div>
    </div>
  );
}
