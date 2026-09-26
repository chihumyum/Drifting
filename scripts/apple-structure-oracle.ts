// Use the actual chapter schema, BlockId plugin and ProseMirror commands as a
// behavioral oracle. Fixtures below are synthetic; no DOM or live library.
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { splitBlock } from '@tiptap/pm/commands';
import { getStaticChapterSchema } from '../src/renderer/components/editor/chapter-static-html';
import { createBlockIdPlugin } from '../src/renderer/lib/extensions/block-id';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { encodeStateAsUpdate } from 'yjs';

const schema = getStaticChapterSchema();
if (!schema) throw new Error('The real chapter schema must be available');
const paragraph = (id: string, text: string, kind = 'paragraph') => ({ type: kind,
  attrs: { id, ...(kind === 'heading' ? { level: 2 } : {}) },
  ...(text ? { content: [{ type: 'text', text }] } : {}) });
const base = { type: 'doc', content: [paragraph('a', '甲👩🏽‍🚀乙'), paragraph('b', '远方'), paragraph('c', '尾声')] };
const heading = { type: 'doc', content: [paragraph('h', '灯塔', 'heading'), paragraph('p', '海岸')] };
const nested = { type: 'doc', content: [{type: 'blockquote', attrs: {id: 'quote'}, content: [paragraph('q1', '潮汐'), paragraph('q2', '夜航')]}] };
const quote = (id: string, content: unknown[]) => ({ type: 'blockquote', attrs: { id }, content });
const mixed = { type: 'doc', content: [paragraph('a', '开篇'), quote('quote', [paragraph('q1', '潮汐'), paragraph('q2', '夜航')]), paragraph('z', '终章')] };
const adjacentQuotes = { type: 'doc', content: [quote('left', [paragraph('a', '开篇'), paragraph('b', '潮汐')]), quote('right', [paragraph('c', '夜航'), paragraph('d', '终章')])] };
const deep = { type: 'doc', content: [quote('outer', [paragraph('a', '开篇'), quote('inner', [paragraph('b', '潮汐'), paragraph('c', '夜航')]), paragraph('d', '终章')]), paragraph('z', '远方')] };
const marked = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'marked' }, content: [
  { type: 'text', text: '甲' }, { type: 'text', text: '北塔', marks: [{ type: 'bold' }, { type: 'entityLink', attrs: { targetKind: 'element', targetId: 'synthetic-element' } }] },
  { type: 'text', text: '乙' },
] }] };
const definitions = [
  { name: 'paragraph start', doc: base, at: 0, length: 0, text: '\n' },
  { name: 'paragraph after emoji', doc: base, at: 8, length: 0, text: '\n' },
  { name: 'paragraph end', doc: base, at: 9, length: 0, text: '\n' },
  { name: 'join paragraphs', doc: base, at: 9, length: 1, text: '' },
  { name: 'replace three paragraphs', doc: base, at: 1, length: 13, text: '星河' },
  { name: 'multiline paste across paragraphs', doc: base, at: 1, length: 11, text: '一\n二\n三' },
  { name: 'heading start', doc: heading, at: 0, length: 0, text: '\n' },
  { name: 'heading middle', doc: heading, at: 1, length: 0, text: '\n' },
  { name: 'heading end', doc: heading, at: 2, length: 0, text: '\n' },
  { name: 'heading join', doc: heading, at: 2, length: 1, text: '' },
  { name: 'selection replaced by Enter', doc: heading, at: 0, length: 4, text: '\n' },
  { name: 'blockquote paragraph split', doc: nested, at: 1, length: 0, text: '\n' },
  { name: 'blockquote paragraph join', doc: nested, at: 2, length: 1, text: '' },
  { name: 'paragraph joins quote start', doc: mixed, at: 2, length: 1, text: '' },
  { name: 'quote end joins paragraph', doc: mixed, at: 8, length: 1, text: '' },
  { name: 'paragraph replaces into quote', doc: mixed, at: 1, length: 3, text: '新' },
  { name: 'quote replaces into paragraph', doc: mixed, at: 7, length: 3, text: '新' },
  { name: 'quote joins at empty prefix', doc: mixed, at: 6, length: 4, text: '' },
  { name: 'paragraph consumes entire quote prefix', doc: mixed, at: 0, length: 7, text: '' },
  { name: 'replace all container contents', doc: mixed, at: 0, length: 11, text: '新' },
  { name: 'multiline paragraph into quote', doc: mixed, at: 1, length: 3, text: '一\n二' },
  { name: 'multiline quote into paragraph', doc: mixed, at: 7, length: 3, text: '一\n二' },
  { name: 'Enter paragraph into quote', doc: mixed, at: 1, length: 3, text: '\n' },
  { name: 'Enter quote into paragraph', doc: mixed, at: 7, length: 3, text: '\n' },
  { name: 'join adjacent quotes preserving right suffix identity', doc: { type: 'doc', content: [quote('qleft', [paragraph('b', '潮汐')]), quote('qright', [paragraph('c', '夜航'), paragraph('d', '终章')])] }, at: 2, length: 1, text: '' },
  { name: 'join adjacent quotes', doc: adjacentQuotes, at: 5, length: 1, text: '', rejection: 'Container suffix relocation requires identity-safe history' },
  { name: 'replace across adjacent quotes', doc: adjacentQuotes, at: 4, length: 3, text: '新', rejection: 'Container suffix relocation requires identity-safe history' },
  { name: 'join fully consumed adjacent quote', doc: { type: 'doc', content: [quote('left', [paragraph('a', '开篇'), paragraph('b', '潮汐')]), quote('right', [paragraph('c', '夜航')])] }, at: 5, length: 1, text: '' },
  { name: 'replace across nested quote inward', doc: deep, at: 1, length: 3, text: '新' },
  { name: 'replace across nested quote outward', doc: deep, at: 7, length: 3, text: '新' },
  { name: 'replace nested quote to root', doc: deep, at: 4, length: 9, text: '新' },
  { name: 'join quotes at empty partial prefix', doc: adjacentQuotes, at: 3, length: 4, text: '', rejection: 'Container suffix relocation requires identity-safe history' },
  { name: 'join quotes at empty full prefix', doc: adjacentQuotes, at: 0, length: 7, text: '' },
  { name: 'remove quote to root from full prefix', doc: mixed, at: 3, length: 7, text: '' },
  { name: 'Enter quote to root from full prefix', doc: mixed, at: 3, length: 7, text: '\n' },
  { name: 'marked tail split', doc: marked, at: 2, length: 0, text: '\n' },
  { name: 'entity-link interior input', doc: marked, at: 2, length: 0, text: '新' },
  { name: 'entity-link boundary input', doc: marked, at: 3, length: 0, text: '新' },
  { name: 'entity-link selection ending outside link', doc: marked, at: 2, length: 2, text: '新' },
  { name: 'empty paragraph Enter', doc: {type: 'doc', content: [paragraph('empty', '')]}, at: 0, length: 0, text: '\n' },
];
function pmPosition(doc: PMNode, offset: number) {
  let at = 0, found: number | undefined;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (found === undefined && at <= offset && offset <= at + node.content.size) found = pos + 1 + offset - at;
    at += node.content.size + 1;
    return false;
  });
  if (found === undefined) throw new Error(`No text position at ${offset}`);
  return found;
}
const cases = definitions.map(test => {
  const doc = schema.nodeFromJSON(test.doc);
  let state = EditorState.create({schema, doc,
    selection: TextSelection.create(doc, pmPosition(doc, test.at), pmPosition(doc, test.at + test.length)), plugins: [createBlockIdPlugin()]});
  if (test.text === '\n') {
    if (!splitBlock(state, transaction => { state = state.applyTransaction(transaction).state; })) throw new Error(`Enter refused: ${test.name}`);
  } else if (test.text.includes('\n')) {
    const blocks = test.text.split('\n').map(text => schema.nodes.paragraph.create(null, text ? schema.text(text) : null));
    state = state.applyTransaction(state.tr.replaceSelection(new Slice(Fragment.fromArray(blocks), 1, 1))).state;
  } else {
    state = state.applyTransaction(state.tr.insertText(test.text)).state;
  }
  const ydoc = prosemirrorJSONToYDoc(schema, doc.toJSON(), 'default');
  const updateBase64 = Buffer.from(encodeStateAsUpdate(ydoc)).toString('base64');
  ydoc.destroy();
  return { name: test.name, before: doc.toJSON(), updateBase64, expected: state.doc.toJSON(), range: { location: test.at, length: test.length }, text: test.text, ...('rejection' in test ? { rejection: test.rejection } : {}) };
});
const defaults = Object.fromEntries(Object.entries(schema.nodes).map(([name, type]) => [name,
  Object.fromEntries(Object.entries(type.spec.attrs ?? {}).map(([key, value]) => [key, value.default]))]));
console.log(JSON.stringify({ cases, defaults }));
