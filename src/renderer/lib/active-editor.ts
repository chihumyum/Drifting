import type { Editor } from '@tiptap/core';

// Tracks which Tiptap editor is currently focused / "active" for the user.
// Updated by editor components on focus / unmount; consumed by features that
// need to act on the editor the user is working in (find-in-editor, etc.).
//
// Editors may optionally register a `save` callback that flushes the current
// editor state through their view's persistence pipeline (used by Cmd+S).
let active: Editor | null = null;
const saveCallbacks = new WeakMap<Editor, () => void | Promise<void>>();
const listeners = new Set<(editor: Editor | null) => void>();

export function setActiveEditor(editor: Editor | null): void {
  if (active === editor) return;
  active = editor;
  listeners.forEach((fn) => fn(editor));
}

export function getActiveEditor(): Editor | null {
  return active && !active.isDestroyed ? active : null;
}

export function setEditorSaveCallback(
  editor: Editor,
  save: () => void | Promise<void>,
): void {
  saveCallbacks.set(editor, save);
}

export function clearEditorSaveCallback(editor: Editor): void {
  saveCallbacks.delete(editor);
}

export function saveActiveEditor(): boolean {
  const editor = getActiveEditor();
  if (!editor) return false;
  const save = saveCallbacks.get(editor);
  if (!save) return false;
  void save();
  return true;
}

export function subscribeActiveEditor(fn: (editor: Editor | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// If `editor` is currently the active one, clear it. Used by editor components
// on unmount to avoid a stale reference outliving the editor instance.
export function clearIfActive(editor: Editor | null): void {
  if (editor && active === editor) {
    setActiveEditor(null);
  }
}
