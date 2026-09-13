import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/core';
import type { InlineEditBlockChange, InlineEditResult } from './inline-edit';
import type { Transaction } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

/** Bounded proposal precondition, not an alternative prose authority. */
export interface InlineEditSpanSource {
  blockId: string;
  blockKind: string;
  contentJson: string;
}

const documentIds = new WeakMap<PMNode, number>();
let nextDocumentId = 0;
function documentId(doc: PMNode): number {
  let id = documentIds.get(doc);
  if (id === undefined) { id = ++nextDocumentId; documentIds.set(doc, id); }
  return id;
}
interface SpanTracking {
  originalFrom: number; originalTo: number;
  from: number; to: number; documentId: number;
  valid: boolean; everTracked: boolean; owner: Editor | null;
}
// Weak keys and scalar revision IDs avoid retaining old document trees after
// the invocation closes. A source snapshot is never a second live document.
const trackedSpans = new WeakMap<InlineEditSpanSource, SpanTracking>();

function readSpanSource(doc: PMNode, from: number, to: number): InlineEditSpanSource | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > doc.content.size || from >= to) return null;
  const start = doc.resolve(from); const end = doc.resolve(to);
  if (!start.sameParent(end) || !start.parent.isTextblock || typeof start.parent.attrs.id !== 'string' || !start.parent.attrs.id) return null;
  return { blockId: start.parent.attrs.id, blockKind: start.parent.type.name, contentJson: JSON.stringify(doc.slice(from, to).content.toJSON()) };
}

export function captureInlineSpanSource(doc: PMNode, from: number, to: number): InlineEditSpanSource | null {
  const source = readSpanSource(doc, from, to);
  if (source) trackedSpans.set(source, { originalFrom: from, originalTo: to, from, to, documentId: documentId(doc), valid: true, everTracked: false, owner: null });
  return source;
}

function matchesSource(doc: PMNode, range: { from: number; to: number }, source: InlineEditSpanSource): boolean {
  const current = readSpanSource(doc, range.from, range.to);
  return Boolean(current && current.blockId === source.blockId && current.blockKind === source.blockKind && current.contentJson === source.contentJson);
}

function observeYjsSpan(editor: Editor, state: SpanTracking) {
  const sync = ySyncPluginKey.getState(editor.state) as {
    doc: Y.Doc; type: Y.XmlFragment; binding: { mapping: Parameters<typeof absolutePositionToRelativePosition>[2] };
  } | undefined;
  if (!sync) return null;
  const initialFromRelative: Y.RelativePosition = absolutePositionToRelativePosition(state.from, sync.type, sync.binding.mapping);
  const endRelative: Y.RelativePosition = absolutePositionToRelativePosition(state.to, sync.type, sync.binding.mapping);
  const start = Y.createAbsolutePositionFromRelativePosition(initialFromRelative, sync.doc);
  const end = Y.createAbsolutePositionFromRelativePosition(endRelative, sync.doc);
  if (!start || !end) state.valid = false;
  // Associate each edge with the selected content, excluding new text inserted
  // exactly before/after it. CRDT identities disambiguate repeated strings;
  // the ProseMirror diff of a remote update cannot reliably do that alone.
  const fromRelative = start ? Y.createRelativePositionFromTypeIndex(start.type, start.index, 0) : initialFromRelative;
  const toRelative = end ? Y.createRelativePositionFromTypeIndex(end.type, end.index, -1) : endRelative;
  let releaseText = () => {};
  if (start?.type instanceof Y.XmlText && start.type === end?.type) {
    const text = start.type; let from = start.index; let to = end.index;
    const observe = (event: Y.YTextEvent) => {
      if (!state.valid) return;
      let offset = 0;
      for (const delta of event.delta) {
        if (delta.insert !== undefined && offset > from && offset < to) state.valid = false;
        if (delta.delete && offset < to && offset + delta.delete > from) state.valid = false;
        if (delta.retain && delta.attributes && Object.keys(delta.attributes).length && offset < to && offset + delta.retain > from) state.valid = false;
        offset += delta.delete ?? delta.retain ?? 0;
      }
      const currentFrom = Y.createAbsolutePositionFromRelativePosition(fromRelative, sync.doc);
      const currentTo = Y.createAbsolutePositionFromRelativePosition(toRelative, sync.doc);
      if (!currentFrom || !currentTo || currentFrom.type !== text || currentTo.type !== text) state.valid = false;
      else { from = currentFrom.index; to = currentTo.index; }
    };
    text.observe(observe); releaseText = () => text.unobserve(observe);
  }
  return {
    resolve: () => {
      const from = relativePositionToAbsolutePosition(sync.doc, sync.type, fromRelative, sync.binding.mapping);
      const to = relativePositionToAbsolutePosition(sync.doc, sync.type, toRelative, sync.binding.mapping);
      return from === null || to === null ? null : { from, to };
    },
    release: releaseText,
  };
}

