import type { ButtonHTMLAttributes } from 'react';

interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  size?: 'sm' | 'md';
}

export function Switch({
  checked,
  onCheckedChange,
  size = 'md',
  className = '',
  disabled,
  ...props
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={[
        'ui-switch',
        `ui-switch--${size}`,
        checked ? 'is-on' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  );
}
