import type { CSSProperties } from 'react';

/**
 * Icons drawn with the sand brush (src/assets/design/icons/). One colour,
 * tinted by the control's text colour, so hover and press still change them.
 */
export type BrushIconName =
  | 'bamboo'
  | 'books'
  | 'brush-laid'
  | 'brush-lifted'
  | 'case-dew'
  | 'comment'
  | 'dharma-wheel'
  | 'enso'
  | 'fullscreen'
  | 'furin'
  | 'gate-in'
  | 'gate-out'
  | 'ink-disc'
  | 'jizo'
  | 'knot-links'
  | 'lib-curio'
  | 'lock-open'
  | 'lock-shut'
  | 'moon-left'
  | 'moon-right'
  | 'more'
  | 'movable-type'
  | 'ov-folding'
  | 'ov-iceberg'
  | 'plan-go'
  | 'plus'
  | 'shikigami'
  | 'split'
  | 'sprout'
  | 'stones-triad'
  | 'taiji'
  | 'toc-raked'
  | 'torii'
  | 'wen';

export function BrushIcon({ name, size = 16 }: { name: BrushIconName; size?: number }) {
  return (
    <i
      aria-hidden="true"
      className={`brush-icon brush-icon--${name}`}
      style={{ '--brush-icon-size': `${size}px` } as CSSProperties}
    />
  );
}
