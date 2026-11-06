import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Editor } from '@tiptap/core';
import { getActiveEditor, subscribeActiveEditor } from '../../../lib/active-editor';
import {
  MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT,
  readMobileKeyboardInset,
} from '../workspace/mobile-keyboard-geometry';

export interface MobileWritingState {
  editor: Editor | null;
  /** The editor holds the caret. A hardware keyboard writes with no keyboard on screen. */
  writing: boolean;
  /** How far the on-screen keyboard reaches up from the bottom edge, px (0 when none). */
  keyboardInset: number;
  /** Bumps on every transaction and selection change, so format states re-read. */
  revision: number;
}

/**
 * Whether the author is writing: the active editor has focus. The keyboard's
 * own height follows the visual viewport and the native keyboard geometry the
 * Tauri host reports, so the bar above it rides on the keyboard's top edge.
 */
export function useMobileWriting(): MobileWritingState {
  const editor = useSyncExternalStore(subscribeActiveEditor, getActiveEditor, () => null);
  const [focused, setFocused] = useState(() => Boolean(editor?.isFocused));
  const [keyboardInset, setKeyboardInset] = useState(() => readMobileKeyboardInset());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setFocused(false);
      return undefined;
    }
    const sync = () => {
      if (editor.isDestroyed) return;
      setFocused(editor.isFocused);
      setRevision((value) => value + 1);
    };
    const bump = () => setRevision((value) => value + 1);
    queueMicrotask(sync);
    editor.on('focus', sync);
    editor.on('blur', sync);
    editor.on('selectionUpdate', bump);
    editor.on('transaction', bump);
    return () => {
      editor.off('focus', sync);
      editor.off('blur', sync);
      editor.off('selectionUpdate', bump);
      editor.off('transaction', bump);
    };
  }, [editor]);

  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const sync = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        setKeyboardInset(readMobileKeyboardInset());
      });
    };
    sync();
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    window.addEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, sync);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, sync);
    };
  }, []);

  const writing = Boolean(editor && !editor.isDestroyed && focused);
  return { editor: writing ? editor : editor ?? null, writing, keyboardInset: writing ? keyboardInset : 0, revision };
}
