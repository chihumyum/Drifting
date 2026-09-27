// Native chapter and drift body projections (node_content content/outline and
// the canonical word count with its basis) against the renderer oracle:
// deriveCanonicalNodeProseProjection over the durable Yjs state that the
// production persistence coordinator reads from each exported native database,
// the production reducer's own body-cache projection, and
// canReuseCanonicalProjection over the native rows. A synthetic y-prosemirror
// corpus (seed and live-editor schemas, later edits, concurrent peers) is
// replayed into fresh native DocumentSessions by the acceptance generator.
// Native need not be byte-compatible with the renderer: every corpus
// difference (object key order, mark order, anything else) is recorded with
// exact values for the generator to pin.
//
//   --emit-corpus=<file>                      write the corpus updates
//   --input=<wire> --corpus=<file> --native-corpus=<file> --output=<file>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { getSchema } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { prosemirrorToYXmlFragment, updateYFragment, yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { hasCanonicalWordCount } from '../src/renderer/domain/book-node';
import { createEntitySeedUpdate } from '../src/renderer/hooks/useEntityYjsDoc';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  createYjsProsePersistenceCoordinator, type YjsProsePersistenceBase,
} from '../src/renderer/lib/agent/runtime/yjs-prose-persistence-coordinator';
import { BlockId } from '../src/renderer/lib/extensions/block-id';
import { EntityLink } from '../src/renderer/lib/extensions/entity-link';
import { ParagraphIndent } from '../src/renderer/lib/extensions/paragraph-indent';
import { proseDocId } from '../src/renderer/lib/yjs-doc-id';
import {
  canReuseCanonicalProjection, deriveCanonicalNodeProseProjection, type CanonicalNodeProseProjection,
} from '../src/renderer/services/node-prose-metrics.service';
import { createBookContentRepository } from '../src/renderer/sqlite-repo/content-repo';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';

const option = (name: string) => process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Synthetic corpus. `seed` is createYjsProseSeedState's schema; `editor` holds
// the schema-bearing extensions of useEntityEditor (textAlign 'left' and indent
// 0 are stored on every block it writes).
const seedSchema = getSchema([StarterKit.configure({ underline: false, link: false }), Underline, Link, TextAlign, BlockId,
  EntityLink] as never);
const editorSchema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, bulletList: false, orderedList: false, listItem: false,
    listKeymap: false, code: false, codeBlock: false, undoRedo: false, underline: false, link: false }),
  Underline, Link.configure({ openOnClick: false, autolink: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right'], defaultAlignment: 'left' }),
  BlockId, ParagraphIndent, EntityLink,
] as never);
type Pm = { [key: string]: Json };
const text = (value: string, ...marks: Pm[]): Pm => (marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const mark = (type: string, attrs?: Pm): Pm => (attrs ? { type, attrs } : { type });
const block = (type: string, attrs: Pm | null, ...content: Pm[]): Pm =>
  ({ type, ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) });
const para = (id: string | null, ...content: Pm[]) => block('paragraph', id ? { id } : null, ...content);
const heading = (level: number, id: string | null, ...content: Pm[]) => block('heading', { level, ...(id ? { id } : {}) }, ...content);
const doc = (...content: Pm[]): Pm => ({ type: 'doc', content });
const bold = mark('bold');
const italic = mark('italic');
const strike = mark('strike');
const underline = mark('underline');
const entity = (targetId: string, targetKind = 'element', targetBlockId: string | null = null) =>
  mark('entityLink', { targetKind, targetId, targetBlockId });

