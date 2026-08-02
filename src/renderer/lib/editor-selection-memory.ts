import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

import type { AnyTab, LeafTab, TabRef } from '../store/ui-store';

export interface EditorSelectionSnapshot {
  version: number;
  from: number;
  to: number;
  focusOnRestore: boolean;
  mode: 'selection' | 'block';
  selectedText: string;
  selectedBlocks: Array<{
    id: string;
    ordinal: number;
    text: string;
  }>;
  contextBefore: string[];
  contextAfter: string[];
}

const SELECTION_SNAPSHOT_VERSION = 3;
const selections = new Map<string, EditorSelectionSnapshot>();
const listeners = new Set<() => void>();
let memoryRevision = 0;
const NEARBY_CONTEXT_BLOCKS = 4;
const NEARBY_CONTEXT_CHARS = 4_000;

function notifySelectionMemoryChanged(): void {
  memoryRevision += 1;
  for (const listener of listeners) listener();
}

export function subscribeEditorSelectionMemory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEditorSelectionMemoryRevision(): number {
  return memoryRevision;
}

interface SelectionMemoryBlock {
  id: string;
  ordinal: number;
  text: string;
  from: number;
  to: number;
  textblock: boolean;
}

function renderedBlockText(node: ProseMirrorNode): string {
  const text = node.textContent.trim();
  if (node.type.name === 'heading') {
    const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
    return `${'#'.repeat(Math.max(1, Math.min(6, level)))} ${text}`;
  }
  if (node.type.name === 'blockquote') return text ? `> ${text}` : '>';
  return text;
}

function clipContext(blocks: readonly SelectionMemoryBlock[]): string[] {
  const output: string[] = [];
  let chars = 0;
  for (const block of blocks) {
    if (!block.text) continue;
    if (output.length >= NEARBY_CONTEXT_BLOCKS) break;
    const remaining = NEARBY_CONTEXT_CHARS - chars;
    if (remaining <= 0) break;
    output.push(block.text.slice(0, remaining));
    chars += Math.min(block.text.length, remaining);
  }
  return output;
}

export function captureEditorSelectionSnapshot(
  editor: Editor,
  focusOnRestore = true,
): EditorSelectionSnapshot {
  const { from, to, empty } = editor.state.selection;
  const blocks: SelectionMemoryBlock[] = [];
  editor.state.doc.descendants((node, pos) => {
    const id = typeof node.attrs?.id === 'string' ? node.attrs.id : '';
    if (!id || !node.isBlock) return true;
    blocks.push({
      id,
      ordinal: blocks.length + 1,
      text: renderedBlockText(node),
      from: pos,
      to: pos + node.nodeSize,
      textblock: node.isTextblock,
    });
    return true;
  });

  const exactSelectedText = empty ? '' : editor.state.doc.textBetween(from, to, '\n').trim();
  const mode: EditorSelectionSnapshot['mode'] = exactSelectedText ? 'selection' : 'block';
  let selected = blocks.filter((block) => {
    if (mode === 'selection') return block.from < to && block.to > from;
    return block.textblock && block.from <= from && block.to >= from;
  });
  if (selected.length === 0 && blocks.length > 0) {
    selected = [
      blocks.reduce((best, block) =>
        Math.abs(block.from - from) < Math.abs(best.from - from) ? block : best,
      ),
    ];
  }
  const firstOrdinal = selected[0]?.ordinal ?? 1;
  const lastOrdinal = selected[selected.length - 1]?.ordinal ?? firstOrdinal;

  return {
    version: SELECTION_SNAPSHOT_VERSION,
    from,
    to,
    focusOnRestore,
    mode,
    selectedText:
      mode === 'selection'
        ? exactSelectedText
        : (selected.find((block) => block.textblock)?.text ?? selected[0]?.text ?? ''),
    selectedBlocks: selected.map(({ id, ordinal, text }) => ({ id, ordinal, text })),
    contextBefore: clipContext(
      blocks.filter((block) => block.ordinal < firstOrdinal).slice(-NEARBY_CONTEXT_BLOCKS),
    ),
    contextAfter: clipContext(
      blocks.filter((block) => block.ordinal > lastOrdinal).slice(0, NEARBY_CONTEXT_BLOCKS),
    ),
  };
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
  selections.set(key, captureEditorSelectionSnapshot(editor, focusOnRestore));
  notifySelectionMemoryChanged();
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

  let changed = false;
  for (const key of selections.keys()) {
    if (key.startsWith(prefix) && !liveKeys.has(key)) {
      selections.delete(key);
      changed = true;
    }
  }
  if (changed) notifySelectionMemoryChanged();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
