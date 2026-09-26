// Native automatic entity links, read back through the renderer's own Yjs
// decoder, y-tiptap mark serialization, auto-detect matcher, reference
// projection and a headless y-tiptap-bound production editor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import {
  prosemirrorJSONToYDoc, prosemirrorToYDoc, yUndoPluginKey, ySyncPluginKey, yXmlFragmentToProseMirrorRootNode,
} from '@tiptap/y-tiptap';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { getStaticChapterSchema } from '../src/renderer/components/editor/chapter-static-html';
import { buildEntityAutoDetectTargets, selectEntityLinkNames } from '../src/renderer/lib/entity-link-names';
import { BlockId } from '../src/renderer/lib/extensions/block-id';
import {
  detectEntityLinkSpans, EntityLink, flushPendingAutoDetect, type AutoDetectTarget,
} from '../src/renderer/lib/extensions/entity-link';
import { ParagraphIndent } from '../src/renderer/lib/extensions/paragraph-indent';
import { projectInlineMentionsFromDoc, projectInlineMentionsFromJson } from '../src/renderer/services/reference-projection.service';

const option = (name: string) => {
  const value = process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  assert(value, `${name} is required`);
  return path.resolve(value);
};
const input = option('--input');
const output = option('--output');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

interface ExportedDocument { updateBase64: string; text: string }
interface Fixture {
  elements: { id: string; name: string; aliases: string[] }[];
  chapters: { id: string; title: string; document: ExportedDocument }[];
  elementBody: { id: string; document: ExportedDocument };
  backlinks: {
    elementId: string;
    chapters: { chapterId: string; chapterTitle: string; spans: number; blocks: number; first: { location: number; length: number } }[];
    unavailable: unknown[];
  };
}
interface LinkSpan { block: number; from: number; to: number; text: string; targetKind: string; targetId: string }
type Delta = { insert: unknown; attributes?: Record<string, unknown> }[];
type Json = { type?: string; marks?: { type: string }[]; content?: Json[]; [key: string]: unknown };

// Production chapter editor extensions (hooks/useEntityEditor.ts, Yjs mode).
// Placeholder, AgentDiffDecoration, EntityMentionSuggestion and the slash menu
// only decorate or react to user input; they never write the document on load
// or during auto-detect, and need a DOM, so they are omitted.
const omittedExtensions = ['placeholder', 'agentDiffDecoration', 'entityMentionSuggestion', 'slashMenu'];
function productionExtensions(document: Y.Doc, autoDetectTargets: ReadonlyMap<string, AutoDetectTarget>) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      bulletList: false, orderedList: false, listItem: false, listKeymap: false, code: false, codeBlock: false,
      undoRedo: false, underline: false, link: false,
    }),
    Underline,
    Link.configure({ openOnClick: false, autolink: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right'], defaultAlignment: 'left' }),
    Collaboration.configure({ document, field: 'default' }),
    BlockId,
    ParagraphIndent,
    EntityLink.configure({ autoDetectTargets, autoDetectEnabled: true }),
  ];
}

interface PluginView { update?: (view: never, previous: EditorState) => void; destroy?: () => void }
/**
 * The EditorView surface the production plugins use, without a DOM: state,
 * dispatch through TipTap's composed dispatcher, and prosemirror-view's exact
 * plugin-view lifecycle (EditorView.updatePluginViews/destroyPluginViews).
 * The y-tiptap binding therefore renders, observes and writes as in the app.
 */
