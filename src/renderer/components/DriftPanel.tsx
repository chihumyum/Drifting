import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../styles/drift-panel.css';

// Shared drift-panel UX: bottom-anchored tab → slide-up panel with cards →
// close button → slide-down. Used by StoryGraphView (drift↔node) and
// SuperElementView (drift↔element); the only thing the two views differ on
// is what the cards connect to. Card rendering itself lives in the parent
// (as children) — that lets each view keep its own click / drag / popover
// behaviour without us inventing a leaky prop bag.

export interface DriftPanelProps {
  /** Number displayed in the closed-state tab badge. */
  count: number;
  /** Anim state from useDriftPanelAnim. */
  mounted: boolean;
  open: boolean;
  closing: boolean;
  /** Click handlers for tab / close. */
  onOpen: () => void;
  onClose: () => void;
  /** Disable the close button (used during closing animation so accidental
   *  re-click doesn't reset the timer). */
  closeDisabled?: boolean;
  /** Tab label — defaults to "灵感". */
  tabLabel?: string;
  /** ARIA hidden flag for the inner panel (used during closing). */
  panelAriaHidden?: boolean;
  /**
   * Drag-and-drop handlers for the .drift-panel__hand container. StoryGraphView
   * uses these for drag-reorder "drop in empty space"; SuperElementView
   * doesn't pass anything.
   */
  handDragHandlers?: Pick<
    React.HTMLAttributes<HTMLDivElement>,
    'onDragOver' | 'onDrop' | 'onDragEnter' | 'onDragLeave'
  >;
  /**
   * Ref to the .drift-panel__hand scroll container. Exposed so parents
   * that draw absolute-positioned overlays anchored to cards inside
   * (e.g. StoryGraphView's drift-edge SVG) can attach a scroll listener
   * and recompute geometry as the user scrolls the row horizontally.
   */
  handRef?: React.Ref<HTMLDivElement>;
  /** Card content. Parent renders DriftCards (or whatever) inside. */
  children: ReactNode;
}

export function DriftPanel({
  count,
  mounted,
  open,
  closing,
  onOpen,
  onClose,
  closeDisabled,
  tabLabel,
  panelAriaHidden,
  handDragHandlers,
  handRef,
  children,
}: DriftPanelProps) {
  const { t } = useTranslation();
  const resolvedTabLabel = tabLabel ?? t('driftPanel.tabLabel');
  return (
    <div className="drift-panel-shell">
      <div
        className={`drift-panel${open ? ' is-open' : ''}${closing ? ' is-closing' : ''}`}
      >
        {!mounted && (
          <button
            type="button"
            className="drift-panel__tab"
            onClick={onOpen}
            title={t('driftPanel.expandTitle', { label: resolvedTabLabel })}
          >
            <span>{resolvedTabLabel}</span>
            <span className="drift-panel__count">{count}</span>
          </button>
        )}
        {mounted && (
          <>
            <button
              type="button"
              className="drift-panel__close"
              onClick={onClose}
              disabled={closeDisabled}
              title={t('driftPanel.collapseTitle', { label: resolvedTabLabel })}
              aria-label={t('driftPanel.collapseTitle', { label: resolvedTabLabel })}
            >
              <X size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <div className="drift-panel__panel" aria-hidden={panelAriaHidden}>
              <div className="drift-panel__hand" ref={handRef} {...handDragHandlers}>
                {children}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
