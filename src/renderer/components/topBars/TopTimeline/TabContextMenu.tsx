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
      className="tab-context-menu"
      style={{
        minWidth: 180,
        background: 'hsl(var(--surface))',
        border: '1px solid hsl(var(--rule))',
        borderRadius: 5,
        boxShadow:
          '0 10px 32px -8px hsl(var(--ink-1) / 0.22), 0 2px 6px -2px hsl(var(--ink-1) / 0.10)',
        padding: '4px 0',
        fontFamily: 'var(--font-sans)',
        fontSize: 12.5,
        color: 'hsl(var(--ink-1))',
        userSelect: 'none',
      }}
    >
      {items.map((item, idx) => {
        if (item.separator) {
          return (
            <div
              key={`sep-${idx}`}
              role="separator"
              style={{
                height: 1,
                background: 'hsl(var(--rule))',
                margin: '4px 6px',
              }}
            />
          );
        }
        const disabled = !!item.disabled;
        return (
          <button
            key={`${item.label}-${idx}`}
            role="menuitem"
            type="button"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              item.onClick?.();
              onClose();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '6px 12px',
              border: 'none',
              background: 'transparent',
              color: disabled ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-1))',
              cursor: disabled ? 'default' : 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
              fontSize: 'inherit',
            }}
            onMouseEnter={(e) => {
              if (!disabled) e.currentTarget.style.background = 'hsl(var(--paper-deep))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <span>{item.label}</span>
            {item.accelerator && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'hsl(var(--ink-4))',
                  marginLeft: 16,
                }}
              >
                {item.accelerator}
              </span>
            )}
          </button>
        );
      })}
    </ContextMenuSurface>
  );
}