/** y-prosemirror's own conversion (prosemirrorJSONToYDoc) with a fixed client, then editor syncs. */
function fromPm(schema: Schema, json: Pm, client: number, edits: Pm[] = []): Y.Doc {
  const ydoc = new Y.Doc({ gc: false });
  ydoc.clientID = client;
  const fragment = ydoc.getXmlFragment('default');
  ydoc.transact(() => { prosemirrorToYXmlFragment(schema.nodeFromJSON(json), fragment); });
  for (const edit of edits) {
    // ySyncPlugin's ProseMirror-to-Yjs path for a later editor transaction.
    ydoc.transact(() => { updateYFragment(ydoc, fragment, schema.nodeFromJSON(edit), { mapping: new Map(), isOMark: new Map() }); });
  }
  return ydoc;
}
function peer(base: Y.Doc, client: number, change: (fragment: Y.XmlFragment) => void): Y.Doc {
  const ydoc = new Y.Doc({ gc: false });
  ydoc.clientID = client;
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(base));
  ydoc.transact(() => change(ydoc.getXmlFragment('default')));
  return ydoc;
}
function merged(...docs: Y.Doc[]): Y.Doc {
  const ydoc = new Y.Doc({ gc: false });
  for (const item of docs) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(item));
  return ydoc;
}
const textOf = (fragment: Y.XmlFragment, index = 0) => (fragment.get(index) as Y.XmlElement).get(0) as Y.XmlText;
function raw(client: number, build: (fragment: Y.XmlFragment) => void): Y.Doc {
  const ydoc = new Y.Doc({ gc: false });
  ydoc.clientID = client;
  ydoc.transact(() => build(ydoc.getXmlFragment('default')));
  return ydoc;
}
function element(name: string, attrs: [string, Json][], children: (Y.XmlElement | Y.XmlText)[]): Y.XmlElement {
  const item = new Y.XmlElement(name);
  for (const [key, value] of attrs) item.setAttribute(key, value as never);
  item.insert(0, children);
  return item;
}
function xmlText(runs: [string, Record<string, Json>?][]): Y.XmlText {
  const item = new Y.XmlText();
  let at = 0;
  for (const [value, attributes] of runs) {
    item.insert(at, value, attributes);
    at += value.length;
  }
  return item;
}
const exampleLink = (suffix: string, attrs: Pm = {}) => mark('link', { href: `https://example.invalid/${suffix}`, ...attrs });

