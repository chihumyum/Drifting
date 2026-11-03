import { useEffect, type RefObject } from 'react';
import loglevel from 'loglevel';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { useUiStore } from '../../store/ui-store';
import { leaveImmersiveWriting } from '../../components/workspaceChrome/immersive-writing';
import { startParagraphFocus } from '../../features/immersive-writing/paragraph-focus';

const log = loglevel.getLogger('ImmersiveWriting');

/** The band along the window's top that brings back the traffic lights and the dock. */
export const IMMERSIVE_PEEK_TOP_PX = 56;
/** The bottom-right corner that brings back the way out and this sitting's words. */
export const IMMERSIVE_PEEK_CORNER_PX = { width: 240, height: 120 } as const;

export type ImmersivePeek = 'top' | 'corner' | null;

export function immersivePeekAt(x: number, y: number, width: number, height: number): ImmersivePeek {
  if (y < IMMERSIVE_PEEK_TOP_PX) return 'top';
  if (x > width - IMMERSIVE_PEEK_CORNER_PX.width && y > height - IMMERSIVE_PEEK_CORNER_PX.height) return 'corner';
  return null;
}

function setTrafficLightsHidden(hidden: boolean): void {
  const runtime = getPlatformRuntime();
  if (!runtime.isMacDesktop || !runtime.desktopWindowControls) return;
  void platform.window
    .setTrafficLightsHidden(hidden)
    .catch((error) => log.warn('Native traffic-light visibility is unavailable:', error));
}

/**
 * While immersive writing is on: the traffic lights hide; the pointer at the
 * window's top edge brings them and the dock back, at the bottom-right corner
 * the way out (`data-immersive-peek` on the workspace root), and any typing
 * sends them away again; Esc leaves; every block but the caret's fades.
 * Leaving the workspace ends immersion.
 */
export function useImmersiveWriting(rootRef: RefObject<HTMLElement | null>): void {
  const immersive = useUiStore((state) => state.immersiveWriting);

  useEffect(() => () => useUiStore.getState().setImmersiveWriting(false), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!immersive || !root) return undefined;
    let peek: ImmersivePeek = null;
    const setPeek = (next: ImmersivePeek) => {
      if (next === peek) return;
      if (next === 'top' || peek === 'top') setTrafficLightsHidden(next !== 'top');
      peek = next;
      if (next) root.dataset.immersivePeek = next;
      else delete root.dataset.immersivePeek;
    };
    const onPointerMove = (event: PointerEvent) => {
      setPeek(immersivePeekAt(event.clientX, event.clientY, window.innerWidth, window.innerHeight));
    };
    const onPointerLeave = () => setPeek(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented || event.isComposing) return;
        event.preventDefault();
        leaveImmersiveWriting();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) setPeek(null);
    };

    setTrafficLightsHidden(true);
    const stopFocus = startParagraphFocus();
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('keydown', onKeyDown);
      stopFocus();
      delete root.dataset.immersivePeek;
      setTrafficLightsHidden(false);
    };
  }, [immersive, rootRef]);
}
