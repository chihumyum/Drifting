import type { CSSProperties } from 'react';

/**
 * Icons drawn with the sand brush (src/assets/design/icons/). One colour,
 * tinted by the control's text colour, so hover and press still change them.
 */
export type BrushIconName =
  | 'bamboo'
  | 'comment'
  | 'fullscreen'
  | 'furin'
  | 'knot-links'
  | 'lib-curio'
  | 'moon-left'
  | 'moon-right'
  | 'more'
  | 'ov-folding'
  | 'ov-iceberg'
  | 'plan-go'
  | 'split'
  | 'toc-raked'
  | 'torii';

export function BrushIcon({ name, size = 16 }: { name: BrushIconName; size?: number }) {
  return (
    <i
      aria-hidden="true"
      className={`brush-icon brush-icon--${name}`}
      style={{ '--brush-icon-size': `${size}px` } as CSSProperties}
    />
  );
}