class HeadlessView {
  state: EditorState;
  isDestroyed = false;
  composing = false;
  dragging = null;
  editable = true;
  readonly dom = { className: '', querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  private readonly pluginViews: PluginView[] = [];
  constructor(state: EditorState, private readonly dispatchTransaction: (tr: Transaction) => void) {
    this.state = state;
    this.updatePluginViews();
  }
  dispatch(tr: Transaction) { this.dispatchTransaction.call(this, tr); }
  updateState(state: EditorState) {
    const previous = this.state;
    this.state = state;
    this.updatePluginViews(previous);
  }
  hasFocus() { return false; }
  setProps() {}
  destroy() {
    if (this.isDestroyed) return;
    this.destroyPluginViews();
    this.isDestroyed = true;
  }
  private destroyPluginViews() {
    for (let view = this.pluginViews.pop(); view; view = this.pluginViews.pop()) view.destroy?.();
  }
  private updatePluginViews(previous?: EditorState) {
    if (!previous || previous.plugins !== this.state.plugins) {
      this.destroyPluginViews();
      for (const plugin of this.state.plugins) {
        if (plugin.spec.view) this.pluginViews.push(plugin.spec.view(this as never) as PluginView);
      }
    } else {
      for (let index = 0; index < this.pluginViews.length; index += 1) {
        this.pluginViews[index]!.update?.(this as never, previous);
      }
    }
  }
}

// On mount, the only browser global a production plugin view touches is
// TipTap's paste-rule drag tracking (window drag listeners): an inert target.
// Nothing here dispatches DOM events, so those listeners never run.
const browserWindow = { addEventListener() {}, removeEventListener() {} };
const globals = globalThis as { window?: unknown };
assert.equal(globals.window, undefined, 'The check runs without a browser window');
globals.window = browserWindow;
const emptyDocument = { type: 'doc', content: [{ type: 'paragraph' }] };
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
/** TipTap Editor.createView/mount with the headless view in place of EditorView. */
async function mountProductionEditor(document: Y.Doc, targets: ReadonlyMap<string, AutoDetectTarget>) {
  // Yjs mode passes null content, which TipTap parses as HTML "" (an empty
  // paragraph) through the DOM; the same empty document is given as JSON.
  // y-tiptap replaces it with the Yjs fragment when its view is created.
  const editor = new Editor({ element: null, content: emptyDocument, extensions: productionExtensions(document, targets) });
  const internal = editor as unknown as { editorView: HeadlessView | null; dispatchTransaction(tr: Transaction): void };
  const view = new HeadlessView(editor.state,
    editor.extensionManager.dispatchTransaction(internal.dispatchTransaction.bind(editor)));
  internal.editorView = view;
  view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  editor.emit('mount', { editor });
  await settle();
  editor.emit('create', { editor });
  await settle();
  assert.equal(editor.view, view as unknown as typeof editor.view, 'Editor must use the stable headless view');
  const schema = getStaticChapterSchema();
  assert(schema);
  sameSchema(editor.schema, schema);
  return editor;
}

function decode(base64: string): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(base64, 'base64')));
  assert.equal(doc.store.pendingStructs, null);
  assert.equal(doc.store.pendingDs, null);
  return doc;
}
/** Every Y.XmlText delta in document order, keyed by its element path. */
function textDeltas(parent: Y.XmlFragment | Y.XmlElement, prefix = ''): { path: string; delta: Delta }[] {
  return parent.toArray().flatMap((child, index) => {
    // JSON form: decoded Yjs objects have a null prototype, locally written ones do not.
    if (child instanceof Y.XmlText) return [{ path: `${prefix}/${index}:text`, delta: JSON.parse(JSON.stringify(child.toDelta())) as Delta }];
    assert(child instanceof Y.XmlElement, 'Native prose holds only elements and text');
    return textDeltas(child, `${prefix}/${index}:${child.nodeName}`);
  });
}
function linkKeys(deltas: { delta: Delta }[]): string[] {
  return deltas.flatMap(({ delta }) => delta.flatMap(op => Object.keys(op.attributes ?? {})))
    .filter(key => key.startsWith('entityLink'));
}
/** entityLink spans per top-level block, UTF-16 block offsets, adjacent same-target nodes joined. */
function linkSpans(doc: PMNode): LinkSpan[] {
  const spans: LinkSpan[] = [];
  doc.forEach((block, _offset, index) => {
    assert(block.isTextblock, 'Fixture prose is top-level text blocks');
    block.forEach((node, from) => {
      assert(node.isText && node.text, 'Fixture prose holds only text inline content');
      for (const mark of node.marks.filter(item => item.type.name === 'entityLink')) {
        const attrs = mark.attrs as Record<string, unknown>;
        assert.deepEqual(Object.keys(attrs).sort(), ['targetBlockId', 'targetId', 'targetKind']);
        assert.equal(attrs.targetBlockId, null);
        assert(attrs.targetKind === 'element' || attrs.targetKind === 'node');
        assert(typeof attrs.targetId === 'string' && attrs.targetId);
        const previous = spans[spans.length - 1];
        if (previous && previous.block === index && previous.to === from
          && previous.targetKind === attrs.targetKind && previous.targetId === attrs.targetId) {
          previous.to += node.text.length;
          previous.text += node.text;
        } else {
          spans.push({ block: index, from, to: from + node.text.length, text: node.text,
            targetKind: attrs.targetKind, targetId: attrs.targetId });
        }
      }
    });
  });
  return spans.sort((a, b) => a.block - b.block || a.from - b.from || a.targetId.localeCompare(b.targetId));
}
/** Node equality across the editor's own schema instance and the chapter schema. */
function same(schema: Schema, editorDoc: PMNode, expected: PMNode): boolean {
  return schema.nodeFromJSON(editorDoc.toJSON()).eq(expected);
}
/** The mounted editor's schema is the production chapter schema: types, attrs and defaults. */
function sameSchema(actual: Schema, expected: Schema) {
  const describe = (schema: Schema) => ({
    nodes: Object.values(schema.nodes).map(type => [type.name, type.spec.content ?? null, type.spec.group ?? null,
      Object.entries(type.spec.attrs ?? {}).map(([name, spec]) => [name, spec.default ?? null])]),
    marks: Object.values(schema.marks).map(type => [type.name, type.spec.excludes ?? null, type.spec.inclusive ?? null,
      Object.entries(type.spec.attrs ?? {}).map(([name, spec]) => [name, spec.default ?? null])]),
  });
  assert.deepEqual(describe(actual), describe(expected), 'Editor schema must equal the production chapter schema');
}
function strip(node: Json): Json {
  const copy: Json = { ...node };
  if (Array.isArray(node.marks)) {
    const marks = node.marks.filter(mark => mark.type !== 'entityLink');
    if (marks.length) copy.marks = marks;
    else delete copy.marks;
  }
  if (Array.isArray(node.content)) copy.content = node.content.map(strip);
  return copy;
}
function projectionText(doc: PMNode): string {
  const blocks: string[] = [];
  doc.forEach(block => blocks.push(block.textContent));
  return blocks.join('\n');
}

