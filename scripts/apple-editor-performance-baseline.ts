// Reproducible synthetic corpus only. This Node program does not measure UI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror';
import { getStaticChapterSchema } from '../src/renderer/components/editor/chapter-static-html';

export interface EditorPerformanceCorpusCase {
  id: '5k' | '50k' | '200k';
  utf16Length: number;
  paragraphCount: number;
  plainText: string;
  proseMirrorJson: JSONContent;
  updateBase64: string;
  plainTextSha256: string;
  proseMirrorSha256: string;
  updateSha256: string;
}

export interface EditorPerformanceCorpus {
  schemaVersion: 1;
  kind: 'apple-editor-performance-corpus';
  seed: 'apple-editor-performance-v1';
  textConvention: 'UTF-16 code units; one LF between text blocks; no trailing LF';
  samplesPerCase: 30;
  warmSwitchSamples: 10;
  scrollSteps: 60;
  editRange: { location: 8; length: 0 };
  editText: '验';
  cases: EditorPerformanceCorpusCase[];
  corpusSha256: string;
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const tokens = ['合成数据只用于性能验收。', '春雨落在石阶上，远处的灯光照见空旷的长廊。', '👩🏽‍🚀', '海风掠过纸页。', 'e\u0301', '星河与潮汐。'];

function textOfLength(length: number, paragraphIndex: number): string {
  let text = '合成验收文字段落。'.slice(0, length);
  let index = paragraphIndex % tokens.length;
  while (text.length < length) {
    const token = tokens[index++ % tokens.length];
    // Preserve every synthetic grapheme, including emoji ZWJ and combining text.
    text += token.length <= length - text.length ? token : '文';
  }
  return text;
}

function makeCase(id: EditorPerformanceCorpusCase['id'], utf16Length: number): EditorPerformanceCorpusCase {
  const schema = getStaticChapterSchema();
  assert(schema, 'The production chapter schema is required');
  const content: JSONContent[] = [];
  const paragraphs: string[] = [];
  let remaining = utf16Length;
  while (remaining > 0) {
    const index = content.length;
    let length = Math.min(index === 0 ? 48 : 384, remaining);
    if (remaining - length === 1) length += 1; // Never manufacture a trailing LF.
    const text = textOfLength(length, index);
    const runs: JSONContent[] = index % 6 === 0 && length > 24
      ? [{ type: 'text', text: text.slice(0, 6), marks: [{ type: 'bold' }] },
        { type: 'text', text: text.slice(6) }]
      : [{ type: 'text', text }];
    content.push({ type: index === 0 ? 'heading' : 'paragraph',
      attrs: { id: `perf-${id}-${index}`, ...(index === 0 ? { level: 2 } : {}) }, content: runs });
    paragraphs.push(text);
    remaining -= length;
    if (remaining > 0) remaining -= 1;
  }
  const plainText = paragraphs.join('\n');
  assert.equal(plainText.length, utf16Length);
  const doc = schema.nodeFromJSON({ type: 'doc', content });
  doc.check();
  assert.equal(doc.textBetween(0, doc.content.size, '\n'), plainText);
  const proseMirrorJson = JSON.parse(JSON.stringify(doc.toJSON())) as JSONContent;
  const ydoc = new Y.Doc();
  // No random IDs or timestamps enter serialized fixture bytes.
  ydoc.clientID = 710_000 + utf16Length;
  try {
    prosemirrorToYXmlFragment(doc, ydoc.getXmlFragment('default'));
    const update = Y.encodeStateAsUpdate(ydoc);
    const replay = new Y.Doc();
    try {
      Y.applyUpdate(replay, update);
      assert.equal(JSON.stringify(schema.nodeFromJSON(yDocToProsemirrorJSON(replay, 'default')).toJSON()), JSON.stringify(proseMirrorJson));
    } finally { replay.destroy(); }
    return { id, utf16Length, paragraphCount: paragraphs.length, plainText, proseMirrorJson,
      updateBase64: Buffer.from(update).toString('base64'), plainTextSha256: sha256(plainText),
      proseMirrorSha256: sha256(JSON.stringify(proseMirrorJson)), updateSha256: sha256(update) };
  } finally { ydoc.destroy(); }
}

export function createEditorPerformanceCorpus(): EditorPerformanceCorpus {
  const content = { schemaVersion: 1 as const, kind: 'apple-editor-performance-corpus' as const,
    seed: 'apple-editor-performance-v1' as const,
    textConvention: 'UTF-16 code units; one LF between text blocks; no trailing LF' as const,
    samplesPerCase: 30 as const, warmSwitchSamples: 10 as const, scrollSteps: 60 as const,
    editRange: { location: 8 as const, length: 0 as const }, editText: '验' as const,
    cases: [makeCase('5k', 5_000), makeCase('50k', 50_000), makeCase('200k', 200_000)] };
  return { ...content, corpusSha256: sha256(JSON.stringify(content)) };
}

async function main() {
  const corpus = createEditorPerformanceCorpus();
  assert.deepEqual(createEditorPerformanceCorpus(), corpus, 'Corpus bytes must reproduce exactly');
  const check = process.argv.find(arg => arg.startsWith('--check='))?.slice(8);
  const output = process.argv.find(arg => arg.startsWith('--out='))?.slice(6);
  if (check) {
    assert.deepEqual(JSON.parse(await readFile(check, 'utf8')), corpus);
    console.log(`Reproducible editor corpus verified: ${corpus.corpusSha256}`);
  } else if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(corpus, null, 2)}\n`);
    console.log(`Editor corpus written: ${output} (${corpus.corpusSha256})`);
  } else {
    console.log(JSON.stringify(corpus));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error); process.exitCode = 1; });
}
