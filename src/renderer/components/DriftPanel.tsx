import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '../../styles/drift-panel.css';
import { BrushIcon } from './ui/BrushIcon';
import { KindMark } from './ui/KindMark';

// Shared drift-panel UX: bottom-anchored tab → slide-up panel with cards →
// close button → slide-down. Everything here floats over the graph, so it is
// floating glass: the tab is a resting glass chip on the paper fill with the
// drift's sand eddy, the close is a round glass button, and the cards (drawn
// by the parent) are resting glass slabs on the same fill. Used by StoryGraphView (drift↔node) and
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
  /** Tab label — defaults to "构想". */
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
            className="drift-panel__tab glass glass--rest"
            onClick={onOpen}
            title={t('driftPanel.expandTitle', { label: resolvedTabLabel })}
          >
            <KindMark kind="drift" loose />
            <span>{resolvedTabLabel}</span>
            <span className="drift-panel__count">{count}</span>
          </button>
        )}
        {mounted && (
          <>
            <button
              type="button"
              className="drift-panel__close glass glass--rest glass--round"
              onClick={onClose}
              disabled={closeDisabled}
              title={t('driftPanel.collapseTitle', { label: resolvedTabLabel })}
              aria-label={t('driftPanel.collapseTitle', { label: resolvedTabLabel })}
            >
              <BrushIcon name="close" size={14} />
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
