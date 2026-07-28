import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
}

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${size}`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}
