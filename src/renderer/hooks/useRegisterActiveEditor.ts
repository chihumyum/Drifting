import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import {
  setActiveEditor,
  clearIfActive,
  setEditorSaveCallback,
  clearEditorSaveCallback,
} from '../lib/active-editor';

// Wire a Tiptap editor instance into the global active-editor registry. The
// editor becomes "active" while focused; if it's the only editor on screen,
// we still mark it active on mount so Cmd+F works without clicking first.
//
// `save` is an optional callback invoked by Cmd+S. We hold it through a ref
// so that callers can pass an inline arrow function without re-binding the
// registry on every render.
export function useRegisterActiveEditor(
  editor: Editor | null,
  save?: () => void | Promise<void>,
): void {
  const saveRef = useRef(save);
  useLayoutEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (!editor) return;

    setActiveEditor(editor);
    setEditorSaveCallback(editor, () => saveRef.current?.());

    const onFocus = () => setActiveEditor(editor);
    editor.on('focus', onFocus);

    return () => {
      editor.off('focus', onFocus);
      clearEditorSaveCallback(editor);
      clearIfActive(editor);
    };
  }, [editor]);
}
