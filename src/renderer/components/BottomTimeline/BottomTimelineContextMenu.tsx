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

function menuButtonStyle(color = '#2a1a0a'): React.CSSProperties {
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
  hoverBg = 'var(--accent-hover, #f5f0e8)',
  color = '#2a1a0a',
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
            background: t.color || 'var(--accent, #b89968)',
            color: '#fff',
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
        background: '#fefdfb',
        border: '1px solid var(--accent-border, #e8dcc8)',
        borderRadius: 8,
        boxShadow: '0 4px 12px rgba(42, 26, 10, 0.15)',
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
              borderBottom: '1px solid var(--accent-border, #e8dcc8)',
              background: '#f9f6f1',
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#2a1a0a',
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
                  color: '#5a4a3a',
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
          {renderMenuButton('🗑️ Delete Entire Node', 'deleteNode', onAction, '#fff0f0', '#c04040')}
        </>
      )}
    </div>
  );
}
