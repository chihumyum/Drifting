import type { CSSProperties } from 'react';

/**
 * Icons drawn with the sand brush (src/assets/design/icons/). One colour,
 * tinted by the control's text colour, so hover and press still change them.
 */
export type BrushIconName =
  | 'arrow-back'
  | 'arrow-down'
  | 'arrow-forward'
  | 'arrow-in'
  | 'arrow-out'
  | 'bamboo'
  | 'books'
  | 'both-ways'
  | 'branch'
  | 'brush-broken'
  | 'brush-laid'
  | 'brush-lifted'
  | 'case-dew'
  | 'case-rise'
  | 'check'
  | 'checklist'
  | 'checklist-plus'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'close'
  | 'cloud'
  | 'code'
  | 'comment'
  | 'comment-plus'
  | 'copy'
  | 'dharma-wheel'
  | 'edit'
  | 'enso'
  | 'eraser'
  | 'file-text'
  | 'fluff'
  | 'folder'
  | 'folder-none'
  | 'folder-open'
  | 'folder-plus'
  | 'folding-fan'
  | 'folding-fan-closed'
  | 'fmt-bold'
  | 'fmt-h1'
  | 'fmt-h2'
  | 'fmt-h3'
  | 'fmt-italic'
  | 'fmt-paragraph'
  | 'fmt-quote'
  | 'fmt-strike'
  | 'fmt-underline'
  | 'fullscreen'
  | 'furin'
  | 'gate-in'
  | 'gate-out'
  | 'grip'
  | 'highlight'
  | 'hook'
  | 'insert-col'
  | 'insert-row'
  | 'lift'
  | 'lift-bent'
  | 'image'
  | 'image-plus'
  | 'ink-disc'
  | 'inkstone'
  | 'jizo'
  | 'knot-links'
  | 'knots'
  | 'layers'
  | 'lib-curio'
  | 'list-bullet'
  | 'list-ordered'
  | 'loader'
  | 'locate'
  | 'lock-open'
  | 'lock-shut'
  | 'mic'
  | 'minus'
  | 'moon-left'
  | 'moon-left-hollow'
  | 'moon-right'
  | 'moon-right-hollow'
  | 'more'
  | 'movable-type'
  | 'name-seal'
  | 'new-category'
  | 'new-storyline'
  | 'open-book'
  | 'ov-folding'
  | 'ov-iceberg'
  | 'plan-go'
  | 'plus'
  | 'ri'
  | 'rotate'
  | 'seal-fork'
  | 'seal-main'
  | 'search'
  | 'share'
  | 'shikigami'
  | 'sort'
  | 'split'
  | 'spread'
  | 'sprout'
  | 'status-done'
  | 'status-stopped'
  | 'status-warning'
  | 'sticky-note'
  | 'stitched'
  | 'stone-sunk'
  | 'stones-triad'
  | 'stop'
  | 'swap'
  | 'table'
  | 'taiji'
  | 'task-doing'
  | 'task-done'
  | 'task-todo'
  | 'tea'
  | 'thinking'
  | 'toc-raked'
  | 'torii'
  | 'trash'
  | 'view-grid'
  | 'view-list'
  | 'wen'
  | 'wu'
  | 'zi'
  | 'zi-ri';

export function BrushIcon({
  name,
  size = 16,
  inline = false,
  className,
  style,
}: {
  name: BrushIconName;
  size?: number;
  /** Sits in a line of text (a label's leading plus, a trailing arrow) instead of standing as a block. */
  inline?: boolean;
  /** Extra classes, e.g. a spinner's rotation or a disclosure chevron's turn. */
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <i
      aria-hidden="true"
      className={`brush-icon brush-icon--${name}${inline ? ' is-inline' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--brush-icon-size': `${size}px`, ...style } as CSSProperties}
    />
  );
}
