import type { Editor } from '@tiptap/core';
import {
  TYPEWRITER_POSITION_DEFAULT,
  TYPEWRITER_POSITION_MAX,
  TYPEWRITER_POSITION_MIN,
} from '../../store/settings-store';

const CARET_TAIL_BUFFER_PX = 24;
const CARET_REPAINT_ATTRIBUTE = 'data-typewriter-caret-repaint';

interface CaretRepaintElement {
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
}

interface CaretRepaintCompensation {
  beforeScroll: () => void;
  dispose: () => void;
}

/**
 * WebKit can leave the old native contenteditable caret painted when an
 * overflow ancestor is moved programmatically. Suppress it for the scroll
 * paint, then restore it on the following frame so WebKit redraws only the
 * caret at its new viewport position.
 */
export function createCaretRepaintCompensation(
  element: CaretRepaintElement,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): CaretRepaintCompensation {
  let restoreFrame = 0;

  const restore = (): void => {
    restoreFrame = 0;
    element.removeAttribute(CARET_REPAINT_ATTRIBUTE);
  };

  return {
    beforeScroll() {
      if (restoreFrame) cancelFrame(restoreFrame);
      element.setAttribute(CARET_REPAINT_ATTRIBUTE, 'on');
      restoreFrame = requestFrame(restore);
    },
    dispose() {
      if (restoreFrame) cancelFrame(restoreFrame);
      restore();
    },
  };
}

export function normalizeTypewriterPosition(position: number): number {
  if (!Number.isFinite(position)) return TYPEWRITER_POSITION_DEFAULT;
  return Math.max(
    TYPEWRITER_POSITION_MIN,
    Math.min(TYPEWRITER_POSITION_MAX, Math.round(position)),
  );
}

export function typewriterTailSpace(viewportHeight: number, position: number): number {
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const normalizedPosition = normalizeTypewriterPosition(position);
  return Math.ceil(
    height * (1 - normalizedPosition / 100) + CARET_TAIL_BUFFER_PX,
  );
}

interface TypewriterScrollTarget {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportTop: number;
  caretTop: number;
  caretBottom: number;
  position: number;
}

export function nextTypewriterScrollTop({
  scrollTop,
  scrollHeight,
  viewportHeight,
  viewportTop,
  caretTop,
  caretBottom,
  position,
}: TypewriterScrollTarget): number {
  const normalizedPosition = normalizeTypewriterPosition(position);
  const caretCenter = (caretTop + caretBottom) / 2;
  const targetCenter = viewportTop + viewportHeight * (normalizedPosition / 100);
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  return Math.max(0, Math.min(maxScrollTop, scrollTop + caretCenter - targetCenter));
}

export interface TypewriterPresentation {
  isVisible: boolean;
  isPreparing: boolean;
}

/** Owns display work only. Hidden editors keep their document and visual tail. */
export class TypewriterScrollController {
  private attached = false;
  private listening = false;
  private visible = false;
  private needed = false;
  private position = TYPEWRITER_POSITION_DEFAULT;
  private alignmentFrame = 0;
  private viewport: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private caretRepaint: CaretRepaintCompensation | null = null;

  constructor(readonly editor: Editor) {}

  attach(): () => void {
    if (this.attached) throw new Error('Typewriter controller already attached');
    if (this.editor.isDestroyed) return () => undefined;
    this.attached = true;
    this.caretRepaint = createCaretRepaintCompensation(this.editor.view.dom);
    this.editor.on('destroy', this.dispose);
    this.resume();
    return this.dispose;
  }

  setPresentation({ isVisible, isPreparing }: TypewriterPresentation, position: number): void {
    const wasVisible = this.visible;
    const positionChanged = this.position !== normalizeTypewriterPosition(position);
    this.visible = isVisible;
    this.needed = isVisible || isPreparing;
    this.position = normalizeTypewriterPosition(position);
    if (!this.needed) {
      this.pause();
      return;
    }
    if (!this.attached || this.editor.isDestroyed) return;
    const resumed = this.resume();
    if (positionChanged && !resumed) this.updateTailSpace();
    if (isVisible && (!wasVisible || positionChanged)) this.scheduleAlignment();
  }