const corpus: [string, () => Y.Doc][] = [
  ['seed-marks-open-together', () => fromPm(seedSchema, doc(para('p1', text('Lead '),
    text('all six', exampleLink('a', { target: '_blank', rel: 'noopener', class: 'x', title: 'T' }), bold, italic, strike, underline,
      entity('el-1')),
    text(' tail'), text('code', mark('code')))), 11)],
  ['seed-italic-then-bold-italic', () => fromPm(seedSchema, doc(para('p1', text('a', italic), text('b', bold, italic))), 12)],
  ['seed-marks-close-and-reopen', () => fromPm(seedSchema, doc(para('p1', text('A', italic, underline), text('B', bold, underline),
    text('C', bold, italic, underline), text('D', italic))), 13)],
  ['seed-marks-staggered', () => fromPm(seedSchema, doc(para('p1', text('ab', bold), text('cd', bold, italic),
    text('ef', bold, italic, underline), text('gh', italic, underline), text('ij', italic, strike, underline), text('kl', strike),
    text(' end'))), 14)],
  ['seed-entity-links-overlap', () => fromPm(seedSchema, doc(para('p1', text('钟', entity('el-a')),
    text('楼', bold, entity('el-a'), entity('el-b', 'storyline')), text('夜', bold, entity('el-b', 'storyline')), text(' next '),
    text('x', entity('el-c', 'chapter', 'blk-9')), text('y', entity('el-c', 'chapter', 'blk-9'), entity('el-d')))), 15)],
  ['seed-adjacent-links', () => fromPm(seedSchema, doc(para('p1', text('one', exampleLink('1'), bold), text('two', exampleLink('2'), bold),
    text('three', bold))), 16)],
  ['seed-headings-and-outline', () => fromPm(seedSchema, doc(heading(1, 'h1', text('第一章 '), text('Start', bold)), para('a', text('para')),
    heading(2, null, text('无编号 heading')), para(null), heading(3, 'h3', text('  spaced  ')), heading(4, 'h4', text('level four')),
    para('b', text('x')), heading(2, 'h5', text('   ')),
    block('blockquote', { id: 'q1' }, heading(2, null, text('quoted head')), para(null, text('quoted'))), para('c', text('after'))), 17)],
  ['seed-blockquote-hardbreak-empty', () => fromPm(seedSchema, doc(para('p1'),
    block('blockquote', { id: 'q' }, para(null, text('line', bold), { type: 'hardBreak' }, text('next', bold)), para(null)),
    para('p2', { type: 'hardBreak' }), para('p3', text('a'), { type: 'hardBreak' }, { type: 'hardBreak' }, text('b')),
    block('horizontalRule', { id: 'hr' }), para('p4')), 18)],
  ['seed-lists-and-code', () => fromPm(seedSchema, doc(
    block('orderedList', { id: 'ol', start: 3 }, block('listItem', null, para(null, text('three'))), block('listItem', null, para(null, text('four')))),
    block('bulletList', { id: 'ul' }, block('listItem', null, para(null, text('dot')))),
    block('codeBlock', { id: 'cb', language: 'ts' }, text('const x = "\\u0001";\n\treturn x;'))), 19)],
  ['seed-word-count-unicode', () => fromPm(seedSchema, doc(
    para('p1', text('他说：“你好”，world！ Ｆｕｌｌ ａｂｃ 123 don\'t co-op 🙂🙂 x_y ㄅㄆ かな 한국어 \u3400 𠀀')),
    para('p2', text('nb\u00a0sp\u3000cjk\u2028ls tab\tend \ufeffbom \u0085nel "quote" back\\slash \u0001\u001f\u007f')),
    para('p3', text('ab'), text('cd', bold), text('ef'))), 20)],
  ['editor-block-attributes', () => fromPm(editorSchema, doc(
    block('paragraph', { id: 'p1', textAlign: 'center', indent: 2 }, text('centered')),
    block('heading', { id: 'h1', level: 2, textAlign: 'right', indent: 1 }, text('head')),
    block('blockquote', { id: 'q1', indent: 1 }, block('paragraph', { id: 'p2' }, text('q'))),
    block('paragraph', { id: 'p3' })), 21)],
  ['editor-late-id-and-level', () => fromPm(editorSchema, doc(block('paragraph', null, text('no id yet')), heading(1, 'h1', text('Head'))), 22,
    [doc(block('paragraph', { id: 'p-late' }, text('no id yet')), block('heading', { level: 3, id: 'h1', textAlign: 'center' }, text('Head')))])],
  ['editor-mark-applied-later', () => fromPm(editorSchema, doc(para('p1', text('Hello '), text('world', bold), text(' again'))), 23, [
    doc(para('p1', text('Hello '), text('world', bold, italic), text(' again'))),
    doc(para('p1', text('Hello '), text('wo', bold, italic, underline), text('rld', bold, italic), text(' again'))),
    doc(para('p1', text('Hello '), text('wo', exampleLink('w'), bold, italic, underline), text('rld', bold, italic), text(' again'))),
  ])],
  ['editor-mark-removed-and-reapplied', () => fromPm(editorSchema, doc(para('p1', text('abc', bold, italic), text('def'))), 24, [
    doc(para('p1', text('abc', italic), text('def'))), doc(para('p1', text('abc', bold, italic), text('def'))),
  ])],
  ['editor-entity-link-added-later', () => fromPm(editorSchema, doc(para('p1', text('钟楼', bold), text(' and '), text('海港'))), 25, [
    doc(para('p1', text('钟楼', bold, entity('el-1')), text(' and '), text('海港', entity('el-2')))),
  ])],
  ['yjs-format-later-same-start', () => {
    const ydoc = fromPm(seedSchema, doc(para('p1', text('abcdef'))), 31);
    ydoc.transact(() => textOf(ydoc.getXmlFragment('default')).format(0, 4, { bold: {} }));
    ydoc.transact(() => textOf(ydoc.getXmlFragment('default')).format(0, 2, { italic: {} }));
    return ydoc;
  }],
  ['concurrent-format-same-start', () => {
    const base = fromPm(seedSchema, doc(para('p1', text('abcdef'))), 41);
    return merged(peer(base, 42, fragment => textOf(fragment).format(0, 3, { bold: {} })),
      peer(base, 43, fragment => textOf(fragment).format(0, 5, { italic: {} })));
  }],
  ['concurrent-format-same-key', () => {
    const base = fromPm(seedSchema, doc(para('p1', text('abcdef'))), 44);
    return merged(peer(base, 45, fragment => textOf(fragment).format(0, 3, { bold: {}, underline: {} })),
      peer(base, 46, fragment => textOf(fragment).format(0, 5, { bold: {} })));
  }],
  ['concurrent-attributes-two-clients', () => {
    const base = fromPm(editorSchema, doc(block('paragraph', { id: 'p1' }, text('x'))), 1000);
    return merged(peer(base, 7, fragment => (fragment.get(0) as Y.XmlElement).setAttribute('indent', 3 as never)),
      peer(base, 5000, fragment => (fragment.get(0) as Y.XmlElement).setAttribute('textAlign', 'right')));
  }],
  ['raw-top-level-text-and-empty-text', () => raw(51, fragment => fragment.insert(0, [
    element('paragraph', [['id', 'p-empty']], [new Y.XmlText()]), xmlText([['top', { bold: true }]]),
  ]))],
  ['raw-fractional-numbers', () => raw(52, fragment => fragment.insert(0, [
    element('paragraph', [['id', 'p1'], ['ratio', 0.5], ['tiny', 1e-7]], [xmlText([['n', { link: { href: 'h', weight: -2.5 } }]])]),
  ]))],
  ['raw-large-number', () => raw(54, fragment => fragment.insert(0, [element('paragraph', [['id', 'p1'], ['big', 1e21]], [])]))],
  ['raw-integer-like-keys', () => raw(55, fragment => fragment.insert(0, [
    element('paragraph', [['id', 'p1'], ['zeta', 'z'], ['10', 'ten'], ['2', 'two']], []),
  ]))],
  ['raw-non-ascii-format-key', () => raw(53, fragment => fragment.insert(0, [
    element('paragraph', [], [xmlText([['k', { 'é123456789': {} }]])]),
  ]))],
];

