import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import type { AnyTab, LeafTab, TabRef } from '../store/ui-store';

/** Session-only position memory. Never retains document nodes or prose context. */
export interface EditorSelectionSnapshot {
  anchor: number;
  head: number;
  focusOnRestore: boolean;
}

const selections = new Map<string, EditorSelectionSnapshot>();

export function captureEditorSelectionSnapshot(
  editor: Editor,
  focusOnRestore = true,
): EditorSelectionSnapshot {
  const { anchor, head } = editor.state.selection;
  return { anchor, head, focusOnRestore };
}

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
  return selections.get(key) ?? null;
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
  const next = captureEditorSelectionSnapshot(editor, focusOnRestore);
  const previous = selections.get(key);
  if (previous?.anchor === next.anchor && previous.head === next.head && previous.focusOnRestore === next.focusOnRestore) return;
  selections.set(key, next);
}

/** Restore positions only. The session owns focus, scroll and cancellation. */
export function restoreEditorSelectionSnapshot(
  key: string | null | undefined,
  editor: Editor,
): boolean {
  const snapshot = getEditorSelectionSnapshot(key);
  if (!snapshot || editor.isDestroyed) return false;

  const maxPos = editor.state.doc.content.size;
  const anchor = clamp(snapshot.anchor, 0, maxPos);
  const head = clamp(snapshot.head, 0, maxPos);

  try {
    const selection = TextSelection.between(
      editor.state.doc.resolve(anchor),
      editor.state.doc.resolve(head),
    );
    const tr = editor.state.tr.setSelection(selection);
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
  } catch {
    return false;
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
    } else if (tab.kind === 'split') {
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