  private clearTail(): void {
    this.viewport?.removeAttribute('data-typewriter-scroll');
    this.viewport?.style.removeProperty('--editor-typewriter-tail-space');
  }

  private updateTailSpace(): void {
    if (!this.listening || !this.viewport) return;
    const height = this.viewport.clientHeight;
    const value = `${typewriterTailSpace(height, this.position)}px`;
    if (this.viewport.style.getPropertyValue('--editor-typewriter-tail-space') !== value) {
      this.viewport.style.setProperty('--editor-typewriter-tail-space', value);
    }
  }

  private bindViewport(): HTMLElement | null {
    const next = this.editor.view.dom.closest<HTMLElement>('.editor-scroll');
    if (next !== this.viewport) {
      this.resizeObserver?.disconnect();
      this.clearTail();
      this.viewport = next;
      if (next) {
        next.setAttribute('data-typewriter-scroll', 'on');
        this.updateTailSpace();
        this.resizeObserver?.observe(next);
      }
    }
    return this.viewport;
  }

  private onResize = (): void => {
    if (!this.listening) return; // A queued delivery may outlive disconnect().
    this.updateTailSpace();
    this.scheduleAlignment();
  };

  private resume(): boolean {
    if (!this.attached || !this.needed || this.listening || this.editor.isDestroyed) return false;
    this.listening = true;
    this.resizeObserver = new ResizeObserver(this.onResize);
    const previous = this.viewport;
    this.bindViewport();
    if (this.viewport && this.viewport === previous) {
      this.updateTailSpace();
      this.resizeObserver.observe(this.viewport);
    }
    this.editor.on('focus', this.scheduleAlignment);
    this.editor.on('selectionUpdate', this.scheduleAlignment);
    this.editor.on('update', this.scheduleAlignment);
    this.scheduleAlignment();
    return true;
  }

  private alignCaret = (): void => {
    this.alignmentFrame = 0;
    if (!this.listening || !this.visible || this.editor.isDestroyed ||
        !this.editor.isFocused || !this.editor.state.selection.empty) return;
    const viewport = this.bindViewport();
    if (!viewport) return;
    try {
      const caret = this.editor.view.coordsAtPos(this.editor.state.selection.head);
      const rect = viewport.getBoundingClientRect();
      const next = nextTypewriterScrollTop({
        scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight,
        viewportHeight: viewport.clientHeight, viewportTop: rect.top,
        caretTop: caret.top, caretBottom: caret.bottom, position: this.position,
      });
      if (Math.abs(next - viewport.scrollTop) > 0.5) {
        this.caretRepaint?.beforeScroll();
        viewport.scrollTop = next;
      }
    } catch {
      // View detachment can race a frame; retry on the next real editor event.
    }
  };

  private scheduleAlignment = (): void => {
    if (!this.listening || !this.visible || this.editor.isDestroyed ||
        !this.editor.isFocused || !this.editor.state.selection.empty || this.alignmentFrame) return;
    this.alignmentFrame = requestAnimationFrame(this.alignCaret);
  };

  private pause(): void {
    if (this.listening) {
      this.listening = false;
      this.editor.off('focus', this.scheduleAlignment);
      this.editor.off('selectionUpdate', this.scheduleAlignment);
      this.editor.off('update', this.scheduleAlignment);
    }
    if (this.alignmentFrame) cancelAnimationFrame(this.alignmentFrame);
    this.alignmentFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.caretRepaint?.dispose();
    // Keep tail geometry while hidden: removing it can clamp retained scrollTop.
  }

  private dispose = (): void => {
    if (!this.attached) return;
    this.pause();
    this.editor.off('destroy', this.dispose);
    this.clearTail();
    this.viewport = null;
    this.caretRepaint = null;
    this.attached = false;
  };
}
