/**
 * GhostIconButton — flat ghost button for icon-only actions in toolbars,
 * section headers, etc. Pairs with the Drifting design system tokens.
 */
import { useState, type CSSProperties, type ReactNode, type MouseEventHandler } from 'react';

interface GhostIconButtonProps {
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  icon: ReactNode;
  size?: 'sm' | 'md';
  /** Visual emphasis. `accent` = active toggled state. */
  variant?: 'default' | 'accent' | 'destructive';
  style?: CSSProperties;
  disabled?: boolean;
  draggable?: boolean;
}

export function GhostIconButton({
  onClick,
  title,
  icon,
  size = 'md',
  variant = 'default',
  style,
  disabled = false,
}: GhostIconButtonProps) {
  const [hover, setHover] = useState(false);
  const dimension = size === 'sm' ? 22 : 26;

  const idleColor =
    variant === 'accent'
      ? 'hsl(var(--accent))'
      : variant === 'destructive'
        ? 'hsl(var(--destructive))'
        : 'hsl(var(--ink-3))';
  const hoverColor =
    variant === 'accent'
      ? 'hsl(var(--accent))'
      : variant === 'destructive'
        ? 'hsl(var(--destructive))'
        : 'hsl(var(--ink-1))';
  const idleBg =
    variant === 'accent' ? 'hsl(var(--accent) / 0.10)' : 'transparent';
  const hoverBg =
    variant === 'accent'
      ? 'hsl(var(--accent) / 0.16)'
      : variant === 'destructive'
        ? 'hsl(var(--destructive) / 0.10)'
        : 'hsl(var(--paper-deep))';

  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: dimension,
        height: dimension,
        borderRadius: 4,
        border: 'none',
        background: hover && !disabled ? hoverBg : idleBg,
        color: hover && !disabled ? hoverColor : idleColor,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        padding: 0,
        flexShrink: 0,
        transition: 'background 0.12s ease, color 0.12s ease',
        ...style,
      }}
    >
      {icon}
    </button>
  );
}
