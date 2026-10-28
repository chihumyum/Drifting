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
  | 'branch'
  | 'brush-laid'
  | 'brush-lifted'
  | 'case-dew'
  | 'check'
  | 'checklist'
  | 'checklist-plus'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'close'
  | 'cloud'
  | 'comment'
  | 'comment-plus'
  | 'copy'
  | 'dharma-wheel'
  | 'edit'
  | 'enso'
  | 'eraser'
  | 'file-text'
  | 'folder'
  | 'folder-open'
  | 'folder-plus'
  | 'fullscreen'
  | 'furin'
  | 'gate-in'
  | 'gate-out'
  | 'image'
  | 'image-plus'
  | 'ink-disc'
  | 'jizo'
  | 'knot-links'
  | 'knots'
  | 'layers'
  | 'lib-curio'
  | 'loader'
  | 'lock-open'
  | 'lock-shut'
  | 'mic'
  | 'minus'
  | 'moon-left'
  | 'moon-right'
  | 'more'
  | 'movable-type'
  | 'open-book'
  | 'ov-folding'
  | 'ov-iceberg'
  | 'plan-go'
  | 'plus'
  | 'rotate'
  | 'search'
  | 'share'
  | 'shikigami'
  | 'sort'
  | 'split'
  | 'sprout'
  | 'status-done'
  | 'status-stopped'
  | 'status-warning'
  | 'sticky-note'
  | 'stones-triad'
  | 'stop'
  | 'taiji'
  | 'toc-raked'
  | 'torii'
  | 'trash'
  | 'view-grid'
  | 'view-list'
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
