import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 6;
    let left = x;
    let top = y;
    if (left + rect.width + pad > window.innerWidth) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height + pad > window.innerHeight) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(event.target as Node)) return;
      onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  if (items.length === 0) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="editor-bar__menu"
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        right: 'auto',
        bottom: 'auto',
        zIndex: 10000,
        margin: 0,
        maxHeight: '60vh',
        overflowY: 'auto',
      }}
    >
      {title && <div className="editor-bar__menu-section-label">{title}</div>}
      {items.map((item) => (
        <div key={item.key}>
          {item.dividerBefore && <div className="editor-bar__menu-divider" />}
          <button
            type="button"
            disabled={item.disabled}
            className={`editor-bar__menu-item${item.danger ? ' editor-bar__menu-item--danger' : ''}`}
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
    </div>,
    document.body,
  );
}
