import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';
import { SandFrame } from './SandFrame';

/**
 * A list cell in the sidebars. No hover wash: under the pointer its outline
 * becomes a hairline of flowing glass in the cell's colour. Selected (one
 * click opens it as a preview tab), the brush leaves beside the cell's mark
 * and goes round it once, a new stroke for this cell's size every time
 * (SandFrame); pinning the tab changes nothing here. A cell that is already
 * selected when it mounts shows its frame without drawing it.
 * Styles: materials.css `.sand-cell`.
 */
/** Left padding of a sidebar cell. */
export const CELL_PAD_LEFT = 12;

interface SandCellProps extends HTMLAttributes<HTMLDivElement> {
  selected: boolean;
  /** Storyline or category colour for the ring and frame. */
  color?: string;
}

export const SandCell = forwardRef<HTMLDivElement, SandCellProps>(function SandCell(
  { selected, color, className, style, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={['sand-cell', selected ? 'is-selected' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ '--cell-c': color, ...style } as CSSProperties}
      {...props}
    >
      {children}
      <i className="cell-ring" aria-hidden="true" />
      <SandFrame selected={selected} />
    </div>
  );
});
