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
}

function menuButtonStyle(color = 'hsl(var(--ink-1))'): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '8px 16px',
    background: 'transparent',
    border: 'none',
    color,
    fontSize: 14,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background-color 0.2s',
  };
}

function renderMenuButton(
  label: string,
  action: BottomTimelineContextMenuAction,
  onAction: (action: BottomTimelineContextMenuAction) => void,
  hoverBg = 'hsl(var(--paper-deep))',
  color = 'hsl(var(--ink-1))',
) {
  return (
    <button
      onClick={() => onAction(action)}
      style={menuButtonStyle(color)}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = hoverBg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
    </button>
  );
}

function renderStorylineTags(storylines: Storyline[]) {
  if (storylines.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        marginTop: 8,
        flexWrap: 'wrap',
      }}
    >
      {storylines.map((t) => (
        <span
          key={t.id}
          style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 4,
            background: t.color || 'hsl(var(--accent))',
            color: 'hsl(var(--paper))',
            fontWeight: 500,
          }}
        >
          {t.name}
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
}: BottomTimelineContextMenuProps) {
  if (!contextMenu) return null;

  const menuWidth = 320;
  let menuHeight = 60;
  if (contextMenu.type === 'node') {
    menuHeight = 200;
    if (contextMenu.nodeSummary) menuHeight += 40;
    if (contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 0) menuHeight += 30;
    if (contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 1) menuHeight += 40;
  } else if (contextMenu.type === 'storyline' && contextMenu.canAddCurrentNode) {
    menuHeight = 100;
  }

  const position = getContextMenuPosition(contextMenu.x, contextMenu.y, menuWidth, menuHeight);

  return (
    <div
      ref={contextMenuRef}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        background: 'hsl(var(--surface))',
        border: '1px solid hsl(var(--rule))',
        borderRadius: 8,
        boxShadow: '0 8px 24px hsl(var(--ink-1) / 0.12), 0 1px 2px hsl(var(--ink-1) / 0.06)',
        minWidth: 200,
        maxWidth: 320,
        zIndex: 1000,
        overflow: 'hidden',
      }}
    >
      {contextMenu.type === 'storyline' && (
        <>
          {renderMenuButton('➕ Add New Node', 'createChapter', onAction)}
          {contextMenu.canAddCurrentNode &&
            renderMenuButton('➕ Add to Storyline', 'addToStoryline', onAction)}
        </>
      )}

      {contextMenu.type === 'node' && (
        <>
          <div
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid hsl(var(--rule))',
              background: 'hsl(var(--paper-deep))',
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'hsl(var(--ink-1))',
                marginBottom: 6,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {contextMenu.nodeTitle}
            </div>

            {contextMenu.nodeSummary && (
              <div
                style={{
                  fontSize: 11,
                  color: 'hsl(var(--ink-3))',
                  lineHeight: 1.4,
                  maxHeight: 60,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                {contextMenu.nodeSummary}
              </div>
            )}

            {contextMenu.nodeStorylines && renderStorylineTags(contextMenu.nodeStorylines)}
          </div>

          {renderMenuButton('✏️ Edit Chapter', 'editChapter', onAction)}
          {contextMenu.nodeStorylines &&
            contextMenu.nodeStorylines.length > 1 &&
            renderMenuButton('➖ Remove Node from Storyline', 'removeFromStoryline', onAction)}
          {renderMenuButton('🗑️ Delete Entire Node', 'deleteNode', onAction, 'hsl(var(--destructive) / 0.08)', 'hsl(var(--destructive))')}
        </>
      )}
    </div>
  );
}
