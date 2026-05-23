import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import '../../styles/drift-panel.css';

// Shared drift-panel UX: bottom-anchored tab → slide-up panel with cards →
// close button → slide-down. Used by StoryGraphView (drift↔node) and
// SuperElementView (drift↔element); the only thing the two views differ on
// is what the cards connect to. Card rendering itself lives in the parent
// (as children) — that lets each view keep its own click / drag / popover
// behaviour without us inventing a leaky prop bag.

const DRIFT_PANEL_ANIMATION_MS = 320;

export interface UseDriftPanelAnimResult {
  mounted: boolean;
  open: boolean;
  closing: boolean;
  openPanel: () => void;
  closePanel: () => void;
  /** Latest-closePanel ref, so ESC handlers declared above can call it. */
  closePanelRef: React.MutableRefObject<(() => void) | null>;
}

/**
 * Manages the mount/open/closing state machine. Mount → next-rAF set
 * open=true so the slide-in transition has a "from" state to interpolate
 * from. Close → set open=false + closing=true; after the transition ends,
 * unmount so the bottom tab can re-appear.
 */
export function useDriftPanelAnim(): UseDriftPanelAnimResult {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  const openRafRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const openPanel = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setMounted(true);
  }, []);

  const closePanel = useCallback(() => {
    if (!mounted || closing) return;
    if (openRafRef.current !== null) {
      cancelAnimationFrame(openRafRef.current);
      openRafRef.current = null;
    }
    setClosing(true);
    setOpen(false);
    closeTimerRef.current = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      closeTimerRef.current = null;
    }, DRIFT_PANEL_ANIMATION_MS);
  }, [mounted, closing]);

  // After mount, schedule open=true on the NEXT animation frame. The
  // intermediate "mounted=true, open=false" render gives the panel a frame
  // to render at translateY(offscreen) before we flip is-open, so the
  // browser actually animates the transform.
  useEffect(() => {
    if (!mounted || open || closing) return;
    openRafRef.current = requestAnimationFrame(() => {
      setOpen(true);
      openRafRef.current = null;
    });
    return () => {
      if (openRafRef.current !== null) {
        cancelAnimationFrame(openRafRef.current);
        openRafRef.current = null;
      }
    };
  }, [mounted, open, closing]);

  useEffect(
    () => () => {
      if (openRafRef.current !== null) cancelAnimationFrame(openRafRef.current);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // Mirror the latest closePanel into a ref so ESC handlers (often
  // declared above the panel state) can invoke it without forcing a
  // re-bind every render.
  const closePanelRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    closePanelRef.current = closePanel;
  }, [closePanel]);

  return { mounted, open, closing, openPanel, closePanel, closePanelRef };
}

export interface DriftPanelProps {
  /** Number displayed in the closed-state tab badge. */
  count: number;
  /** Distance from viewport bottom (typically BottomStatusBar height). */
  bottomOffset?: number;
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
  /** Tab label — defaults to "浮缀". */
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
  bottomOffset = 0,
  mounted,
  open,
  closing,
  onOpen,
  onClose,
  closeDisabled,
  tabLabel = '浮缀',
  panelAriaHidden,
  handDragHandlers,
  handRef,
  children,
}: DriftPanelProps) {
  return (
    <div className="drift-panel-shell" style={{ bottom: bottomOffset }}>
      <div
        className={`drift-panel${open ? ' is-open' : ''}${closing ? ' is-closing' : ''}`}
      >
        {!mounted && (
          <button
            type="button"
            className="drift-panel__tab"
            onClick={onOpen}
            title={`展开${tabLabel}`}
          >
            <span>{tabLabel}</span>
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
              title={`收起${tabLabel}`}
              aria-label={`收起${tabLabel}`}
            >
              ×
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
