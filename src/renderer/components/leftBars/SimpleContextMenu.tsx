import type { ReactNode } from 'react';
import { ContextMenuSurface } from '../ui/ContextMenuSurface';

// A lightweight, generic portal menu for the left sidebar — used by the drift
// panel's group-header context menu and its "move to group" picker. Mirrors
// EntityCellContextMenu's portal-to-body + viewport-clamp + outside-click/Esc
// dismissal, but renders a caller-supplied item list with per-item onClick
// instead of the entity-action machinery (drift groups aren't an EditorType).
export interface SimpleMenuItem {
  key: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  // Left indent in px — used by the move picker to render the group tree.
  indent?: number;
  // Optional trailing slot (e.g. a ✓ on the current group).
  trailing?: ReactNode;
  // Render a divider above this item.
  dividerBefore?: boolean;
}

export interface SimpleContextMenuProps {
  x: number;
  y: number;
  items: SimpleMenuItem[];
  onClose: () => void;
  // Optional non-interactive label rendered at the top (e.g. "移动到分组").
  title?: string;
}

export function SimpleContextMenu({ x, y, items, onClose, title }: SimpleContextMenuProps) {
  if (items.length === 0) return null;

  return (
    <ContextMenuSurface
      x={x}
      y={y}
      onClose={onClose}
      className="menu-surface--standard"
      style={{ maxHeight: '60vh' }}
    >
      {title && <div className="menu-surface__section-label">{title}</div>}
      {items.map((item) => (
        <div key={item.key}>
          {item.dividerBefore && <div className="menu-surface__divider" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`menu-surface__item${item.danger ? ' menu-surface__item--danger' : ''}`}
            style={{
              ...(item.indent ? { paddingLeft: 10 + item.indent } : null),
              ...(item.disabled ? { opacity: 0.45, cursor: 'default' } : null),
              ...(item.trailing
                ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
                : null),
            }}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.label}
            </span>
            {item.trailing}
          </button>
        </div>
      ))}
    </ContextMenuSurface>
  );
}
