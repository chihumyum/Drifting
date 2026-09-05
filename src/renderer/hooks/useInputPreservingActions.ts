import { useRef, type HTMLAttributes } from 'react';

/** A press becomes an action only after release, never after a pan or cancel. */
export class InputActionGesture<T> {
  private press: { id: number; x: number; y: number; target: T; cancelled: boolean } | null = null;

  start(id: number, x: number, y: number, target: T) {
    this.press = { id, x, y, target, cancelled: false };
  }

  move(id: number, x: number, y: number) {
    const press = this.press;
    if (press?.id === id && Math.hypot(x - press.x, y - press.y) > 8) press.cancelled = true;
  }

  cancel() {
    if (this.press) this.press.cancelled = true;
  }

  finish(x: number, y: number): T | null {
    const press = this.press;
    this.press = null;
    return press && !press.cancelled && Math.hypot(x - press.x, y - press.y) <= 8
      ? press.target
      : null;
  }
}

function isInputTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function actionAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (isInputTarget(target)) return null;
  return target.closest<HTMLElement>('button, [role="button"], [role="switch"], [role="menuitem"]');
}

/**
 * A mobile accessory is part of the current input session. Cancel WebKit's
 * native touchend focus default before invoking an action that may remove its
 * own button. Pointer/mouse cancellation alone does not cover that default.
 * React capture also follows portalled children, such as the Agent menu.
 */
export function useInputPreservingActions<T extends HTMLElement>(enabled = true, preserveBackground = false): HTMLAttributes<T> {
  const gesture = useRef(new InputActionGesture<HTMLElement>());
  return {
    onPointerDownCapture(event) {
      if (!enabled) return;
      const action = actionAt(event.target) ??
        (preserveBackground && !isInputTarget(event.target) ? event.currentTarget : null);
      if (!action) { gesture.current.cancel(); return; }
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
        gesture.current.cancel();
        return;
      }
      gesture.current.start(event.pointerId, event.clientX, event.clientY, action);
      event.preventDefault();
    },
    onPointerMoveCapture(event) {
      if (enabled) gesture.current.move(event.pointerId, event.clientX, event.clientY);
    },
    onPointerCancelCapture() {
      gesture.current.cancel();
    },
    onTouchEndCapture(event) {
      if (!enabled) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const action = gesture.current.finish(touch.clientX, touch.clientY);
      if (!action) return;
      // Do this before click: Undo may disappear, or a tool may replace the row.
      event.preventDefault();
      event.stopPropagation();
      if (!actionAt(action)) return;
      const rect = action.getBoundingClientRect();
      if (touch.clientX < rect.left || touch.clientX > rect.right ||
          touch.clientY < rect.top || touch.clientY > rect.bottom ||
          action.matches(':disabled, [aria-disabled="true"]')) return;
      action.click();
    },
    onMouseDownCapture(event) {
      if (enabled && (actionAt(event.target) || (preserveBackground && !isInputTarget(event.target)))) event.preventDefault();
    },
    onClickCapture(event) {
      if (!enabled || !actionAt(event.target) || event.detail === 0) return;
      // Keyboard/assistive activation has detail=0. A native mouse click (or a
      // bridge without touch events) still needs a completed stationary press.
      const action = gesture.current.finish(event.clientX, event.clientY);
      if (!action || action !== actionAt(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
