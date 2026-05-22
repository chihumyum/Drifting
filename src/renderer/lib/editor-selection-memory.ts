import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import type { AnyTab, LeafTab, TabRef } from '../store/ui-store';

export interface EditorSelectionSnapshot {
  version: number;
  from: number;
  to: number;
  focusOnRestore: boolean;
}

const SELECTION_SNAPSHOT_VERSION = 2;
const selections = new Map<string, EditorSelectionSnapshot>();

export function editorTabSelectionKey(
  projectId: string,
  ref: Pick<TabRef, 'entityType' | 'id'>,
): string {
  return `${projectId}:${ref.entityType}:${ref.id}`;
}

export function getEditorSelectionSnapshot(
  key: string | null | undefined,
): EditorSelectionSnapshot | null {
  if (!key) return null;
  const snapshot = selections.get(key);
  if (!snapshot || snapshot.version !== SELECTION_SNAPSHOT_VERSION) {
    if (snapshot) selections.delete(key);
    return null;
  }
  return snapshot;
}

export function hasEditorSelectionSnapshot(key: string | null | undefined): boolean {
  return Boolean(key && selections.has(key));
}

export function saveEditorSelectionSnapshot(
  key: string | null | undefined,
  editor: Editor,
  focusOnRestore = true,
): void {
  if (!key || editor.isDestroyed) return;
  const { from, to } = editor.state.selection;
  selections.set(key, { version: SELECTION_SNAPSHOT_VERSION, from, to, focusOnRestore });
}

export function restoreEditorSelectionSnapshot(
  key: string | null | undefined,
  editor: Editor,
): boolean {
  const snapshot = getEditorSelectionSnapshot(key);
  if (!snapshot || editor.isDestroyed) return false;

  const maxPos = editor.state.doc.content.size;
  const from = clamp(snapshot.from, 0, maxPos);
  const to = clamp(snapshot.to, 0, maxPos);
  const start = Math.min(from, to);
  const end = Math.max(from, to);

  try {
    const selection = TextSelection.between(
      editor.state.doc.resolve(start),
      editor.state.doc.resolve(end),
    );
    let tr = editor.state.tr.setSelection(selection);
    tr.setMeta('addToHistory', false);
    if (snapshot.focusOnRestore) {
      tr = tr.scrollIntoView();
    }
    editor.view.dispatch(tr);
  } catch {
    return false;
  }

  if (snapshot.focusOnRestore) {
    requestAnimationFrame(() => {
      if (!editor.isDestroyed) {
        editor.commands.focus();
      }
    });
  }
  return true;
}

export function moveEditorSelectionToStart(editor: Editor): boolean {
  if (editor.isDestroyed) return false;
  try {
    const selection = TextSelection.atStart(editor.state.doc);
    const tr = editor.state.tr.setSelection(selection);
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
    return true;
  } catch {
    return false;
  }
}

export function pruneEditorSelectionMemory(projectId: string, openTabs: AnyTab[]): void {
  const prefix = `${projectId}:`;
  const liveKeys = new Set<string>();
  const addLeaf = (leaf: LeafTab) => {
    liveKeys.add(editorTabSelectionKey(projectId, leaf));
  };

  for (const tab of openTabs) {
    if (tab.kind === 'leaf') {
      addLeaf(tab);
    } else {
      addLeaf(tab.left);
      addLeaf(tab.right);
    }
  }

  for (const key of selections.keys()) {
    if (key.startsWith(prefix) && !liveKeys.has(key)) {
      selections.delete(key);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
