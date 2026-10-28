/**
 * GhostIconButton — icon-only button. Plain by default (panel-header sort,
 * new, filters): hovering only darkens it. Workspace controls (sidebar
 * toggles, the split button, Project Home, entries to whole-book views) are
 * made of glass: `glass` gives them the flowing rim, round or square.
 */
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';

interface GhostIconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'style'> {
  icon: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Visual emphasis. `accent` = active toggled state. */
  variant?: 'default' | 'accent' | 'destructive';
  /** Glass control instead of a plain one; see materials.css. */
  glass?: 'round' | 'square';
  style?: CSSProperties;
}

export const GhostIconButton = forwardRef<HTMLButtonElement, GhostIconButtonProps>(
  function GhostIconButton(
    {
      icon,
      size = 'md',
      variant = 'default',
      glass,
      style,
      disabled = false,
      className = '',
      type = 'button',
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        className={[
          'ghost-icon-button',
          `ghost-icon-button--${size}`,
          variant !== 'default' ? `ghost-icon-button--${variant}` : '',
          glass ? 'ghost-icon-button--glass glass' : '',
          glass === 'round' ? 'glass--round' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        style={style}
        {...props}
      >
        {icon}
      </button>
    );
  },
);