/** The exported renderer matcher per PM text node of unlinked prose (block-relative UTF-16). */
function detectAll(plain: PMNode, autoDetectTargets: ReadonlyMap<string, AutoDetectTarget>): LinkSpan[] {
  const spans: LinkSpan[] = [];
  plain.forEach((block, _offset, index) => block.forEach((node, from) => {
    const text = node.text ?? '';
    for (const span of detectEntityLinkSpans(text, { autoDetectTargets, autoDetectEnabled: true })) {
      spans.push({ block: index, from: from + span.from, to: from + span.to, text: text.slice(span.from, span.to),
        targetKind: span.attrs.targetKind, targetId: span.attrs.targetId });
    }
  }));
  return spans;
}

type Names = ReturnType<typeof selectEntityLinkNames>;
async function verifyDocument(
  name: string, schema: Schema, source: { kind: 'node' | 'element'; id: string }, exported: ExportedDocument,
  names: Names, label: (kind: string, id: string) => string,
) {
  // The body's own element or chapter is excluded before name collisions resolve.
  const targets = buildEntityAutoDetectTargets(names, source.kind, source.id);
  const native = decode(exported.updateBase64);
  const bytes = Y.encodeStateAsUpdate(native);
  const documents: Y.Doc[] = [native];
  const editors: Editor[] = [];
  try {
    // 1. Production decoder: y-prosemirror JSON (reference index, reducer
    // cache) and the editor's y-tiptap root node agree under the chapter schema.
    const json = yDocToProsemirrorJSON(native, 'default') as Json;
    const decoded = schema.nodeFromJSON(json);
    decoded.check();
    assert(yXmlFragmentToProseMirrorRootNode(native.getXmlFragment('default'), schema).eq(decoded),
      'y-tiptap editor decode must equal the production JSON decode');
    assert.equal(projectionText(decoded), exported.text, 'Decoded prose must equal the native projection text');
    const spans = linkSpans(decoded);
    assert(spans.length > 0);
    for (const span of spans) {
      assert.deepEqual(targets.get(span.text), { kind: span.targetKind, id: span.targetId },
        `Linked text "${span.text}" must name its target in the renderer map`);
    }
    // Each Yjs attribute key and value is what y-tiptap marksToAttributes writes
    // for the decoded marks (overlapping-mark hash over mark.toJSON()).
    const nativeDeltas = textDeltas(native.getXmlFragment('default'));
    const serialized = prosemirrorToYDoc(decoded, 'default');
    documents.push(serialized);
    assert.deepEqual(nativeDeltas, textDeltas(serialized.getXmlFragment('default')),
      'y-tiptap must serialize the decoded marks to the native Yjs text attributes');
    const keys = linkKeys(nativeDeltas);
    assert(keys.every(key => /^entityLink--[a-zA-Z0-9+/=]{8}$/u.test(key)), 'Native links use overlapping-mark keys');

    // 2. Renderer auto-detect over the unlinked prose, in the production editor
    // bound to a y-tiptap Y.Doc, links exactly the native spans and Yjs keys.
    const stripped = strip(json);
    assert(!JSON.stringify(stripped).includes('"entityLink"'));
    const plain = schema.nodeFromJSON(stripped);
    assert.deepEqual(detectAll(plain, targets), spans, 'Exported renderer matcher must find exactly the native spans');
    // Whether the exclusion is load-bearing here: self-links the matcher would add without it.
    const self = (span: LinkSpan) => span.targetKind === source.kind && span.targetId === source.id;
    assert(!spans.some(self), 'Native never links a body to itself');
    const selfSpansWithoutExclusion = detectAll(plain, buildEntityAutoDetectTargets(names, source.kind, '')).filter(self).length;
    const unlinked = prosemirrorJSONToYDoc(schema, stripped, 'default');
    documents.push(unlinked);
    const unlinkedUpdates: unknown[] = [];
    unlinked.on('update', (_update: Uint8Array, origin: unknown) => unlinkedUpdates.push(origin));
    const detector = await mountProductionEditor(unlinked, targets);
    editors.push(detector);
    assert(same(schema, detector.state.doc, plain), 'Unlinked prose loads unchanged');
    assert.equal(unlinkedUpdates.length, 0, 'Loading unlinked prose writes nothing');
    const transactions: Transaction[] = [];
    detector.on('transaction', ({ transaction }) => transactions.push(transaction));
    flushPendingAutoDetect(detector);
    await settle();
    assert.equal(transactions.length, 1, 'Auto-detect dispatches one transaction');
    assert.equal(transactions[0]!.getMeta('entityLink'), true);
    assert.equal(transactions[0]!.getMeta('addToHistory'), false);
    assert(same(schema, detector.state.doc, decoded), 'Renderer auto-detect must reproduce the native marks exactly');
    assert.deepEqual(unlinkedUpdates, [ySyncPluginKey], 'Auto-detect writes one y-tiptap update');
    assert.equal(yUndoPluginKey.getState(detector.state)!.undoManager.undoStack.length, 0, 'Auto-detect is not an undo step');
    assert.deepEqual(textDeltas(unlinked.getXmlFragment('default')), nativeDeltas,
      'Renderer auto-detect must write the native Yjs text attributes');
    flushPendingAutoDetect(detector);
    await settle();
    assert.equal(transactions.length, 1, 'Auto-detect is idempotent');

    // 4. Convergence: the production editor bound to the native state (and
    // flushing auto-detect as Copilot context assembly does) writes nothing.
    const bound = new Y.Doc();
    documents.push(bound);
    Y.applyUpdate(bound, bytes);
    const boundUpdates: unknown[] = [];
    bound.on('update', (_update: Uint8Array, origin: unknown) => boundUpdates.push(origin));
    const editor = await mountProductionEditor(bound, targets);
    editors.push(editor);
    assert(same(schema, editor.state.doc, decoded), 'Bound editor renders the native marks');
    flushPendingAutoDetect(editor);
    await settle();
    assert(same(schema, editor.state.doc, decoded), 'Flushing auto-detect must leave native links unchanged');
    assert.equal(boundUpdates.length, 0, 'The renderer editor must not rewrite native links');
    assert.deepEqual(Y.encodeStateVector(bound), Y.encodeStateVector(native));

    return {
      name, sourceKind: source.kind, stateSha256: sha(bytes), textSha256: sha(exported.text),
      blocks: decoded.childCount, linkKeys: new Set(keys).size,
      links: spans.map(span => [span.block, span.from, span.to, span.text, label(span.targetKind, span.targetId)]),
      decode: 'passed', yjsAttributes: 'passed', pureDetector: 'passed', selfSpansWithoutExclusion,
      autoDetect: { status: 'passed', transactions: transactions.length, yjsUpdates: unlinkedUpdates.length, undoSteps: 0 },
      convergence: { status: 'passed', yjsUpdates: boundUpdates.length },
    };
  } finally {
    for (const editor of editors) editor.destroy();
    for (const doc of documents) doc.destroy();
  }
}