function emitCorpus(file: string) {
  const cases = corpus.map(([name, build]) => {
    const ydoc = build();
    try {
      const update = Y.encodeStateAsUpdate(ydoc);
      return { name, updateHex: Buffer.from(update).toString('hex'), updateSha256: sha(update) };
    } finally { ydoc.destroy(); }
  });
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'emitted', cases: cases.length }));
}

// ---------------------------------------------------------------------------
// Oracles.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
interface OutlineEntry { id: string; level: number; text: string; position: number; paragraphsAfter: number }
/** Headings without a block ID get `outline_<uuidv7>_<position>` in the renderer and `outline_native_<position>` natively. */
function positionalOutline(outlineJson: string, contentJson: string): { outlineJson: string; drawn: number } {
  const headingIds: (string | null)[] = [];
  const visit = (node: Json) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const attrs = node.attrs && typeof node.attrs === 'object' && !Array.isArray(node.attrs) ? node.attrs : {};
    if (node.type === 'heading' && [1, 2, 3].includes(attrs.level as number)) {
      const content = collectText(node).trim();
      if (content) headingIds.push(typeof attrs.id === 'string' ? attrs.id : null);
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(JSON.parse(contentJson) as Json);
  const entries = JSON.parse(outlineJson) as OutlineEntry[];
  assert.equal(entries.length, headingIds.length);
  let drawn = 0;
  const pattern = new RegExp(`^outline_${UUID}_(\\d+)$`, 'u');
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.position, index);
    if (headingIds[index] !== null) {
      assert.equal(entry.id, headingIds[index]);
      continue;
    }
    const match = pattern.exec(entry.id);
    assert(match && Number(match[1]) === index, `Unexpected renderer outline id ${entry.id}`);
    drawn += 1;
  }
  return { outlineJson: outlineJson.replace(new RegExp(`"outline_${UUID}_(\\d+)"`, 'gu'), '"outline_native_$1"'), drawn };
}
function collectText(node: Json): string {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  return Array.isArray(node.content) ? node.content.map(collectText).join('') : '';
}
/** The persistence coordinator's closed-document capture (loadPersistedDoc) of one update. */
function closedBase(update: Uint8Array, revision: number): YjsProsePersistenceBase {
  const loaded = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(loaded, update, 'load');
    const stateUpdate = Y.encodeStateAsUpdate(loaded);
    return { docId: 'node-content:corpus', sourceKind: 'closed', revision, stateVector: Y.encodeStateVector(loaded),
      stateHash: sha(stateUpdate), stateUpdate };
  } finally { loaded.destroy(); }
}

interface Difference { kind: 'keyOrder' | 'markOrder' | 'value' | 'invalidJson'; path: string; native: Json; renderer: Json }
/** JSON with object members in source order (JSON.parse moves integer-like keys first). */
type Ordered = null | boolean | number | string | Ordered[] | Map<string, Ordered>;
function parseOrdered(source: string): Ordered {
  JSON.parse(source);
  let at = 0;
  const space = () => { while (/\s/u.test(source[at] ?? '')) at += 1; };
  const token = (pattern: RegExp) => {
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    assert(match);
    at += match[0].length;
    return JSON.parse(match[0]) as Ordered;
  };
  const string = () => token(/"(?:[^"\\]|\\.)*"/uy) as string;
  const value = (): Ordered => {
    space();
    const head = source[at];
    if (head === '{') {
      at += 1;
      const members = new Map<string, Ordered>();
      space();
      if (source[at] === '}') { at += 1; return members; }
      for (;;) {
        space();
        const key = string();
        space();
        assert.equal(source[at], ':');
        at += 1;
        members.set(key, value());
        space();
        if (source[at++] === '}') return members;
      }
    }
    if (head === '[') {
      at += 1;
      const items: Ordered[] = [];
      space();
      if (source[at] === ']') { at += 1; return items; }
      for (;;) {
        items.push(value());
        space();
        if (source[at++] === ']') return items;
      }
    }
    if (head === '"') return string();
    return token(/true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/uy);
  };
  return value();
}
const plain = (value: Ordered): Json => (value instanceof Map ? Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]))
  : Array.isArray(value) ? value.map(plain) : value);
