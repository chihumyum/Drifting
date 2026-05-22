import type { Editor } from '@tiptap/core';
import { subscribeActiveEditor } from './active-editor';

// Typewriter mode — keeps the caret line near the vertical center of the
// scrollable container as the user types. The caret stays put while the
// text slides past it, instead of the more conventional caret-walks-down
// behaviour.
//
// Implementation notes:
//   - We hook the *currently active* editor (via `subscribeActiveEditor`)
//     and react to selection updates. Anyone using `useEntityEditor` joins
//     that registry automatically, so the same enabler covers every
//     surface (NodeEditor / ElementEditor / StorylineEditor / ...).
//   - We walk up from the editor DOM to find the nearest vertically-
//     scrollable ancestor (`overflow-y: auto|scroll`). That's the element
//     whose scrollTop we have to nudge — `scrollIntoView` doesn't work
//     here because we want CENTER alignment in a specific scroll root, not
//     `nearest` in whatever happens to scroll.
//   - We throttle through `requestAnimationFrame` so a rapid burst of
//     selection events (typing) only triggers a single scroll per frame.

let enabled = false;
let unsubscribe: (() => void) | null = null;
let editorCleanup: (() => void) | null = null;

function findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node && node !== document.body) {
    const cs = window.getComputedStyle(node);
    const oy = cs.overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function attach(editor: Editor): () => void {
  let frame = 0;
  const onSelection = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (editor.isDestroyed) return;
      const view = editor.view;
      const { from } = view.state.selection;
      let coords: { top: number; bottom: number; left: number; right: number };
      try {
        coords = view.coordsAtPos(from);
      } catch {
        return;
      }
      const dom = view.dom as HTMLElement;
      const scroller = findScrollableAncestor(dom);
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const caretY = (coords.top + coords.bottom) / 2;
      const delta = caretY - center;
      // Tolerance so we don't fight the user's own scroll wheel.
      if (Math.abs(delta) < 2) return;
      scroller.scrollTop += delta;
    });
  };
  editor.on('selectionUpdate', onSelection);
  editor.on('update', onSelection);
  editor.on('focus', onSelection);
  // Apply once immediately so toggling on while the caret is off-center
  // snaps it back without waiting for the next keystroke.
  onSelection();
  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    editor.off('selectionUpdate', onSelection);
    editor.off('update', onSelection);
    editor.off('focus', onSelection);
  };
}

function applyToActive(editor: Editor | null): void {
  editorCleanup?.();
  editorCleanup = null;
  if (!editor || editor.isDestroyed) return;
  editorCleanup = attach(editor);
}

export function setTypewriterMode(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  document.documentElement.setAttribute('data-typewriter', on ? 'on' : 'off');
  if (on) {
    unsubscribe?.();
    unsubscribe = subscribeActiveEditor(applyToActive);
    // Active editor at switch time also needs to be attached — the
    // subscriber fires only on future changes.
    import('./active-editor').then(({ getActiveEditor }) => {
      if (!enabled) return;
      applyToActive(getActiveEditor());
    });
  } else {
    unsubscribe?.();
    unsubscribe = null;
    editorCleanup?.();
    editorCleanup = null;
  }
}

export function isTypewriterModeOn(): boolean {
  return enabled;
}
