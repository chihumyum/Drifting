import { useEffect, type RefObject } from 'react';
import loglevel from 'loglevel';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { useSettingsStore } from '../../store/settings-store';
import { useUiStore } from '../../store/ui-store';
import {
  enterImmersiveWriting,
  isStageEditorTarget,
  leaveImmersiveWriting,
} from '../../components/workspaceChrome/immersive-writing';
import { isPressElsewhere, isTypingInput, isTypingKey } from '../../features/immersive-writing/auto-immersion';
import { startParagraphFocus } from '../../features/immersive-writing/paragraph-focus';

const log = loglevel.getLogger('ImmersiveWriting');

/** The band along the window's top that brings back the traffic lights and the dock. */
export const IMMERSIVE_PEEK_TOP_PX = 56;
/** How near the way out (and this sitting's words) the pointer brings them back. */
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
 * window's top edge brings them and the dock back, near the stage's corner
 * the way out (`data-immersive-peek` on the workspace root), and any typing
 * sends them away again; Esc leaves; every block but the caret's fades.
 * Leaving the workspace ends immersion. With 打字时自动沉浸 on, typing in
 * the stage's editor begins it, and a press off the text ends a sitting
 * begun that way.
 */
export function useImmersiveWriting(rootRef: RefObject<HTMLElement | null>): void {
  const immersive = useUiStore((state) => state.immersiveWriting);
  const byTyping = useUiStore((state) => state.immersiveWritingByTyping);
  const auto = useSettingsStore((state) => state.autoImmersiveWriting);

  useEffect(() => () => useUiStore.getState().setImmersiveWriting(false), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!auto || immersive || !root) return undefined;
    let pending: number | null = null;
    // After the event's own handlers: ProseMirror ends its composition on
    // compositionend and splits the block on Enter's keydown.
    const enterFrom = (target: EventTarget | null) => {
      if (pending != null) return;
      pending = window.setTimeout(() => {
        pending = null;
        if (isStageEditorTarget(target, root.querySelector('.desktop-workspace-stage'))) {
          enterImmersiveWriting({ byTyping: true });
        }
      }, 0);
    };
    const onInput = (event: Event) => {
      if (isTypingInput(event as Partial<InputEvent>)) enterFrom(event.target);
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      if (event.data) enterFrom(event.target);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingKey(event)) enterFrom(event.target);
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      if (pending != null) window.clearTimeout(pending);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('compositionend', onCompositionEnd, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [auto, immersive, rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!immersive || !byTyping || !root) return undefined;
    // The press itself lands as usual: on the dock, the outline rail, the margin.
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (isPressElsewhere(event.target instanceof Element ? event.target : null, root)) {
        leaveImmersiveWriting({ refocus: false });
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [immersive, byTyping, rootRef]);

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
      // The way out keeps its box in the stage's corner while hidden, so that is where it will show.
      const control = root.querySelector<HTMLElement>('.immersive-writing-control--stage');
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