const canonical = (value: Ordered): string => {
  if (value instanceof Map) {
    return `{${[...value.keys()].sort().map(key => `${JSON.stringify(key)}:${canonical(value.get(key)!)}`).join(',')}}`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return JSON.stringify(value);
};
const markLabel = (value: Ordered) => {
  if (!(value instanceof Map)) return JSON.stringify(plain(value));
  const attrs = value.get('attrs');
  const detail = attrs instanceof Map ? attrs.get('targetId') ?? attrs.get('href') : null;
  return typeof detail === 'string' ? `${String(value.get('type'))}:${detail}` : String(value.get('type'));
};
/** Every difference between two projections: object key order, mark order, or anything else. */
function differences(native: string, renderer: string): Difference[] {
  if (native === renderer) return [];
  let parsed: Ordered;
  try { parsed = parseOrdered(native); } catch {
    return [{ kind: 'invalidJson', path: '$', native, renderer }];
  }
  const found: Difference[] = [];
  const walk = (a: Ordered, b: Ordered, at: string) => {
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      const order = b.map(canonical);
      if (at.endsWith('.marks') && !isDeepStrictEqual(a.map(canonical), order)
        && isDeepStrictEqual(a.map(canonical).sort(), [...order].sort())) {
        found.push({ kind: 'markOrder', path: at, native: a.map(markLabel), renderer: b.map(markLabel) });
        a = [...a].sort((x, y) => order.indexOf(canonical(x)) - order.indexOf(canonical(y)));
      }
      a.forEach((item, index) => walk(item, b[index]!, `${at}[${index}]`));
      return;
    }
    if (a instanceof Map && b instanceof Map && isDeepStrictEqual([...a.keys()].sort(), [...b.keys()].sort())) {
      if (!isDeepStrictEqual([...a.keys()], [...b.keys()])) {
        found.push({ kind: 'keyOrder', path: at, native: [...a.keys()], renderer: [...b.keys()] });
      }
      for (const key of b.keys()) walk(a.get(key)!, b.get(key)!, `${at}.${key}`);
      return;
    }
    if (canonical(a) !== canonical(b)) found.push({ kind: 'value', path: at, native: plain(a), renderer: plain(b) });
  };
  walk(parsed, parseOrdered(renderer), '$');
  assert(found.length > 0, 'Differing bytes must have a located difference');
  return found;
}

interface NativeProjection { contentJson: string; outlineJson: string; wordCount: number; basisHash: string }
interface Comparison {
  content: 'equal' | 'keyOrder' | 'differs';
  outline: 'equal' | 'differs';
  wordCount: 'equal' | 'differs';
  basisHash: 'equal' | 'differs';
  drawnOutlineIds: number;
  differences: Difference[];
}
function compare(native: NativeProjection, renderer: CanonicalNodeProseProjection): Comparison {
  const found = differences(native.contentJson, renderer.contentJson);
  const outline = positionalOutline(renderer.outlineJson, renderer.contentJson);
  if (native.outlineJson !== outline.outlineJson) {
    found.push({ kind: 'value', path: 'outline', native: native.outlineJson, renderer: outline.outlineJson });
  }
  return {
    content: !found.some(item => item.path !== 'outline') ? 'equal'
      : found.every(item => item.kind === 'keyOrder' || item.path === 'outline') ? 'keyOrder' : 'differs',
    outline: native.outlineJson === outline.outlineJson ? 'equal' : 'differs',
    wordCount: native.wordCount === renderer.wordCount ? 'equal' : 'differs',
    basisHash: native.basisHash === renderer.wordCountBasisHash ? 'equal' : 'differs',
    drawnOutlineIds: outline.drawn,
    differences: found,
  };
}

