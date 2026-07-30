import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import {
  TYPEWRITER_POSITION_DEFAULT,
  TYPEWRITER_POSITION_MAX,
  TYPEWRITER_POSITION_MIN,
  useSettingsStore,
} from '../store/settings-store';

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

/**
 * Keep the collapsed caret line at a stable vertical position inside the
 * nearest editor scroll viewport.
 *
 * The hook is opt-in per primary prose surface. Small embedded editors (patch
 * cards, templates and popovers) deliberately do not take over the enclosing
 * page's scroll position.
 */
export function useTypewriterScrolling(
  editor: Editor | null,
  eligible: boolean,
): void {
  const enabled = useSettingsStore((state) => state.typewriterMode);
  const position = useSettingsStore((state) => state.typewriterPosition);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !eligible || !enabled) return;

    let animationFrame = 0;
    let scrollElement: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const caretRepaint = createCaretRepaintCompensation(editor.view.dom);

    const updateTailSpace = (): void => {
      if (!scrollElement) return;
      scrollElement.style.setProperty(
        '--editor-typewriter-tail-space',
        `${typewriterTailSpace(scrollElement.clientHeight, position)}px`,
      );
    };

    const bindScrollElement = (): HTMLElement | null => {
      const next = editor.view.dom.closest<HTMLElement>('.editor-scroll');
      if (next === scrollElement) return scrollElement;

      if (scrollElement) {
        resizeObserver?.disconnect();
        scrollElement.removeAttribute('data-typewriter-scroll');
        scrollElement.style.removeProperty('--editor-typewriter-tail-space');
      }

      scrollElement = next;
      if (!scrollElement) return null;

      scrollElement.setAttribute('data-typewriter-scroll', 'on');
      updateTailSpace();
      resizeObserver = new ResizeObserver(() => {
        updateTailSpace();
        scheduleAlignment();
      });
      resizeObserver.observe(scrollElement);
      return scrollElement;
    };

    const alignCaret = (): void => {
      animationFrame = 0;
      if (editor.isDestroyed || !editor.isFocused || !editor.state.selection.empty) return;
      const viewport = bindScrollElement();
      if (!viewport) return;

      try {
        const caret = editor.view.coordsAtPos(editor.state.selection.head);
        const viewportRect = viewport.getBoundingClientRect();
        const nextScrollTop = nextTypewriterScrollTop({
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          viewportHeight: viewport.clientHeight,
          viewportTop: viewportRect.top,
          caretTop: caret.top,
          caretBottom: caret.bottom,
          position,
        });
        if (Math.abs(nextScrollTop - viewport.scrollTop) > 0.5) {
          caretRepaint.beforeScroll();
          viewport.scrollTop = nextScrollTop;
        }
      } catch {
        // The editor may have been detached between the event and animation
        // frame during tab switches. The next focus/update event will retry.
      }
    };

    function scheduleAlignment(): void {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(alignCaret);
    }

    bindScrollElement();
    editor.on('focus', scheduleAlignment);
    editor.on('selectionUpdate', scheduleAlignment);
    editor.on('update', scheduleAlignment);
    scheduleAlignment();

    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      editor.off('focus', scheduleAlignment);
      editor.off('selectionUpdate', scheduleAlignment);
      editor.off('update', scheduleAlignment);
      resizeObserver?.disconnect();
      caretRepaint.dispose();
      if (scrollElement) {
        scrollElement.removeAttribute('data-typewriter-scroll');
        scrollElement.style.removeProperty('--editor-typewriter-tail-space');
      }
    };
  }, [editor, eligible, enabled, position]);
}
