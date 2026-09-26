import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

// Entirely synthetic, deterministic IDs and peer identity, independent of user data.
const document = new Y.Doc();
document.clientID = 0x4d494752;
function block(type, id, segments, attributes = {}) {
  const node = new Y.XmlElement(type);
  node.setAttribute('id', id);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (segments) {
    const text = new Y.XmlText();
    text.applyDelta(segments.map(segment => typeof segment === 'string' ? { insert: segment } : segment));
    node.insert(0, [text]);
  }
  return node;
}
const heading = block('heading', 'fixture-heading', ['合成文档：灯塔'], { level: 1 });
const paragraph = block('paragraph', 'fixture-paragraph', [
  '夜航员来到', { insert: '北塔', attributes: { bold: {}, entityLink: { targetId: 'fixture-element', targetKind: 'element' } } },
  '。👩🏽‍🚀 e\u0301 𠮷 שלום',
], { nativeUnknownAttribute: { keep: true, revision: 3 } });
const list = block('bulletList', 'fixture-list');
const item = block('listItem', 'fixture-item');
item.insert(0, [block('paragraph', 'fixture-list-paragraph', ['这是合成条目。'])]);
list.insert(0, [item]);
const quote = block('blockquote', 'fixture-quote');
quote.insert(0, [block('paragraph', 'fixture-quote-paragraph', ['潮汐会回来。'])]);
const code = block('codeBlock', 'fixture-code', ['signal = "synthetic"'], { language: 'text' });
const rule = block('horizontalRule', 'fixture-rule');
const opaque = block('futureWidget', 'fixture-opaque', null, { payload: { kind: 'synthetic', values: [1, 2, 3] } });
document.getXmlFragment('default').insert(0, [heading, paragraph, list, quote, code, rule, opaque]);
const binary = Y.encodeStateAsUpdate(document);
const restored = new Y.Doc();
Y.applyUpdate(restored, binary);
const semantic = yDocToProsemirrorJSON(document, 'default');
assert.deepEqual(yDocToProsemirrorJSON(restored, 'default'), semantic);
const fixture = {
  schemaVersion: 1, origin: 'synthetic-generated-no-user-content',
  yjsVersion: JSON.parse(readFileSync('node_modules/yjs/package.json', 'utf8')).version,
  updateEncoding: 'v1', root: 'default', updateBase64: Buffer.from(binary).toString('base64'), semantic,
  comments: [{ id: 'fixture-comment', targetBlockIds: ['fixture-paragraph'], textAnchor: {
    startBlockId: 'fixture-paragraph', startOffset: 5, endBlockId: 'fixture-paragraph', endOffset: 7, text: '北塔',
  } }],
  scale: { seed: '星光照着合成的海岸。', chapterUTF16Lengths: [5000, 50000, 200000], projectChapterCount: 1000 },
  requiredOperations: ['insert', 'delete', 'format', 'split', 'merge', 'undo-local', 'redo-local', 'concurrent-edit', 'duplicate-update', 'reordered-update', 'opaque-node-preservation', 'crash-replay'],
};
// The anchor uses UTF-16 offsets, not code points or UTF-8 bytes.
assert.equal(paragraph.get(0).toDelta().map(part => part.insert).join('').slice(fixture.comments[0].textAnchor.startOffset, fixture.comments[0].textAnchor.endOffset), '北塔');
const output = 'docs/apple-native/fixtures/document-v1.json';
if (process.argv.includes('--check')) assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), fixture, 'Synthetic corpus is stale');
else writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('Synthetic XML document: nested blocks, marks, unknown metadata, Unicode and comment anchor round-trip through current Yjs.');
document.destroy(); restored.destroy();