async function verifyCorpus(corpusFile: string, nativeFile: string) {
  const emitted = JSON.parse(readFileSync(corpusFile, 'utf8')) as { schemaVersion: number; cases: { name: string; updateHex: string; updateSha256: string }[] };
  const replies = JSON.parse(readFileSync(nativeFile, 'utf8')) as { schemaVersion: number; cases: { name: string; projection?: NativeProjection; error?: string; panic?: string }[] };
  assert.equal(emitted.schemaVersion, 1);
  assert.equal(replies.schemaVersion, 1);
  assert.deepEqual(emitted.cases.map(item => item.name), corpus.map(([name]) => name));
  assert.deepEqual(replies.cases.map(item => item.name), corpus.map(([name]) => name));
  const cases = [];
  for (const [index, [name, build]] of corpus.entries()) {
    // Deterministic: the emitted update is exactly what the corpus builds now.
    const ydoc = build();
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    assert.equal(emitted.cases[index]!.updateHex, Buffer.from(update).toString('hex'), `${name} corpus is not deterministic`);
    assert.equal(emitted.cases[index]!.updateSha256, sha(update));
    const renderer = await deriveCanonicalNodeProseProjection(name, closedBase(update, 1));
    const reply = replies.cases[index]!;
    const failure = reply.panic !== undefined ? { panic: reply.panic } : reply.error !== undefined ? { error: reply.error } : null;
    if (failure) {
      assert.equal(reply.projection, undefined);
      cases.push({ name, updateSha256: sha(update), native: failure, renderer: { contentJson: renderer.contentJson,
        wordCount: renderer.wordCount, basisHash: renderer.wordCountBasisHash } });
      continue;
    }
    assert(reply.projection, `${name}: native returned no projection`);
    const comparison = compare(reply.projection, renderer);
    cases.push({ name, updateSha256: sha(update), rendererWordCount: renderer.wordCount, ...comparison,
      ...(comparison.content === 'equal' ? {} : { nativeContentSha256: sha(reply.projection.contentJson),
        rendererContentSha256: sha(renderer.contentJson) }) });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Native workspace exports.
interface Export { name: string; database: string; projectId: string; nodes: string[] }
const journalTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt', 'sync_entity_lifecycle',
  'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict', 'sync_generation_writer_state',
];
const yjsTables = ['yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance'];
const derivedColumns: Record<string, string[]> = {
  book_node: ['word_count', 'word_count_basis_kind', 'word_count_basis_hash', 'word_count_basis_revision', 'word_count_basis_server_seq'],
  node_content: ['content_json', 'outline_json'],
};
function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { hex: Buffer.from(value).toString('hex') };
  if (typeof value === 'bigint') return Number(value);
  return value;
}
function rows(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()
    .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)])));
}
function tableSha(db: DatabaseSync, table: string) {
  const values = rows(db, table);
  return { table, rows: values.length, sha256: sha(JSON.stringify(values)) };
}
function databasePath(input: string, name: string): string {
  assert.equal(path.basename(name), name);
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/u);
  return path.join(path.dirname(input), name);
}
/** Allowed originals: workspace, node and body creation, and one yjs.update per authored Yjs revision. */
function journalAccounting(db: DatabaseSync, nodes: string[]) {
  const mutations = db.prepare(`SELECT m.target_family AS family,m.target_kind AS kind,m.target_id AS id,m.action,
    c.device_seq AS seq FROM sync_mutation m JOIN sync_change_set c USING(change_set_id) ORDER BY c.device_seq,m.mutation_index`)
    .all() as { family: string; kind: string; id: string; action: string; seq: number }[];
  const allowed = new Set(['entity project entity.create', 'entity kv-entry entity.create', 'order kv-entry order.move',
    'entity entity-relation-type entity.create', 'entity node entity.create', 'entity node-storyline-primary field.set',
    'yjs prose-document yjs.update']);
  for (const item of mutations) assert(allowed.has(`${item.family} ${item.kind} ${item.action}`), `Unexpected original ${JSON.stringify(item)}`);
  const seqs = [...new Set(mutations.map(item => Number(item.seq)))];
  assert.deepEqual(seqs, seqs.map((_, index) => index + 1), 'Journal device sequence has a gap');
  const writer = rows(db, 'sync_generation_writer_state');
  assert.equal(writer.length, 1);
  assert.equal(Number(writer[0]!.next_device_seq), seqs.length + 1);
  const perDocument = nodes.map(node => {
    const docId = proseDocId('node', node);
    const revision = Number((db.prepare('SELECT revision FROM yjs_document_revision WHERE document_id=?').get(docId) ?? { revision: 0 }).revision);
    const provenance = db.prepare('SELECT revision FROM yjs_document_revision_provenance WHERE document_id=? ORDER BY revision')
      .all(docId).map(row => Number(row.revision));
    assert.deepEqual(provenance, Array.from({ length: revision }, (_, index) => index + 1));
    const updates = mutations.filter(item => item.action === 'yjs.update' && item.id === docId).length;
    assert.equal(updates, revision, `${docId}: every authored Yjs revision journals exactly one yjs.update`);
    return { revision, yjsUpdates: updates };
  });
  return { changeSets: seqs.length, mutations: mutations.length, perDocument };
}
/** Durable Yjs state of one document, in the production persistence order (snapshot, then updates by id). */
function reducerBodyCache(db: DatabaseSync, docId: string): string {
  // The production reducer (materializeYjsUpdate) applies the snapshot and each
  // stored update in turn to a default Y.Doc before projecting node_content.
  const document = new Y.Doc();
  try {
    const snapshot = db.prepare('SELECT state_blob FROM yjs_snapshots WHERE document_id=?').get(docId);
    if (snapshot) Y.applyUpdate(document, snapshot.state_blob as Uint8Array, 'remote-sync');
    for (const row of db.prepare('SELECT update_blob FROM yjs_updates WHERE document_id=? ORDER BY id').all(docId)) {
      Y.applyUpdate(document, row.update_blob as Uint8Array, 'remote-sync');
    }
    return JSON.stringify(yDocToProsemirrorJSON(document, 'default'));
  } finally { document.destroy(); }
}

