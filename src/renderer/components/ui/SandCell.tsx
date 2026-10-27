import { forwardRef, useState, type CSSProperties, type HTMLAttributes } from 'react';

/**
 * A list cell in the sidebars. No hover wash: under the pointer its outline
 * becomes a hairline of flowing glass in the cell's colour. Selected (one
 * click opens it as a preview tab), the brush leaves the cell's mark and goes
 * round it once; pinning the tab changes nothing here. A cell that is already
 * selected when it mounts fades its frame in instead of drawing it.
 * Styles: materials.css `.sand-cell`.
 */
/** Left padding of a sidebar cell and the centre of its 14px mark slot. */
export const CELL_PAD_LEFT = 12;
export const CELL_MARK_CENTER = CELL_PAD_LEFT + 7;

interface SandCellProps extends HTMLAttributes<HTMLDivElement> {
  selected: boolean;
  /** Storyline or category colour for the ring and frame. */
  color?: string;
  /** Distance from the cell's left edge to the centre of its mark, where the brush starts. */
  markCenter?: number;
  tile?: boolean;
}

export const SandCell = forwardRef<HTMLDivElement, SandCellProps>(function SandCell(
  { selected, color, markCenter, tile = false, className, style, children, ...props },
  ref,
) {
  const settled = useSettledSelection(selected);
  return (
    <div
      ref={ref}
      className={[
        'sand-cell',
        tile ? 'sand-cell--tile' : '',
        selected ? 'is-selected' : '',
        settled ? 'is-settled' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      style={{
        '--cell-c': color,
        '--cell-frame-origin': markCenter === undefined ? undefined : `${markCenter + 2}px`,
        ...style,
      } as CSSProperties}
      {...props}
    >
      {children}
      <i className="cell-ring" aria-hidden="true" />
      <i className="cell-frame" aria-hidden="true" />
    </div>
  );
});

/** True while a selection that existed at mount is still held. */
function useSettledSelection(selected: boolean) {
  const [settled, setSettled] = useState(selected);
  if (settled && !selected) setSettled(false);
  return settled && selected;
}
