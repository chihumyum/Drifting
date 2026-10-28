import type { CSSProperties } from 'react';

/**
 * Icons drawn with the sand brush (src/assets/design/icons/). One colour,
 * tinted by the control's text colour, so hover and press still change them.
 */
export type BrushIconName =
  | 'arrow-back'
  | 'arrow-forward'
  | 'bamboo'
  | 'books'
  | 'brush-laid'
  | 'brush-lifted'
  | 'case-dew'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'close'
  | 'comment'
  | 'copy'
  | 'dharma-wheel'
  | 'edit'
  | 'enso'
  | 'folder'
  | 'folder-open'
  | 'folder-plus'
  | 'fullscreen'
  | 'furin'
  | 'gate-in'
  | 'gate-out'
  | 'ink-disc'
  | 'jizo'
  | 'knot-links'
  | 'lib-curio'
  | 'loader'
  | 'lock-open'
  | 'lock-shut'
  | 'minus'
  | 'moon-left'
  | 'moon-right'
  | 'more'
  | 'movable-type'
  | 'ov-folding'
  | 'ov-iceberg'
  | 'plan-go'
  | 'plus'
  | 'search'
  | 'shikigami'
  | 'split'
  | 'sprout'
  | 'stones-triad'
  | 'stop'
  | 'taiji'
  | 'toc-raked'
  | 'torii'
  | 'trash'
  | 'wen';

export function BrushIcon({
  name,
  size = 16,
  className,
  style,
}: {
  name: BrushIconName;
  size?: number;
  /** Extra classes, e.g. a spinner's rotation or a disclosure chevron's turn. */
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <i
      aria-hidden="true"
      className={`brush-icon brush-icon--${name}${className ? ` ${className}` : ''}`}
      style={{ '--brush-icon-size': `${size}px`, ...style } as CSSProperties}
    />
  );
}
