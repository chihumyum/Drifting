import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';

// iOS WKWebView places a single-tap caret through UIKit's text interaction,
// which snaps the caret to the nearest lexical word boundary (dictionary
// segmentation for CJK). An author therefore cannot tap into the middle of a
// word. This extension never prevents the native behavior — focus, the IME
// user gesture, the loupe, long-press selection and double-tap word selection
// all stay native. Instead it resolves the precise document position under
// the finger at touchend time (before any keyboard-driven layout shift) and
// re-applies that position right after WebKit commits its snapped caret. A
// double tap leaves a non-collapsed selection, which the correction refuses
// to touch.

const TAP_MAX_MOVEMENT_PX = 12;
const TAP_MAX_DURATION_MS = 350;
const CORRECTION_FALLBACK_MS = 250;

export interface CaretTapGesture {
  movementPx: number;
  durationMs: number;
}

/** A caret tap is a short, still, single-finger touch; anything longer is a
 * long-press (loupe / selection) and anything travelled is a scroll. */
export function qualifiesAsCaretTap(gesture: CaretTapGesture): boolean {
  if (!Number.isFinite(gesture.movementPx) || !Number.isFinite(gesture.durationMs)) {
    return false;
  }
  return (
    gesture.movementPx <= TAP_MAX_MOVEMENT_PX && gesture.durationMs <= TAP_MAX_DURATION_MS
  );
}

/** Word-boundary caret snapping is UIKit behavior: iPhone/iPad WebKit views,
 * including iPadOS's desktop-class "Macintosh" user agent (told apart from
 * real macOS by its touch points). */
export function isIosWebKit(userAgent: string, maxTouchPoints: number): boolean {
  if (!/AppleWebKit/i.test(userAgent)) return false;
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

interface PendingCorrection {
  pos: number;
}

export const IosCaretTap = Extension.create({
  name: 'iosCaretTap',

  addProseMirrorPlugins() {
    if (
      typeof navigator === 'undefined' ||
      !isIosWebKit(navigator.userAgent, navigator.maxTouchPoints ?? 0)
    ) {
      return [];
    }

    return [
      new Plugin({
        key: new PluginKey('iosCaretTap'),
        view(view) {
          let touchStart: { x: number; y: number; time: number } | null = null;
          let pending: PendingCorrection | null = null;
          let fallbackTimer = 0;

          const cancelPending = () => {
            pending = null;
            if (fallbackTimer) {
              window.clearTimeout(fallbackTimer);
              fallbackTimer = 0;
            }
          };

          const applyCorrection = () => {
            const correction = pending;
            cancelPending();
            if (!correction || view.isDestroyed) return;
            // Focus never arrived (e.g. the tap did not enter editing) —
            // placing a caret would steal a keyboard the user never opened.
            if (!view.hasFocus()) return;
            const { selection, doc } = view.state;
            // A range means a double-tap word selection or an active drag
            // selection; those are deliberate and must win over the tap.
            if (!(selection instanceof TextSelection) || !selection.empty) return;
            const pos = Math.min(correction.pos, doc.content.size);
            if (selection.from === pos) return;
            const transaction = view.state.tr.setSelection(TextSelection.create(doc, pos));
            transaction.setMeta('addToHistory', false);
            view.dispatch(transaction);
          };

          const scheduleCorrection = () => {
            // WebKit commits the snapped caret before the synthesized click;
            // one frame later the correction lands after it, never under it.
            const run = () => requestAnimationFrame(applyCorrection);
            view.dom.addEventListener('click', run, { once: true, capture: true });
            fallbackTimer = window.setTimeout(run, CORRECTION_FALLBACK_MS);
          };

          const onTouchStart = (event: TouchEvent) => {
            cancelPending();
            if (event.touches.length !== 1) {
              touchStart = null;
              return;
            }
            const touch = event.touches[0];
            touchStart = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
          };

          const onTouchEnd = (event: TouchEvent) => {
            const start = touchStart;
            touchStart = null;
            if (!start || event.touches.length > 0) return;
            if (!view.editable) return;
            const touch = event.changedTouches[0];
            if (!touch) return;
            const movementPx = Math.hypot(touch.clientX - start.x, touch.clientY - start.y);
            if (!qualifiesAsCaretTap({ movementPx, durationMs: event.timeStamp - start.time })) {
              return;
            }
            const target = event.target;
            if (target instanceof Element && target.closest('.entity-link, a')) return;
            const found = view.posAtCoords({ left: touch.clientX, top: touch.clientY });
            if (!found) return;
            pending = { pos: found.pos };
            scheduleCorrection();
          };

          const onTouchCancel = () => {
            touchStart = null;
            cancelPending();
          };

          const dom = view.dom;
          dom.addEventListener('touchstart', onTouchStart, { passive: true });
          dom.addEventListener('touchend', onTouchEnd, { passive: true });
          dom.addEventListener('touchcancel', onTouchCancel, { passive: true });
          return {
            destroy() {
              cancelPending();
              dom.removeEventListener('touchstart', onTouchStart);
              dom.removeEventListener('touchend', onTouchEnd);
              dom.removeEventListener('touchcancel', onTouchCancel);
            },
          };
        },
      }),
    ];
  },
});
