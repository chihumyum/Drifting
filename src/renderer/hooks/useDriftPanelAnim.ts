import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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