/** Per-chapter mentions of one element through the production reference projection. */
function backlinks(schema: Schema, fixture: Fixture) {
  const rows = [];
  for (const chapter of fixture.chapters) {
    const doc = decode(chapter.document.updateBase64);
    try {
      // Production reference index path: yDocToProsemirrorJSON then the JSON projection.
      const json = yDocToProsemirrorJSON(doc, 'default');
      const drafts = projectInlineMentionsFromJson(json);
      const pm = schema.nodeFromJSON(json);
      assert.deepEqual(projectInlineMentionsFromDoc(pm), drafts, 'Doc and JSON projections must agree');
      const starts = new Map<string, number>();
      let offset = 0;
      pm.forEach(block => {
        starts.set(String(block.attrs.id), offset);
        offset += block.textContent.length + 1;
      });
      const mine = drafts.filter(draft => draft.toKind === 'element' && draft.toId === fixture.backlinks.elementId);
      if (mine.length === 0) continue;
      const spans = mine.map(draft => JSON.parse(draft.fromSpansJson) as { from: number; to: number; text: string }[]);
      const first = spans[0]![0]!;
      const start = starts.get(mine[0]!.fromBlockId);
      assert(start !== undefined, 'Mentions resolve to a top-level block');
      const location = start + first.from;
      assert.equal(chapter.document.text.slice(location, location + first.to - first.from), first.text);
      rows.push({ chapterId: chapter.id, chapterTitle: chapter.title, spans: spans.flat().length, blocks: mine.length,
        first: { location, length: first.to - first.from } });
    } finally { doc.destroy(); }
  }
  assert.deepEqual(fixture.backlinks.unavailable, []);
  assert.deepEqual(fixture.backlinks.chapters, rows, 'Native backlinks must equal the renderer reference projection');
  return rows;
}