async function verifyExport(input: string, item: Export, ordinal: number) {
  const file = databasePath(input, item.database);
  const scratch = mkdtempSync(path.join(path.dirname(path.resolve(option('--output')!)), `metrics-${ordinal}-`));
  const copy = path.join(scratch, 'renderer.db');
  copyFileSync(file, copy);
  const gateway = new ProductFileBackedSqliteGateway(copy);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const client = gateway.client();
    const coordinator = createYjsProsePersistenceCoordinator({ database: client, getLiveDocument: () => undefined });
    const nodes = [];
    for (const nodeId of item.nodes) {
      const docId = proseDocId('node', nodeId);
      const nativeNode = db.prepare(`SELECT kind,word_count,word_count_basis_kind,word_count_basis_hash,word_count_basis_revision,
        word_count_basis_server_seq,created_at,updated_at FROM book_node WHERE id=? AND project_id=?`).get(nodeId, item.projectId) as Row;
      const nativeContent = db.prepare('SELECT content_json,outline_json,created_at,updated_at FROM node_content WHERE node_id=?')
        .get(nodeId) as Row;
      assert(nativeNode && nativeContent, `${nodeId} has no native projection rows`);
      // materializeCanonicalNodeProse's capture: the stored cache seeds a body
      // without durable Yjs state; otherwise the closed durable state wins.
      const seed = await createEntitySeedUpdate(String(nativeContent.content_json));
      const base = await coordinator.readBase(docId, seed);
      const renderer = await deriveCanonicalNodeProseProjection(nodeId, base);
      const durableRevision = Number((db.prepare('SELECT revision FROM yjs_document_revision WHERE document_id=?').get(docId)
        ?? { revision: 0 }).revision);
      assert.equal(base.revision, durableRevision);
      assert.equal(base.sourceKind, durableRevision > 0 ? 'closed' : 'seed');
      const comparison = compare({ contentJson: String(nativeContent.content_json), outlineJson: String(nativeContent.outline_json),
        wordCount: Number(nativeNode.word_count), basisHash: String(nativeNode.word_count_basis_hash) }, renderer);
      // Word count, basis and outline are exact; the body cache may differ only
      // in object key order, pinned per node by the acceptance generator.
      assert.notEqual(comparison.content, 'differs', `${nodeId}: ${JSON.stringify(comparison.differences)}`);
      assert.equal(comparison.outline, 'equal');
      assert.equal(Number(nativeNode.word_count), renderer.wordCount);
      assert.equal(nativeNode.word_count_basis_hash, renderer.wordCountBasisHash);
      assert.equal(nativeNode.word_count_basis_kind, renderer.wordCountBasisKind);
      assert.equal(nativeNode.word_count_basis_revision === null ? null : Number(nativeNode.word_count_basis_revision),
        renderer.wordCountBasisRevision);
      assert.equal(nativeNode.word_count_basis_server_seq, null);
      assert.equal(reducerBodyCache(db, docId), renderer.contentJson, `${nodeId}: the reducer body cache differs from the canonical projection`);
      // The renderer's own reuse decision over the native rows, read through its repositories.
      const node = await createBookNodeSqliteRepository(item.projectId, client).findById(nodeId);
      const content = await createBookContentRepository(client, item.projectId).findByNodeId(nodeId);
      assert(node && content);
      assert.equal(hasCanonicalWordCount(node), true);
      const outline = positionalOutline(renderer.outlineJson, renderer.contentJson);
      const reuse = canReuseCanonicalProjection(node, content, renderer);
      const positional = { ...renderer, outlineJson: outline.outlineJson };
      const refusals = [
        ...(node.wordCount === renderer.wordCount && node.wordCountBasisHash === renderer.wordCountBasisHash ? [] : ['basis']),
        ...(node.wordCountBasisServerSeq != null || node.wordCountBasisRevision === renderer.wordCountBasisRevision ? [] : ['revision']),
        ...(content.contentJson === renderer.contentJson ? [] : ['content_json']),
        ...(content.outlineJson === renderer.outlineJson ? [] : [outline.drawn ? 'outline_json (drawn id)' : 'outline_json']),
      ];
      assert.equal(reuse, refusals.length === 0);
      assert.equal(canReuseCanonicalProjection(node, content, positional), !refusals.some(reason => reason !== 'outline_json (drawn id)'));
      nodes.push({
        kind: String(nativeNode.kind), wordCount: renderer.wordCount, basisKind: renderer.wordCountBasisKind,
        basisRevision: renderer.wordCountBasisRevision, durableRevision, content: comparison.content,
        differences: comparison.differences, outline: comparison.outline, drawnOutlineIds: outline.drawn, reducerBodyCache: 'equal',
        canReuse: reuse, reuseRefusals: refusals,
        touched: nativeNode.updated_at !== nativeNode.created_at || nativeContent.updated_at !== nativeContent.created_at,
        stampsAgree: nativeNode.updated_at === nativeContent.updated_at,
        contentSha256: sha(String(nativeContent.content_json)), outlineSha256: sha(String(nativeContent.outline_json)),
      });
    }
    return {
      name: item.name, databaseSha256: sha(readFileSync(file)), nodes,
      journal: journalAccounting(db, item.nodes),
      tables: [...journalTables, ...yjsTables, 'book_node', 'node_content'].map(table => tableSha(db, table)),
    };
  } finally {
    db.close();
    await gateway.close();
  }
}
/** Cells changed between two consecutive exports, by table and column. */
function transition(input: string, before: Export, after: Export) {
  const a = new DatabaseSync(databasePath(input, before.database), { readOnly: true });
  const b = new DatabaseSync(databasePath(input, after.database), { readOnly: true });
  try {
    for (const table of [...journalTables, ...yjsTables]) {
      assert.deepEqual(rows(b, table), rows(a, table), `${after.name}: ${table} changed`);
    }
    const changed: string[] = [];
    for (const [table, key] of [['book_node', 'id'], ['node_content', 'node_id']] as const) {
      const previous = new Map(rows(a, table).map(row => [row[key], row]));
      const next = rows(b, table);
      assert.equal(next.length, previous.size);
      for (const row of next) {
        const old = previous.get(row[key]);
        assert(old, `${table} row appeared`);
        const node = after.nodes.indexOf(String(row[key]));
        for (const column of Object.keys(row)) {
          if (isDeepStrictEqual(row[column], old[column])) continue;
          assert(node >= 0 && [...derivedColumns[table]!, 'updated_at'].includes(column), `${table}.${column} changed`);
          changed.push(`${table}.${column}@${node}`);
        }
      }
    }
    return { from: before.name, to: after.name, journal: 'unchanged', yjs: 'unchanged', changedCells: changed.sort() };
  } finally {
    a.close();
    b.close();
  }
}

