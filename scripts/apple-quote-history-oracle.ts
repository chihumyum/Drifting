import assert from 'node:assert/strict';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  defaultDeleteFilter, defaultProtectedNodes, initProseMirrorDoc,
  prosemirrorJSONToYDoc, updateYFragment, yDocToProsemirrorJSON, ySyncPluginKey,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { getStaticChapterSchema } from '../src/renderer/components/editor/chapter-static-html';
import { createBlockIdPlugin } from '../src/renderer/lib/extensions/block-id';

// Actual production PM -> y-tiptap diff and default UndoManager policy. The
// resulting remote deltas address original CRDT items, not renamed domain IDs.
const schema = getStaticChapterSchema();
if (!schema) throw new Error('The real chapter schema must be available');
const paragraph = (id: string, text: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
const quote = (id: string, content: unknown[]) => ({ type: 'blockquote', attrs: { id }, content });
const safe = { type: 'doc', content: [quote('qleft', [paragraph('b', '潮汐')]), quote('qright', [paragraph('c', '夜航'), paragraph('d', '终章')])] };
const complex = { type: 'doc', content: [quote('qleft', [paragraph('a', '开篇'), paragraph('b', '潮汐')]), quote('qright', [paragraph('c', '夜航'), paragraph('d', '终章')])] };
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
function element(parent: Y.XmlFragment, index: number): Y.XmlElement {
  const value = parent.get(index);
  assert(value instanceof Y.XmlElement);
  return value;
}
function text(block: Y.XmlElement): Y.XmlText {
  const value = block.get(0);
  assert(value instanceof Y.XmlText);
  return value;
}
function itemId(value: Y.XmlElement) {
  assert(value._item);
  return `${value._item.id.client}:${value._item.id.clock}`;
}
function position(doc: PMNode, offset: number) {
  let at = 0, result: number | undefined;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (result === undefined && at <= offset && offset <= at + node.content.size) result = pos + 1 + offset - at;
    at += node.content.size + 1;
    return false;
  });
  assert(result !== undefined, `No text position for ${offset}`);
  return result;
}
function find(root: Y.XmlFragment, id: string): Y.XmlElement | undefined {
  for (const child of root.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.getAttribute('id') === id) return child;
    const nested = find(child, id);
    if (nested) return nested;
  }
  return undefined;
}
function visibleText(root: Y.XmlFragment): string {
  return root.toArray().map((child) => child instanceof Y.XmlText ? child.toString()
    : child instanceof Y.XmlElement ? visibleText(child) : '').join('');
}
function anonymousParagraph(root: Y.XmlFragment): boolean {
  return root.toArray().some((child) => child instanceof Y.XmlElement
    && (child.nodeName === 'paragraph' && !child.getAttribute('id') || anonymousParagraph(child)));
}
function join(input: unknown, at: number, length = 1) {
  const document = prosemirrorJSONToYDoc(schema!, input, 'default');
  const root = document.getXmlFragment('default');
  const before = encoded(Y.encodeStateAsUpdate(document));
  const originalRight = element(root, 1), originalC = element(originalRight, 0), originalD = element(originalRight, 1);
  const identities = { wrapper: itemId(originalRight), joinedBlock: itemId(originalC), suffix: itemId(originalD) };
  const initialized = initProseMirrorDoc(root, schema!);
  let state = EditorState.create({ schema: schema!, doc: initialized.doc,
    selection: TextSelection.create(initialized.doc, position(initialized.doc, at), position(initialized.doc, at + length)),
    plugins: [createBlockIdPlugin()] });
  const undo = new Y.UndoManager(root, { trackedOrigins: new Set([ySyncPluginKey]),
    deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes) });
  state = state.applyTransaction(state.tr.insertText('')).state;
  updateYFragment(document, root, state.doc, initialized.meta);
  undo.stopCapturing();
  return { document, root, undo, before, identities, originalD, expected: state.doc.toJSON() };
}

