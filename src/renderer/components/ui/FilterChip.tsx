import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { getPlatformRuntime } from '../../platform/runtime';
import { KindMark } from './KindMark';

interface FilterChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  count?: ReactNode;
  markerColor?: string;
  shape?: 'pill' | 'square' | 'strip';
  size?: 'sm' | 'md';
  activeStyle?: 'soft' | 'solid';
  dimmed?: boolean;
  /**
   * `glass` is the Chip (docs/design-system/components.md): one of a group
   * of independent toggles, drawn like the scope toggle. Desktop only; the
   * paused mobile shell keeps the paper chip.
   */
  look?: 'paper' | 'glass';
  /** The relation comes from a drift: the chip leads with the drift's eddy. */
  drift?: boolean;
  /** A sand mark of its own ahead of the label (glass look only). */
  mark?: ReactNode;
}

export function FilterChip({
  active,
  count,
  markerColor,
  shape = 'pill',
  size = 'md',
  activeStyle = 'soft',
  dimmed = false,
  look = 'paper',
  drift = false,
  mark,
  className = '',
  style,
  children,
  type = 'button',
  ...props
}: FilterChipProps) {
  if (look === 'glass' && !getPlatformRuntime().isMobileShell) {
    // The glass carries no colour: the type's colour stays in its sand dash,
    // which fades while the chip is off. `dimmed` means nothing to show.
    return (
      <button
        type={type}
        aria-pressed={active}
        className={[
          'ui-chip glass glass--rest glass--small',
          dimmed ? 'is-empty' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        style={style}
        {...props}
      >
        {drift && <KindMark kind="drift" color="hsl(var(--accent))" className="ui-chip__drift" />}
        {mark}
        {markerColor && <KindMark kind="storyline" color={markerColor} className="ui-chip__mark" />}
        <span className="ui-chip__label">{children}</span>
        {count !== undefined && <span className="ui-chip__count">{count}</span>}
      </button>
    );
  }
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
        drift ? 'filter-chip--drift-edge' : '',
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