async function main() {
  const emit = option('--emit-corpus');
  if (emit) {
    emitCorpus(path.resolve(emit));
    return;
  }
  const input = path.resolve(option('--input') ?? assert.fail('--input is required'));
  const output = path.resolve(option('--output') ?? assert.fail('--output is required'));
  const corpusFile = path.resolve(option('--corpus') ?? assert.fail('--corpus is required'));
  const nativeCorpus = path.resolve(option('--native-corpus') ?? assert.fail('--native-corpus is required'));
  mkdirSync(path.dirname(output), { recursive: true });
  const wire = JSON.parse(readFileSync(input, 'utf8')) as { schemaVersion: number; exports: Export[] };
  assert.equal(wire.schemaVersion, 1);
  const exports = [];
  for (const [index, item] of wire.exports.entries()) {
    assert.equal(item.nodes.length, 3, 'An edited chapter, an untouched chapter and a drift');
    if (index > 0) assert.deepEqual(item.nodes, wire.exports[0]!.nodes);
    exports.push(await verifyExport(input, item, index));
  }
  const transitions = wire.exports.slice(1).map((item, index) => transition(input, wire.exports[index]!, item));
  const corpusCases = await verifyCorpus(corpusFile, nativeCorpus);
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)),
    corpusSha256: sha(readFileSync(corpusFile)), nativeCorpusSha256: sha(readFileSync(nativeCorpus)),
    exports, transitions, corpus: corpusCases }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', exports: exports.length, corpus: corpusCases.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