/** Attached only while this invocation owns a visible popover. */
export function trackInlineEditSpan(editor: Editor, source: InlineEditSpanSource): () => void {
  const state = trackedSpans.get(source);
  if (!state) return () => {};
  // A transaction between capture and mounting, or during a detached period,
  // cannot be reconstructed safely from final text (repeated text may match).
  if (state.owner || state.documentId !== documentId(editor.state.doc)) { state.valid = false; return () => {}; }
  state.everTracked = true; state.owner = editor;
  const yjs = observeYjsSpan(editor, state);
  const onTransaction = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions: Transaction[] }) => {
    if (!state.valid) return;
    if (yjs) {
      // Resolve against the canonical Yjs identities after the binding updated.
      // Y.Text observation detects even replacements with identical final text.
      const range = yjs.resolve();
      if (!range || !matchesSource(editor.state.doc, range, source)) { state.valid = false; return; }
      state.from = range.from; state.to = range.to; state.documentId = documentId(editor.state.doc);
      return;
    }
    for (const tr of [transaction, ...appendedTransactions]) {
      if (state.documentId !== documentId(tr.before)) { state.valid = false; return; }
      for (const map of tr.mapping.maps) {
        let touched = false;
        map.forEach((from, to) => {
          if ((from < state.to && to > state.from) || (from === to && from > state.from && from < state.to)) touched = true;
        });
        if (touched) { state.valid = false; return; }
        state.from = map.map(state.from, 1); state.to = map.map(state.to, -1);
      }
      state.documentId = documentId(tr.doc);
      if (tr.docChanged && !matchesSource(tr.doc, state, source)) { state.valid = false; return; }
    }
  };
  editor.on('transaction', onTransaction);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    editor.off('transaction', onTransaction);
    yjs?.release();
    if (state.owner === editor) state.owner = null;
  };
}

function commitProposal(editor: Editor, transaction: Transaction): void {
  const undoManager = yUndoPluginKey.getState(editor.state)?.undoManager;
  undoManager?.stopCapturing();
  try {
    editor.view.dispatch(closeHistory(transaction).scrollIntoView());
  } finally {
    // The preceding and following author keystrokes are distinct operations,
    // including when a local model returns within the history capture window.
    if (undoManager) undoManager.stopCapturing();
    else editor.view.dispatch(closeHistory(editor.state.tr));
  }
  editor.view.focus();
}

/** Validate the entire authored target before dispatching one live transaction. */
export function applyInlineEdit(editor: Editor, result: InlineEditResult): boolean {
  if (editor.isDestroyed || !editor.isEditable || result.refused) return false;
  if (result.span) return applySpan(editor, result.span);
  if (result.blocks) return applyBlocks(editor, result.blocks);
  return false;
}

function applySpan(editor: Editor, span: NonNullable<InlineEditResult['span']>): boolean {
  const { source } = span;
  const state = source && trackedSpans.get(source);
  if (!source || !state?.valid || (state.everTracked && state.owner !== editor)
    || state.originalFrom !== span.from || state.originalTo !== span.to
    || state.documentId !== documentId(editor.state.doc) || !matchesSource(editor.state.doc, state, source)) return false;
  const { from, to } = state;
  // A span stays in one block. Treat model output as literal text, including
  // angle brackets, and inherit marks from the actual target rather than HTML.
  const text = span.newText.replace(/\s*\n\s*/g, ' ').trim();
  const editorState = editor.state;
  const tr = text
    ? editorState.tr.replaceWith(from, to, editorState.schema.text(text, editorState.doc.resolve(from).marks()))
    : editorState.tr.delete(from, to);
  commitProposal(editor, tr);
  return true;
}

function applyBlocks(editor: Editor, blocks: InlineEditBlockChange[]): boolean {
  if (blocks.length === 0) return false;
  const ids = new Set(blocks.map(block => block.id));
  if (ids.size !== blocks.length) return false;
  const { state } = editor;
  const locations = new Map<string, { pos: number; node: PMNode }>();
  let duplicate = false;
  state.doc.descendants((node, pos) => {
    const id = node.attrs.id;
    if (node.isTextblock && ids.has(id)) {
      if (locations.has(id)) duplicate = true;
      locations.set(id, { pos, node }); return false;
    }
  });
  // Include unchanged model rows: this was one authored region, so a missing or
  // concurrently changed target must never produce a surviving subset of edits.
  if (duplicate || blocks.some(block => {
    const location = locations.get(block.id);
    return !location || JSON.stringify(location.node.toJSON()) !== block.sourceJson;
  })) return false;
  const changes = blocks.filter(block => block.changed)
    .map(block => ({ block, location: locations.get(block.id)! }))
    .sort((a, b) => b.location.pos - a.location.pos);
  if (changes.length === 0) return true;
  const tr = state.tr;
  for (const { block, location } of changes) {
    const from = location.pos + 1; const to = from + location.node.content.size;
    if (block.newText) tr.replaceWith(from, to, state.schema.text(block.newText));
    else tr.delete(from, to);
  }
  commitProposal(editor, tr);
  return true;
}
