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
  aboveBar = true,
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
  /**
   * The unified bar stays visible under most sheets, so the panel rests on
   * top of it; a sheet that owns the keyboard row (the cell editor, where the
   * bar yields) sits on the keyboard inset instead.
   */
  aboveBar?: boolean;
}) {
  const inset = useMobileKeyboardInset();
  const keyboardOpen = keyboardAware && inset > 0;
  const style = {
    '--m-sheet-inset': keyboardOpen
      ? `${inset}px`
      : aboveBar
        ? 'calc(64px + max(8px, env(safe-area-inset-bottom)))'
        : '0px',
  } as CSSProperties;
  return (
    <div
      className={`m-sheet${tall ? ' m-sheet--tall' : ''} ${className}`.trim()}
      style={style}
      data-debug-id={debugId}
      data-keyboard={keyboardOpen ? 'open' : 'closed'}
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