function acceptedCase(partialDelete = false) {
  const at = partialDelete ? 1 : 2, length = partialDelete ? 3 : 1;
  const run = join(safe, at, length);
  const { document, root, undo, identities, originalD } = run;
  const originalPeer = new Y.Doc();
  Y.applyUpdate(originalPeer, Buffer.from(run.before, 'base64'));
  const stages: unknown[] = [];
  const suffix = () => {
    const value = find(root, 'd');
    assert(value, 'Unselected original suffix must stay visible');
    assert.equal(itemId(value), identities.suffix);
    assert.equal(value, originalD);
    return value;
  };
  const snapshot = (name: string, action: 'joined' | 'apply' | 'undo' | 'redo', updateBase64?: string) => {
    const block = suffix();
    stages.push({ name, action, ...(updateBase64 ? { updateBase64 } : {}),
      semantic: yDocToProsemirrorJSON(document, 'default'),
      suffix: { itemId: itemId(block), text: text(block).toString(), attributes: block.getAttributes() } });
  };
  try {
    assert.equal(root.length, 1);
    assert.equal(itemId(element(root, 0)), identities.wrapper);
    assert.equal(element(root, 0).getAttribute('id'), 'qleft');
    assert.equal(itemId(element(element(root, 0), 0)), identities.joinedBlock);
    assert.equal(element(element(root, 0), 0).getAttribute('id'), 'b');
    assert.equal(text(element(element(root, 0), 0)).toString(), partialDelete ? '潮航' : '潮汐夜航');
    snapshot('joined', 'joined');

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
    const vector = Y.encodeStateVector(peer);
    const remoteSuffix = find(peer.getXmlFragment('default'), 'd');
    assert(remoteSuffix);
    text(remoteSuffix).insert(0, '远');
    remoteSuffix.setAttribute('futureSuffix', 'retained');
    const update = Y.encodeStateAsUpdate(peer, vector);
    Y.applyUpdate(document, update, 'remote'); peer.destroy();
    snapshot('remote suffix text and metadata', 'apply', encoded(update));
    assert(undo.undo());
    assert.equal(root.length, 2);
    assert.equal(text(suffix()).toString(), '远终章');
    assert.equal(suffix().getAttribute('futureSuffix'), 'retained');
    snapshot('undo keeps original remote suffix', 'undo');

    const originalVector = Y.encodeStateVector(originalPeer);
    const lateSuffix = find(originalPeer.getXmlFragment('default'), 'd');
    assert(lateSuffix);
    text(lateSuffix).insert(text(lateSuffix).length, '迟');
    lateSuffix.setAttribute('lateSuffix', 'original-item');
    const late = Y.encodeStateAsUpdate(originalPeer, originalVector);
    Y.applyUpdate(document, late, 'remote');
    assert.equal(text(suffix()).toString(), '远终章迟');
    snapshot('late edit to original suffix while undone', 'apply', encoded(late));
    for (const action of ['redo', 'undo', 'redo'] as const) {
      assert(undo[action]());
      assert.equal(text(suffix()).toString(), '远终章迟');
      assert.equal(suffix().getAttribute('futureSuffix'), 'retained');
      assert.equal(suffix().getAttribute('lateSuffix'), 'original-item');
      snapshot(`${action} preserves both remote suffix edits`, action);
    }
    return { name: partialDelete ? 'delete across adjacent quotes preserving right suffix identity'
      : 'join adjacent quotes preserving right suffix identity', before: safe, updateBase64: run.before,
      range: { location: at, length }, text: '', expected: run.expected, identities, stages };
  } finally { undo.destroy(); originalPeer.destroy(); document.destroy(); }
}

function diagnosticCase() {
  const run = join(complex, 5);
  const { document, root, undo } = run;
  const originalPeer = new Y.Doc();
  Y.applyUpdate(originalPeer, Buffer.from(run.before, 'base64'));
  try {
    const joined = yDocToProsemirrorJSON(document, 'default');
    const suffix = find(root, 'd'); assert(suffix);
    const copiedSuffix = itemId(suffix) !== run.identities.suffix;
    const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
    const vector = Y.encodeStateVector(peer);
    const remoteSuffix = find(peer.getXmlFragment('default'), 'd'); assert(remoteSuffix);
    text(remoteSuffix).insert(0, '远'); remoteSuffix.setAttribute('futureSuffix', 'retained');
    Y.applyUpdate(document, Y.encodeStateAsUpdate(peer, vector), 'remote'); peer.destroy();
    assert(undo.undo());
    const afterUndo = yDocToProsemirrorJSON(document, 'default');
    const anonymousRemoteFragmentAfterUndo = anonymousParagraph(root);
    const originalVector = Y.encodeStateVector(originalPeer);
    const late = find(originalPeer.getXmlFragment('default'), 'd'); assert(late);
    text(late).insert(text(late).length, '迟');
    Y.applyUpdate(document, Y.encodeStateAsUpdate(originalPeer, originalVector), 'remote');
    const afterLateWhileUndone = yDocToProsemirrorJSON(document, 'default');
    const lateOriginalSuffixVisibleWhileUndone = visibleText(root).includes('迟');
    assert(undo.redo());
    const afterRedo = yDocToProsemirrorJSON(document, 'default');
    return { name: 'both wrappers retain unselected children', classification: 'diagnostic-only-not-native-acceptance',
      reason: 'Production binding relocates the unselected suffix by copying; copying these history artifacts is not a native acceptance contract.',
      observations: { copiedUnselectedSuffix: copiedSuffix, anonymousRemoteFragmentAfterUndo,
        lateOriginalSuffixVisibleWhileUndone, lateOriginalSuffixVisibleAfterRedo: visibleText(root).includes('迟') },
      joined, afterUndo, afterLateWhileUndone, afterRedo };
  } finally { undo.destroy(); originalPeer.destroy(); document.destroy(); }
}

console.log(JSON.stringify({ schemaVersion: 1, source: 'production @tiptap/y-tiptap updateYFragment and defaultDeleteFilter',
  cases: [acceptedCase(), acceptedCase(true)], diagnostics: [diagnosticCase()] }));
