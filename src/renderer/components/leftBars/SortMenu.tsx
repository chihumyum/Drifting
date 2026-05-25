import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';

export interface SortMenuOption<T extends string> {
  value: T;
  label: string;
}

interface SortMenuProps<T extends string> {
  triggerRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  options: SortMenuOption<T>[];
  value: T;
  onChange: (next: T) => void;
  title?: string;
}

// Small radio-style popover anchored under a trigger button. Used by the
// left sidebar sub-header to switch each panel's sort mode. Mirrors UserMenu's
// portal / scrim / Escape pattern so dismissal behaviour matches.
export function SortMenu<T extends string>({
  triggerRef,
  open,
  onClose,
  options,
  value,
  onChange,
  title,
}: SortMenuProps<T>) {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [open, onClose]);

  if (!open || !position) return null;

  return createPortal(
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 290 } as React.CSSProperties}
      />
      <div
        style={{
          position: 'fixed',
          top: position.top,
          right: position.right,
          minWidth: 180,
          background: 'hsl(var(--surface))',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 6,
          boxShadow:
            '0 10px 28px hsl(var(--ink-1) / 0.15), 0 2px 6px hsl(var(--ink-1) / 0.08)',
          zIndex: 300,
          fontFamily: 'var(--font-sans)',
          overflow: 'hidden',
          animation: 'sortMenuIn 160ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        <style>{`
          @keyframes sortMenuIn {
            from { opacity: 0; transform: translateY(-6px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {title && (
          <div
            style={{
              padding: '8px 12px 6px',
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: 'hsl(var(--ink-4))',
              borderBottom: '1px solid hsl(var(--rule))',
            }}
          >
            {title}
          </div>
        )}

        <div style={{ padding: '4px' }}>
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <div
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  onClose();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px 7px 8px',
                  fontSize: 12.5,
                  color: active ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-2))',
                  cursor: 'pointer',
                  borderRadius: 3,
                  transition: 'background 0.12s ease, color 0.12s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'hsl(var(--paper-deep))';
                  e.currentTarget.style.color = 'hsl(var(--ink-1))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = active
                    ? 'hsl(var(--ink-1))'
                    : 'hsl(var(--ink-2))';
                }}
              >
                <span
                  style={{
                    width: 14,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'hsl(var(--accent))',
                    flexShrink: 0,
                  }}
                >
                  {active ? <Check size={12} strokeWidth={2.2} /> : null}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  {opt.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}
