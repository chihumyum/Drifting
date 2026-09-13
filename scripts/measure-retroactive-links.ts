import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import { linkEntityInDoc } from '../src/renderer/lib/retroactive-entity-links';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const baselineCommit = 'dd785f8228652cba58a9da4ed88dfa00a1c301be';
const sourcePath = 'src/renderer/lib/extensions/entity-link.ts';
const scriptPath = 'scripts/measure-retroactive-links.ts';
const output = process.argv.find(arg => arg.startsWith('--report='))?.slice(9) ?? 'docs/renderer-performance/acceptance/f3-link-matching.json';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const baselineSourceHash = '58475edf2c6f030fc6846cbde2bbfa066d5aac369bfc4d216dc4e19865198784';
const baselineFunctionHash = 'abc85513c329e886b3fd62bd2d3f3073bbe81cab3e8140d82fe84d4fed84f33a';
const fingerprint = () => sha(rendererSourceFingerprint(root) + '\0' + sha(readFileSync(scriptPath, 'utf8')));
const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
  marks: { entityLink: { attrs: { targetKind: {}, targetId: {}, targetBlockId: { default: null } } }, strong: {} } });
type Link = typeof linkEntityInDoc;
type Target = Parameters<Link>[1];
const target: Target = { kind: 'element', id: 'synthetic-target', names: Array.from({ length: 8 }, (_, i) => `合成别名${i}`) };
const paragraph = (text: string) => schema.node('paragraph', null, text ? schema.text(text) : []);
function holder(doc: PMNode) {
  const transactions: Transaction[] = [];
  const value = { schema, state: EditorState.create({ doc }), view: { dispatch(tr: Transaction) {
    transactions.push(tr); value.state = value.state.apply(tr);
  } } };
  return { value, transactions, editor: value as unknown as Editor };
}
function outcome(h: ReturnType<typeof holder>) {
  return { doc: h.value.state.doc.toJSON(), selection: h.value.state.selection.toJSON(),
    transactions: h.transactions.map(tr => ({ steps: tr.steps.map(step => step.toJSON()), history: tr.getMeta('addToHistory'), scroll: tr.scrolledIntoView })) };
}
function validate(report: Report, historical = false) {
  assert.equal(report.kind, 'retroactive_entity_link_comparison'); assert.equal(report.status, 'measured'); assert.equal(report.schemaVersion, 1);
  assert.equal(report.source.baselineCommit, baselineCommit); assert.equal(report.source.baselineSourceHash, baselineSourceHash);
  assert.equal(report.source.baselineFunctionHash, baselineFunctionHash);
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  if (!historical) assert.equal(report.source.fingerprint, fingerprint(), 'report source differs from current source');
  assert.equal(report.behavior.length, 72); assert.equal(new Set(report.behavior.map(check => check.id)).size, 72);
  for (const check of report.behavior) assert.equal(check.passed, true, check.id);
  assert.deepEqual(report.profiles.map(p => [p.characters, p.editors]), [5000, 20000, 50000].flatMap(n => [1, 5, 20].map(editors => [n, editors])));
  for (const p of report.profiles) {
    const nodes = p.characters / 100 * p.editors;
    assert.equal(p.aliases, 8); assert.equal(p.warmups, 1);
    assert.deepEqual(p.baseline.counters, { textNodes: nodes, regexConstructions: nodes * 8, markCreations: nodes, dispatches: p.editors });
    assert.deepEqual(p.current.counters, { textNodes: nodes, regexConstructions: 0, markCreations: p.editors, dispatches: p.editors });
    assert.equal(p.baseline.resultHash, p.current.resultHash); assert.match(p.current.resultHash, /^[a-f0-9]{64}$/);
    assert.match(p.fixtureHash, /^[a-f0-9]{64}$/);
    for (const side of [p.baseline, p.current]) {
      assert.equal(side.samplesMs.length, 5); assert(side.samplesMs.every(n => Number.isFinite(n) && n >= 0));
      assert.equal(side.medianMs, [...side.samplesMs].sort((a, b) => a - b)[2]);
    }
  }
  assert.equal(report.nativeAcceptance, false); assert(report.limitations.length >= 3);
}
function measureCounters(link: Link, doc: PMNode, editors: number) {
  const holders = Array.from({ length: editors }, () => holder(doc));
  const counters = { textNodes: 0, regexConstructions: 0, markCreations: 0, dispatches: 0 };
  const originalWalk = doc.descendants; const OriginalRegExp = globalThis.RegExp;
  const markType = schema.marks.entityLink; const originalCreate = markType.create;
  try {
    doc.descendants = callback => originalWalk.call(doc, (node, pos, parent, index) => {
      if (node.isText) counters.textNodes++; return callback(node, pos, parent, index);
    });
    globalThis.RegExp = new Proxy(OriginalRegExp, { construct(ctor, args) { counters.regexConstructions++; return Reflect.construct(ctor, args); } });
    markType.create = function (...args) { counters.markCreations++; return originalCreate.apply(this, args); };
    for (const h of holders) link(h.editor, target);
  } finally {
    delete (doc as Partial<PMNode>).descendants; globalThis.RegExp = OriginalRegExp; markType.create = originalCreate;
  }
  counters.dispatches = holders.reduce((sum, h) => sum + h.transactions.length, 0);
  return { counters, resultHash: sha(JSON.stringify(holders.map(outcome))) };
}
function time(link: Link, doc: PMNode, editors: number) {
  const holders = Array.from({ length: editors }, () => holder(doc));
  const start = performance.now();
  for (const h of holders) link(h.editor, target);
  const elapsed = performance.now() - start;
  // Consume and check after timing; counters, fixture creation and JSON hashing
  // are excluded. This is a synchronous ProseMirror operation, not DOM latency.
  for (const h of holders) { assert.equal(h.transactions.length, 1); assert.equal(h.value.state.doc.textContent, doc.textContent); }
  return elapsed;
}
function behaviorFixtures() {
  const textCases: [string, string[]][] = [
    ['abab', ['aba', 'bab']], ['aaaaa', ['aa']], ['A+B .* [x] \\', ['A+B', '.*', '[x]', '\\']],
    ['中😀e\u0301😀', ['😀', 'e\u0301']], ['Alpha ALPHA', ['Alpha']], ['a\nb\u2028c', ['a\nb', '\u2028c']],
    ['', ['', ' ']],
  ];
  const cases = textCases.map(([text, names], i) => ({ id: `literal-${i}`, doc: schema.node('doc', null, [paragraph(text)]), target: { ...target, names } }));
  cases.push({ id: 'format-and-existing-targets', target: { ...target, names: ['ab', 'bc', 'cd'] }, doc: schema.node('doc', null, [schema.node('paragraph', null, [
    schema.text('ab', [schema.marks.entityLink.create({ targetKind: 'element', targetId: target.id })]),
    schema.text('cd', [schema.marks.strong.create()]),
    schema.text('ab', [schema.marks.entityLink.create({ targetKind: 'node', targetId: target.id })]),
  ])]) });
  let seed = 20260914;
  const next = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const alphabet = ['a', 'b', '中', '😀', '.', '+', '[', ']', '\\', ' ', '\n'];
  for (let i = 0; i < 64; i++) {
    const text = Array.from({ length: 100 }, () => alphabet[next(alphabet.length)]).join('');
    const names = Array.from({ length: 8 }, () => { const start = next(text.length); return text.slice(start, start + next(8)); });
    cases.push({ id: `seeded-${i}`, doc: schema.node('doc', null, [paragraph(text)]), target: { ...target, names } });
  }
  return cases;
}
async function collect() {
  const baselineSource = execFileSync('git', ['show', `${baselineCommit}:${sourcePath}`], { encoding: 'utf8' });
  const baselineBody = baselineSource.slice(baselineSource.indexOf('function escapeRegExp(text: string): string {'));
  assert.equal(sha(baselineSource), baselineSourceHash); assert.equal(sha(baselineBody), baselineFunctionHash);
  const sourceFingerprint = fingerprint(); const local = '.local-data/renderer-performance'; mkdirSync(local, { recursive: true });
  const temporary = mkdtempSync(path.join(local, 'retroactive-baseline-'));
  try {
    const file = path.resolve(temporary, 'baseline.ts');
    // The function and escape helper are exact historical bytes, not a rewritten
    // reference algorithm. tsx erases their type-only annotations.
    writeFileSync(file, baselineBody);
    const loaded = await import(pathToFileURL(file).href);
    const baseline: Link = loaded.linkEntityInDoc ?? loaded.default?.linkEntityInDoc; assert.equal(typeof baseline, 'function');
    const behavior = behaviorFixtures().map(f => {
      const before = holder(f.doc); const after = holder(f.doc);
      baseline(before.editor, f.target); linkEntityInDoc(after.editor, f.target);
      assert.deepEqual(outcome(after), outcome(before), f.id); const first = after.transactions.length;
      baseline(before.editor, f.target); linkEntityInDoc(after.editor, f.target);
      assert.deepEqual(outcome(after), outcome(before), f.id); assert.equal(after.transactions.length, first, f.id);
      return { id: f.id, passed: true as const };
    });
    const profiles = [];
    for (const characters of [5000, 20000, 50000]) for (const editors of [1, 5, 20]) {
      const doc = schema.node('doc', null, Array.from({ length: characters / 100 }, (_, i) => paragraph(`合成别名${i % 8} ` + '文'.repeat(94))));
      assert.equal(doc.textContent.length, characters);
      const old = measureCounters(baseline, doc, editors); const current = measureCounters(linkEntityInDoc, doc, editors);
      assert.equal(current.resultHash, old.resultHash);
      time(baseline, doc, editors); time(linkEntityInDoc, doc, editors);
      const oldSamples: number[] = []; const newSamples: number[] = [];
      for (let i = 0; i < 5; i++) {
        if (i % 2) { newSamples.push(time(linkEntityInDoc, doc, editors)); oldSamples.push(time(baseline, doc, editors)); }
        else { oldSamples.push(time(baseline, doc, editors)); newSamples.push(time(linkEntityInDoc, doc, editors)); }
      }
      const summary = (samplesMs: number[]) => ({ samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[2] });
      profiles.push({ characters, editors, aliases: 8, warmups: 1, fixtureHash: sha(JSON.stringify(doc.toJSON())), baseline: { ...old, ...summary(oldSamples) }, current: { ...current, ...summary(newSamples) } });
    }
    assert.equal(fingerprint(), sourceFingerprint, 'source changed while measuring');
    return { schemaVersion: 1, kind: 'retroactive_entity_link_comparison', status: 'measured', generatedAt: new Date().toISOString(),
      source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fingerprint: sourceFingerprint, baselineCommit, baselineSourceHash: sha(baselineSource), baselineFunctionHash: sha(baselineBody) },
      environment: { node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0].model, totalMemoryBytes: os.totalmem() },
      behavior, profiles, nativeAcceptance: false,
      limitations: ['Node with real immutable ProseMirror documents and synthetic editor-state holders; no DOM, native window or physical input.',
        'Exact historical linking function compared with the current implementation; counters are separate from one warmup and five alternating timing samples.',
        'Every sample still scans all matching-project documents and all aliases; no whole-app, device budget, SQLite restart or Yjs durability claim is derived from these timings.'] };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
type Report = Awaited<ReturnType<typeof collect>>;
async function main() {
  if (process.argv.includes('--check')) { validate(JSON.parse(readFileSync(output, 'utf8')), process.argv.includes('--historical')); console.log(process.argv.includes('--historical') ? 'Historical retroactive linking evidence passed; current source was not asserted.' : 'Retroactive linking evidence matches current source; no native acceptance inferred.'); return; }
  const report = await collect(); validate(report); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Retroactive linking report: ${output}`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
