// Real renderer extraction and nesting on synthetic current Yjs semantics.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractOutline } from '../src/renderer/lib/outline';
import { nestHeadings, type OutlineEntry } from '../src/renderer/components/editor/outline-rail-model';

const source = process.argv[2];
assert(source, 'Synthetic outline comparison input is required');
const cases = JSON.parse(readFileSync(source, 'utf8')) as {
  name: string;
  semantic: unknown;
  native: { blockId: string; level: number; text: string; parentId: string | null }[];
}[];
assert(cases.length >= 3);
for (const test of cases) {
  const expected: typeof test.native = [];
  const visit = (entries: OutlineEntry[], parentId: string | null) => {
    for (const entry of entries) {
      expected.push({ blockId: entry.id, level: entry.level, text: entry.text, parentId });
      visit(entry.children ?? [], entry.id);
    }
  };
  visit(nestHeadings(extractOutline(JSON.stringify(test.semantic))), null);
  assert.deepEqual(test.native, expected, `Outline extraction differs: ${test.name}`);
}
console.log(JSON.stringify({ status: 'passed', cases: cases.map(test => test.name) }));
