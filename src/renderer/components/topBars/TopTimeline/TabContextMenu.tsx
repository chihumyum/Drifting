import { ContextMenuSurface } from '../../ui/ContextMenuSurface';

export interface TabMenuItem {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  accelerator?: string;
  separator?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: TabMenuItem[];
  onClose: () => void;
}

// Right-click menu for tabs. Portals to body so it escapes the tab bar's
// overflow:auto clip, and keeps itself on-screen by repositioning into the
// viewport after first measure.
//
// Closes on:
//   • Click outside
//   • Escape
//   • Scroll / resize (so it doesn't float over stale anchors)
//   • Selecting an item
export function TabContextMenu({ x, y, items, onClose }: Props) {
  return (
    <ContextMenuSurface
      x={x}
      y={y}
      onClose={onClose}
      dismissOnScroll
      className="menu-surface--compact tab-context-menu"
    >
      {items.map((item, idx) => {
        if (item.separator) {
          return <div key={`sep-${idx}`} role="separator" className="menu-surface__separator" />;
        }
        const disabled = !!item.disabled;
        return (
          <button
            key={`${item.label}-${idx}`}
            role="menuitem"
            type="button"
            disabled={disabled}
            className="menu-surface__item tab-context-menu__item"
            onClick={() => {
              if (disabled) return;
              item.onClick?.();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.accelerator && (
              <span className="tab-context-menu__accelerator">{item.accelerator}</span>
            )}
          </button>
        );
      })}
    </ContextMenuSurface>
  );
}
