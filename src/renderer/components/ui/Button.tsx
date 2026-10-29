import type { ButtonHTMLAttributes } from 'react';
import { getPlatformRuntime } from '../../platform/runtime';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
}

/** On the desktop each variant is one of the glass buttons in
 * docs/design-system/components.md: default is the secondary button (a
 * resting line of glass), primary the accent's selected glass, danger the
 * secondary's clear line with the danger ink, ghost a text button with no
 * glass. The paused mobile shell keeps the older filled buttons. */
const GLASS: Record<NonNullable<ButtonProps['variant']>, string> = {
  default: 'glass glass--rest',
  primary: 'glass glass--primary',
  danger: 'glass glass--rest',
  ghost: '',
};

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  const glass = !getPlatformRuntime().isMobileShell;
  return (
    <button
      type={type}
      className={[
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${size}`,
        glass ? 'ui-button--glass' : '',
        glass ? GLASS[variant] : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}
