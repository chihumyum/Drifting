import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

interface FilterChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  count?: ReactNode;
  markerColor?: string;
  shape?: 'pill' | 'square' | 'strip';
  size?: 'sm' | 'md';
  activeStyle?: 'soft' | 'solid';
  dimmed?: boolean;
}

export function FilterChip({
  active,
  count,
  markerColor,
  shape = 'pill',
  size = 'md',
  activeStyle = 'soft',
  dimmed = false,
  className = '',
  style,
  children,
  type = 'button',
  ...props
}: FilterChipProps) {
  return (
    <button
      type={type}
      aria-pressed={active}
      className={[
        'filter-chip',
        `filter-chip--${shape}`,
        `filter-chip--${size}`,
        `filter-chip--${activeStyle}`,
        active ? 'is-active' : '',
        dimmed ? 'is-dimmed' : '',
        markerColor ? 'has-marker' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        {
          ...(markerColor ? { '--filter-chip-marker': markerColor } : null),
          ...style,
        } as CSSProperties
      }
      {...props}
    >
      {markerColor && <span className="filter-chip__marker" aria-hidden />}
      <span className="filter-chip__label">{children}</span>
      {count !== undefined && <span className="filter-chip__count">{count}</span>}
    </button>
  );
}
