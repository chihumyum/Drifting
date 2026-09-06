import type { CSSProperties, ReactNode } from 'react';
import { useMobileKeyboardInset } from './useMobileKeyboardInset';

/**
 * Bottom sheet shared by the paper tools (Plot cell / header editors, the
 * vertical timeline menus). It rides the software keyboard and its scrim
 * doubles as the dismiss target; the workspace controller owns Back.
 */
export function MobileToolSheet({
  ariaLabel,
  onClose,
  children,
  className = '',
  debugId,
  keyboardAware = false,
  tall = false,
}: {
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  debugId?: string;
  /** Follow the keyboard inset (sheets that own a text field). */
  keyboardAware?: boolean;
  /** Reserve more height (the cell editor). */
  tall?: boolean;
}) {
  const inset = useMobileKeyboardInset();
  const style = {
    '--m-sheet-inset': `${keyboardAware ? inset : 0}px`,
  } as CSSProperties;
  return (
    <div
      className={`m-sheet${tall ? ' m-sheet--tall' : ''} ${className}`.trim()}
      style={style}
      data-debug-id={debugId}
      data-keyboard={keyboardAware && inset > 0 ? 'open' : 'closed'}
    >
      <button
        type="button"
        className="m-sheet__scrim"
        aria-label={ariaLabel}
        onClick={onClose}
      />
      <section className="m-sheet__panel" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div className="m-sheet__grab" aria-hidden="true" />
        {children}
      </section>
    </div>
  );
}