async function main() {
  const fixture = JSON.parse(readFileSync(input, 'utf8')) as Fixture;
  const schema = getStaticChapterSchema();
  assert(schema, 'The production chapter schema must build');
  assert.equal(fixture.chapters.length, 2);
  const labels = new Map<string, string>([
    ...fixture.elements.map(element => [`element:${element.id}`, `element:${element.name}`] as const),
    ...fixture.chapters.map(chapter => [`node:${chapter.id}`, `node:${chapter.title}`] as const),
  ]);
  const label = (kind: string, id: string) => {
    const value = labels.get(`${kind}:${id}`);
    assert(value, `Unknown link target ${kind}:${id}`);
    return value;
  };
  // The renderer's name projection over the live library (store order) and chapters (book order).
  const names = selectEntityLinkNames({
    workspaceProjectId: 'native-link-acceptance', workspaceProjectionGeneration: 'native-link-acceptance',
    bookElements: fixture.elements, bookNodes: fixture.chapters.map(({ id, title }) => ({ id, title })),
  } as unknown as Parameters<typeof selectEntityLinkNames>[0]);
  const documents = [];
  for (const [index, chapter] of fixture.chapters.entries()) {
    documents.push(await verifyDocument(`chapter-${index}`, schema, { kind: 'node', id: chapter.id }, chapter.document,
      names, label));
  }
  const body = fixture.elementBody;
  assert.equal(body.id, fixture.backlinks.elementId);
  documents.push(await verifyDocument('element-body', schema, { kind: 'element', id: body.id }, body.document,
    names, label));
  const rows = backlinks(schema, fixture);
  const extensionNames = (() => {
    const doc = new Y.Doc();
    const editor = new Editor({ element: null, content: emptyDocument, extensions: productionExtensions(doc, new Map()) });
    try { return editor.extensionManager.extensions.map(extension => extension.name); } finally {
      editor.destroy();
      doc.destroy();
    }
  })();
  writeFileSync(output, `${JSON.stringify({
    schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)),
    schema: { source: 'getStaticChapterSchema', nodes: Object.keys(schema.nodes).sort(), marks: Object.keys(schema.marks).sort() },
    editor: { extensions: extensionNames, omittedExtensions },
    documents,
    backlinks: { element: label('element', fixture.backlinks.elementId), status: 'passed',
      chapters: rows.map(row => ({ chapter: label('node', row.chapterId), spans: row.spans, blocks: row.blocks, first: row.first })) },
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', documents: documents.length, links: documents.reduce((sum, item) => sum + item.links.length, 0), backlinks: rows.length }));
}
mkdirSync(path.dirname(output), { recursive: true });
main().catch(error => { console.error(error); process.exitCode = 1; });
