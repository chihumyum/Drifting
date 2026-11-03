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
/** How near the incense (and this sitting's words) the pointer brings them back. */
export const IMMERSIVE_PEEK_NEAR_PX = 48;

export type ImmersivePeek = 'top' | 'corner' | null;

type PeekRect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

export function immersivePeekAt(x: number, y: number, control: PeekRect | null): ImmersivePeek {
  if (y < IMMERSIVE_PEEK_TOP_PX) return 'top';
  const near = IMMERSIVE_PEEK_NEAR_PX;
  if (control && x > control.left - near && x < control.right + near
    && y > control.top - near && y < control.bottom + near) return 'corner';
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
 * window's top edge brings them and the dock back, near the incense the way out
 * (`data-immersive-peek` on the workspace root), and any typing
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
      // The incense stays in its corner while hidden, so its box is where it will show.
      const control = root.querySelector<HTMLElement>('.immersive-writing-control');
      setPeek(immersivePeekAt(event.clientX, event.clientY, control?.getBoundingClientRect() ?? null));
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
