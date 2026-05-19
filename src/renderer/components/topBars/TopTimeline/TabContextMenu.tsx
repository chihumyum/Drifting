import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x, y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let nx = x;
    let ny = y;
    if (nx + rect.width + margin > window.innerWidth) {
      nx = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (ny + rect.height + margin > window.innerHeight) {
      ny = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = () => onClose();
    // Use capture so we beat any descendant handlers.
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('contextmenu', onDocClick, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('contextmenu', onDocClick, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        top: pos.y,
        left: pos.x,
        zIndex: 10000,
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
    </div>,
    document.body,
  );
}
