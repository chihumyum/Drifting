import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, TextSelection, type Selection } from '@tiptap/pm/state';
import { clearIfActive, getActiveEditor, subscribeActiveEditor } from '../../lib/active-editor';
import { countWords, extractProseText } from '../../lib/word-count';

/** Read-only, transient metric for the focused prose selection. */
export function createEditorSelectionWordCountStore() {
  let cachedDoc: ProseMirrorNode | null = null;
  let cachedSelection: Selection | null = null;
  let count: number | null = null;

  const getSnapshot = (): number | null => {
    const editor = getActiveEditor();
    const selection = editor?.state.selection;
    if (!editor?.isFocused || !selection || selection.empty ||
      !(selection instanceof TextSelection || selection instanceof AllSelection)) {
      cachedDoc = null;
      cachedSelection = null;
      count = null;
      return null;
    }
    if (cachedDoc !== editor.state.doc || cachedSelection !== selection) {
      cachedDoc = editor.state.doc;
      cachedSelection = selection;
      // Count only the selected slice, preserving the canonical PM child-boundary
      // rule (including inline marks and hard breaks) without serializing the book.
      count = countWords(extractProseText({
        type: 'doc', content: selection.content().content.toJSON() ?? [],
      }));
    }
    return count;
  };

  const subscribe = (onChange: () => void) => {
    let current: Editor | null = null;
    const events = ['selectionUpdate', 'update', 'focus', 'blur'] as const;
    // Tiptap emits destroy before its view reports isDestroyed.
    const onDestroy = () => clearIfActive(current);
    const detach = () => {
      for (const event of events) current?.off(event, onChange);
      current?.off('destroy', onDestroy);
    };
    const bind = () => {
      detach();
      current = getActiveEditor();
      for (const event of events) current?.on(event, onChange);
      current?.on('destroy', onDestroy);
      onChange();
    };
    const unsubscribe = subscribeActiveEditor(bind);
    bind();
    return () => {
      unsubscribe();
      detach();
    };
  };

  return { getSnapshot, subscribe };
}
