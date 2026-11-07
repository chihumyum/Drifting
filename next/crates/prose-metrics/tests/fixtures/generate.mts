// Expected word counts from the 0.1 client's TypeScript rule itself
// (`packages/prose-metrics/src/index.ts`), for `tests/ts_parity.rs`.
//
// Run from the repository root with Node 22 or later (it strips the types):
//
//   node --experimental-strip-types next/crates/prose-metrics/tests/fixtures/generate.mts
//
// Writes `count-words.json` next to this file. Every string is synthetic:
// hand-written edge cases plus strings drawn from a fixed character pool by a
// seeded generator, so the output is identical on every run.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countWords,
  countWordsInPmJson,
  extractProseText,
} from '../../../../../packages/prose-metrics/src/index.ts';

const handWritten: string[] = [
  '',
  ' ',
  '\n\t\r\v\f',
  'word',
  'two words',
  'Hello, world!',
  "don't stop-me-now 2026",
  '她叫安娜。',
  '安娜说：“你好。”',
  'Anna说：hello',
  '他在2026年读了《Pride and Prejudice》。',
  'abc。def',
  'abc，def',
  'abc,def',
  'ＡＢＣ　ｄｅｆ１２３',
  'ｱｲｳ abc',
  'こんにちは 世界',
  'カタカナとひらがな',
  '안녕하세요 hello',
  'привет мир',
  'Ελλάδα 2',
  'café naïve résumé',
  'ét́é',
  '\u{20000}\u{2A6D6} 𠀀',
  '豈﨎 豈',
  '⺀⼀ ⺀',
  '㐀䶿一鿿',
  '㏿䷀䷿ꀀ',
  '　〿぀',
  '﻿a﻿b﻿',
  'a\u0085b',
  'a᠎b',
  'a​b',
  'a b c',
  'a b c d e f g',
  '\u001Ca\u001Fb',
  '😀 smile 😀smile',
  '￼',
  'x￼y',
  '— … !! ?? ...',
  '1.5 3,000 #42 @anna',
  'snake_case kebab-case camelCase',
  '\t\tindented\n\nlines\r\n',
  '第一章 第一节',
  '　　段首两个全角空格。',
];

// mulberry32: a tiny seeded generator, so the fixture never changes.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pool: string[] = [
  ...'abcxyzABCXYZ0189',
  ...' \t\n\r\v\f',
  ...'.,;:!?\'"-_()[]{}<>/\\@#$%&*+=~`|^',
  ' ', ' ', ' ', ' ', ' ', ' ', ' ',
  ' ', ' ', '　', '﻿', '\u0085', '᠎', '​',
  '\u001C', '\u001F',
  '㐀', '㐁', '䶿', '䷀', '一', '丁', '龥', '鿿', 'ꀀ',
  ...'安娜的书在桌上她说你好',
  '、', '。', '「', '」', '〿', '぀',
  '！', '，', 'Ａ', 'ａ', '０', '｡', 'ﾟ', '￯', '￰',
  ...'こんにちはカタカナ',
  ...'안녕',
  ...'приветΑλφα',
  ...'éñüß',
  '́',
  '\u{20000}', '\u{2A6D6}', '豈', '⺀', '\u{1F600}', '￼',
];

const random = mulberry32(20261107);
const generated: string[] = [];
for (let i = 0; i < 1500; i++) {
  const length = Math.floor(random() * 41);
  let s = '';
  for (let j = 0; j < length; j++) s += pool[Math.floor(random() * pool.length)];
  generated.push(s);
}

const cases = [...handWritten, ...generated].map((text) => ({ text, words: countWords(text) }));

// The deliberate difference (simplifications.md, section one, item 20): the
// 0.1 client extracts text from ProseMirror JSON with a space after every
// child node, so a Latin word split by a mark counts twice. The new client
// counts the paragraphs' real text. `old` is the 0.1 count of the document;
// `paragraphs` is the text the new client counts.
type PmNode = { type: string; text?: string; marks?: { type: string }[]; content?: PmNode[] };
const paragraph = (...content: PmNode[]): PmNode => ({ type: 'paragraph', content });
const text = (t: string, ...marks: string[]): PmNode =>
  marks.length ? { type: 'text', text: t, marks: marks.map((type) => ({ type })) } : { type: 'text', text: t };
const pmDocuments: { name: string; doc: PmNode; paragraphs: string[] }[] = [
  {
    name: 'plain paragraphs agree',
    doc: { type: 'doc', content: [paragraph(text('Hello world')), paragraph(text('她叫安娜。'))] },
    paragraphs: ['Hello world', '她叫安娜。'],
  },
  {
    name: 'a bold split Latin word counted twice by 0.1',
    doc: { type: 'doc', content: [paragraph(text('hel'), text('lo', 'bold'), text(' world'))] },
    paragraphs: ['hello world'],
  },
  {
    name: 'a linked name inside a Latin word',
    doc: { type: 'doc', content: [paragraph(text('Mr'), text('Darcy', 'entityLink'), text("'s letter"))] },
    paragraphs: ["MrDarcy's letter"],
  },
  {
    name: 'CJK split by marks is unaffected',
    doc: { type: 'doc', content: [paragraph(text('安'), text('娜', 'bold'), text('说'))] },
    paragraphs: ['安娜说'],
  },
];
const documents = pmDocuments.map(({ name, doc, paragraphs }) => ({
  name,
  old: countWordsInPmJson(JSON.stringify(doc)),
  oldExtracted: extractProseText(doc),
  paragraphs,
}));

const out = join(dirname(fileURLToPath(import.meta.url)), 'count-words.json');
writeFileSync(
  out,
  `${JSON.stringify(
    {
      source: 'packages/prose-metrics/src/index.ts countWords',
      generator: 'next/crates/prose-metrics/tests/fixtures/generate.mts',
      seed: 20261107,
      cases,
      pmDocuments: documents,
    },
    null,
    1,
  )}\n`,
);
console.log(`wrote ${cases.length} cases and ${documents.length} documents to ${out}`);
