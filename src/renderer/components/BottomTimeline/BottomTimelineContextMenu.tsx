import type { Storyline } from '../../domain/storyline';
import type { BottomTimelineContextMenuAction, BottomTimelineContextMenuState } from './types';

interface BottomTimelineContextMenuProps {
  contextMenu: BottomTimelineContextMenuState | null;
  contextMenuRef: React.RefObject<HTMLDivElement | null>;
  getContextMenuPosition: (
    x: number,
    y: number,
    menuWidth: number,
    menuHeight: number,
  ) => { x: number; y: number };
  onAction: (action: BottomTimelineContextMenuAction) => void;
  // Narrative-mode flag. Only when true does the "回未放置" detach
  // action appear, since it's a no-op in book view (bookOrder is always
  // set and the lane has no concept of "unplaced").
  isNarrative: boolean;
  // Whether the active node (when contextMenu.type === 'node') actually
  // has a narrativeOrder we can clear. When null, the detach action is
  // already done — no point offering it.
  selectedNodeHasNarrativeOrder?: boolean;
}

interface MenuItemProps {
  glyph: string;
  label: string;
  action: BottomTimelineContextMenuAction;
  onAction: (action: BottomTimelineContextMenuAction) => void;
  variant?: 'default' | 'danger';
}

function MenuItem({ glyph, label, action, onAction, variant = 'default' }: MenuItemProps) {
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

function StorylineTags({ storylines }: { storylines: Storyline[] }) {
  if (storylines.length === 0) return null;
  return (
    <div className="btl-cmenu__tags">
      {storylines.map((sl) => (
        <span
          key={sl.id}
          className="btl-cmenu__tag"
          style={{ background: sl.color || 'hsl(var(--accent))' }}
        >
          {sl.name || 'Untitled'}
        </span>
      ))}
    </div>
  );
}

export function BottomTimelineContextMenu({
  contextMenu,
  contextMenuRef,
  getContextMenuPosition,
  onAction,
  isNarrative,
  selectedNodeHasNarrativeOrder,
}: BottomTimelineContextMenuProps) {
  if (!contextMenu) return null;

  // The exact menu height isn't critical — getContextMenuPosition uses it
  // only to nudge the menu inside the viewport. Slightly overestimate so
  // the menu never overflows at the bottom edge of the screen.
  const menuWidth = 260;
  let menuHeight = 60;
  if (contextMenu.type === 'node') {
    menuHeight = 180;
    if (contextMenu.nodeSummary) menuHeight += 36;
    if (contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 0) menuHeight += 28;
    if (contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 1) menuHeight += 32;
    if (isNarrative && selectedNodeHasNarrativeOrder) menuHeight += 32;
  } else if (contextMenu.type === 'storyline' && contextMenu.canAddCurrentNode) {
    menuHeight = 96;
  }

  const position = getContextMenuPosition(contextMenu.x, contextMenu.y, menuWidth, menuHeight);

  return (
    <div
      ref={contextMenuRef}
      className="btl-cmenu"
      onClick={(e) => e.stopPropagation()}
      style={{ left: position.x, top: position.y }}
    >
      {contextMenu.type === 'storyline' && (
        <div className="btl-cmenu__group">
          <MenuItem glyph="✶" label="新建章节" action="createChapter" onAction={onAction} />
          {contextMenu.canAddCurrentNode && (
            <MenuItem
              glyph="↳"
              label="把当前章节加入此 storyline"
              action="addToStoryline"
              onAction={onAction}
            />
          )}
        </div>
      )}

      {contextMenu.type === 'node' && (
        <>
          <div className="btl-cmenu__head">
            <div className="btl-cmenu__title">{contextMenu.nodeTitle || '未命名'}</div>
            {contextMenu.nodeSummary && (
              <div className="btl-cmenu__summary">{contextMenu.nodeSummary}</div>
            )}
            {contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 0 && (
              <StorylineTags storylines={contextMenu.nodeStorylines} />
            )}
          </div>

          <div className="btl-cmenu__group">
            <MenuItem glyph="✎" label="编辑章节" action="editChapter" onAction={onAction} />
            {contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 1 && (
              <MenuItem
                glyph="⊖"
                label="从此 storyline 移除"
                action="removeFromStoryline"
                onAction={onAction}
              />
            )}
            {isNarrative && selectedNodeHasNarrativeOrder && (
              <MenuItem
                glyph="↺"
                label="回到未放置"
                action="detachFromNarrative"
                onAction={onAction}
              />
            )}
          </div>

          <div className="btl-cmenu__group">
            <MenuItem
              glyph="×"
              label="删除整个章节"
              action="deleteNode"
              onAction={onAction}
              variant="danger"
            />
          </div>
        </>
      )}
    </div>
  );
}
