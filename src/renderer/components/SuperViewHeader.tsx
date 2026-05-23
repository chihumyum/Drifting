import type { ReactNode } from 'react';
import '../../styles/super-view-header.css';

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
// macOS `titleBarStyle: hiddenInset` reserves the top-left corner for the
// traffic-light dots; pad the bar in so its leftmost control clears them.
// Mirrors the inset values previously baked into each super view.
const TRAFFIC_LIGHT_INSET = IS_MAC ? 86 : 18;

export interface SuperViewHeaderProps {
  /** Serif title text shown after the back button. */
  title: string;
  /** Optional inline caption (e.g. counts like "3 故事线 · 12 章") rendered
   *  in the monospace meta style next to the title. */
  meta?: ReactNode;
  /** Back-button click handler. Omit to hide the button entirely. */
  onBack?: () => void;
  /** Back-button tooltip / aria-label. Defaults to "返回". */
  backLabel?: string;
  /** Extra controls placed in the left group after the title — e.g.
   *  view-mode toggles or scoped action buttons. */
  leftSlot?: ReactNode;
  /** Trailing controls — filters, mode toggles, status pills. */
  rightSlot?: ReactNode;
}

export function SuperViewHeader({
  title,
  meta,
  onBack,
  backLabel = '返回',
  leftSlot,
  rightSlot,
}: SuperViewHeaderProps) {
  return (
    <div className="super-view-head" style={{ paddingLeft: TRAFFIC_LIGHT_INSET }}>
      <div className="super-view-head__left">
        {onBack && (
          <button
            type="button"
            className="super-view-head__back"
            onClick={onBack}
            title={backLabel}
          >
            <span className="super-view-head__back-glyph" aria-hidden>
              ‹
            </span>
            <span>{backLabel}</span>
          </button>
        )}
        <div className="super-view-head__title">
          {title}
          {meta != null && <em className="super-view-head__meta">{meta}</em>}
        </div>
        {leftSlot}
      </div>
      {rightSlot != null && <div className="super-view-head__right">{rightSlot}</div>}
    </div>
  );
}
