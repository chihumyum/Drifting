import type { HTMLAttributes } from 'react';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string>
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: T;
  options: readonly SegmentedControlOption<T>[];
  onChange: (next: T) => void;
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'lg',
  ariaLabel,
  className = '',
  ...props
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`segmented-control segmented-control--${size} ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
      {...props}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented-control__option${option.value === value ? ' is-active' : ''}`}
          aria-pressed={option.value === value}
          title={option.title}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
