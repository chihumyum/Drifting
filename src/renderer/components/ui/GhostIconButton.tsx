/**
 * GhostIconButton — flat ghost button for icon-only actions in toolbars,
 * section headers, etc. Pairs with the Drifting design system tokens.
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
  size?: 'sm' | 'md';
  /** Visual emphasis. `accent` = active toggled state. */
  variant?: 'default' | 'accent' | 'destructive';
  style?: CSSProperties;
}

export const GhostIconButton = forwardRef<HTMLButtonElement, GhostIconButtonProps>(
  function GhostIconButton(
    {
      icon,
      size = 'md',
      variant = 'default',
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
