import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Schema, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import { captureEditorSelectionSnapshot } from '../src/renderer/lib/editor-selection-memory';

const baselineCommit = 'e0c7a8c';
const sourcePath = 'src/renderer/lib/editor-selection-memory.ts';
const evidencePath = 'docs/renderer-performance/acceptance/f3-selection-capture.json';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:${sourcePath}`], { encoding: 'utf8' });
const fingerprint = sha([sourcePath, 'scripts/measure-selection-memory.ts', 'package.json', 'pnpm-lock.yaml'].map(file => `${file}\0${sha(readFileSync(file, 'utf8'))}`).join('\n'));
function validate(report: { source: { fingerprint: string }; status: string; scenarios: Array<{ characters: number; baseline: MeasuredCapture; current: MeasuredCapture }>; limitations: string[] }) {
  assert.equal(report.status, 'measured'); assert.equal(report.source.fingerprint, fingerprint);
  assert.deepEqual(report.scenarios.map(row => row.characters), [5000, 20000, 50000]);
  for (const row of report.scenarios) {
    assert.equal(row.baseline.counters.captures, 200); assert.equal(row.current.counters.captures, 200);
    assert.equal(row.baseline.counters.documentWalks, 200);
    assert.equal(row.baseline.counters.blockTextReads, row.characters / 100 * 200);
    assert.equal(row.current.counters.documentWalks, 0); assert.equal(row.current.counters.nodesVisited, 0);
    assert.equal(row.current.counters.blockTextReads, 0); assert.equal(row.current.counters.rangeTextReads, 0);
    assert.deepEqual(row.current.batchChecksums, row.baseline.batchChecksums);
    for (const measured of [row.baseline, row.current]) {
      assert.equal(measured.batchMs.length, 7); assert.equal(measured.batchChecksums.length, 7);
      assert(measured.batchMs.every(ms => Number.isFinite(ms) && ms >= 0));
      assert(measured.batchChecksums.every(sum => Number.isSafeInteger(sum) && sum > 0));
    }
  }
  assert(report.limitations.length > 0);
}
type Capture = (editor: Editor) => unknown;
interface Counters { captures: number; documentWalks: number; nodesVisited: number; blockTextReads: number; rangeTextReads: number }
interface MeasuredCapture { counters: Counters; batchMs: number[]; batchChecksums: number[] }
const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', attrs: { id: { default: null } } }, text: { group: 'inline' },
} });

async function main() {
  if (process.argv.includes('--check')) {
    validate(JSON.parse(readFileSync(evidencePath, 'utf8')));
    console.log('Selection capture evidence passed; no native input or device budget inferred.'); return;
  }
  const local = '.local-data/renderer-performance'; mkdirSync(local, { recursive: true });
  const temporary = mkdtempSync(path.join(local, 'selection-baseline-'));
  try {
    const legacyPath = path.resolve(temporary, 'legacy.ts');
    writeFileSync(legacyPath, baselineSource);
    const legacyModule = await import(pathToFileURL(legacyPath).href);
    const legacy: Capture = legacyModule.captureEditorSelectionSnapshot ?? legacyModule.default?.captureEditorSelectionSnapshot;
    assert.equal(typeof legacy, 'function');
    const scenarios = [5000, 20000, 50000].map(characters => {
      const blocks = Array.from({ length: characters / 100 }, (_, index) => schema.node('paragraph', { id: `synthetic-${index}` }, schema.text('合成'.repeat(50))));
      const doc = schema.node('doc', null, blocks);
      const editors = Array.from({ length: 200 }, (_, index) => {
        const anchor = index % blocks.length * 102 + 10 + index % 60;
        const head = index % 2 ? anchor - 4 : anchor;
        return { state: EditorState.create({ doc, selection: TextSelection.create(doc, anchor, head) }) } as Editor;
      });
      for (const editor of editors) {
        const old = legacy(editor) as { from: number; to: number };
        const next = captureEditorSelectionSnapshot(editor);
        assert.equal(Math.min(next.anchor, next.head), old.from); assert.equal(Math.max(next.anchor, next.head), old.to);
      }
      function measure(capture: Capture) {
        const counters: Counters = { captures: 0, documentWalks: 0, nodesVisited: 0, blockTextReads: 0, rangeTextReads: 0 };
        const originalWalk = doc.descendants; const originalText = doc.textBetween;
        const textDescriptor = Object.getOwnPropertyDescriptor(ProseMirrorNode.prototype, 'textContent')!;
        try {
          doc.descendants = callback => {
            counters.documentWalks++;
            originalWalk.call(doc, (node, position, parent, index) => { counters.nodesVisited++; return callback(node, position, parent, index); });
          };
          doc.textBetween = (...args) => { counters.rangeTextReads++; return originalText.apply(doc, args); };
          Object.defineProperty(ProseMirrorNode.prototype, 'textContent', { ...textDescriptor, get() {
            if (this.isBlock) counters.blockTextReads++;
            return textDescriptor.get!.call(this);
          } });
          for (const editor of editors) { capture(editor); counters.captures++; }
        } finally {
          delete (doc as Partial<ProseMirrorNode>).descendants; delete (doc as Partial<ProseMirrorNode>).textBetween;
          Object.defineProperty(ProseMirrorNode.prototype, 'textContent', textDescriptor);
        }
        // Timings exclude counter wrappers and are not input-to-paint samples.
        for (let warmup = 0; warmup < 3; warmup++) for (const editor of editors) capture(editor);
        const batchChecksums: number[] = [];
        const batchMs = Array.from({ length: 7 }, () => {
          let checksum = 0;
          const start = performance.now();
          for (const editor of editors) {
            const value = capture(editor) as { from?: number; to?: number; anchor?: number; head?: number };
            checksum += (value.from ?? value.anchor!) + (value.to ?? value.head!);
          }
          const elapsed = performance.now() - start;
          // Consume every result so the optimized capture is not benchmarked
          // as an unused, side-effect-free call that the JIT may eliminate.
          batchChecksums.push(checksum); return elapsed;
        });
        return { counters, batchMs, batchChecksums };
      }
      const baseline = measure(legacy); const current = measure(captureEditorSelectionSnapshot);
      assert.deepEqual(current.batchChecksums, baseline.batchChecksums);
      return { characters, blocks: blocks.length, capturesPerBatch: 200, fixtureHash: sha(JSON.stringify(doc.toJSON())), baseline, current };
    });
    const report = { kind: 'selection_capture_comparison', status: 'measured', generatedAt: new Date().toISOString(),
      source: { commit: git('rev-parse', 'HEAD'), fingerprint, baselineCommit: git('rev-parse', baselineCommit), baselineSourceHash: sha(baselineSource) },
      environment: { node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0].model, totalMemoryBytes: os.totalmem() }, scenarios,
      limitations: ['Node microbenchmark with real immutable ProseMirror documents and synthetic editor-state holders.', 'Counters are collected separately from seven warmed batch timings.', 'Baseline is the exact pre-change capture function, including now-unused prose/context derivation.', 'No React, WebView, physical IME, input-to-paint or device performance budget is measured.'] };
    validate(report); writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Selection capture report: ${evidencePath}`);
  } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
