// Real Yjs/session CPU, synthetic documents and an in-memory persistence adapter.
// I/O counters establish work bounds; this is not native SQLite or input latency.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as Y from 'yjs';
import { installHeadlessRendererGlobals } from '../src/dev-cli/headless-globals';
import type { YjsRepository, YjsUpdateRow } from '../src/renderer/sqlite-repo/yjs-repo';
import type { YjsDocumentSessionDependencies } from '../src/renderer/services/yjs-document-session';
async function main() {
installHeadlessRendererGlobals();
const { YjsDocumentSessionRegistry } = await import('../src/renderer/services/yjs-document-session');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/renderer-performance/acceptance/yjs-durability-after.json';
const snapshots = new Map<string, Uint8Array>();
const updates: YjsUpdateRow[] = [];
let nextId = 1;
let counters = { snapshots: 0, snapshotBytes: 0, compactions: 0, tailReads: 0, authoredUpdates: 0 };
for (let index = 0; index < 25; index++) {
  const doc = new Y.Doc();
  const blocks = Array.from({ length: index === 0 ? 100 : 40 }, (_, block) => {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.setAttribute('id', `synthetic-${index}-${block}`);
    paragraph.insert(0, [new Y.XmlText('灯塔与潮汐的合成写作压力样本。'.repeat(32))]);
    return paragraph;
  });
  doc.getXmlFragment('default').insert(0, blocks);
  snapshots.set(`node-content:synthetic-${index}`, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}
const repository = {
  getSnapshot: async (docId: string) => ({ docId, stateBlob: snapshots.get(docId)!, updatedAt: '2026-01-01T00:00:00Z' }),
  listUpdates: async (docId: string, since = 0) => { counters.tailReads++; return updates.filter(row => row.docId === docId && row.id > since); },
  upsertSnapshot: async (docId: string, stateBlob: Uint8Array) => { counters.snapshots++; counters.snapshotBytes += stateBlob.byteLength; snapshots.set(docId, stateBlob.slice()); },
} as YjsRepository;
const dependencies: YjsDocumentSessionDependencies = {
  initDatabase: async () => undefined,
  createRepository: () => repository,
  appendAuthoredUpdate: async (_project, docId, update) => { const id = nextId++; counters.authoredUpdates++; updates.push({ id, docId, updateBlob: update.slice(), createdAt: '2026-01-01T00:00:00Z' }); return { updateId: id }; },
  compactUpdatesAfterSnapshot: async (docId, covered) => { counters.compactions++; let deleted = 0; for (let i = updates.length - 1; i >= 0; i--) if (updates[i]!.docId === docId && updates[i]!.id <= covered) { updates.splice(i, 1); deleted++; } return deleted; },
  captureSnapshotHistory: () => undefined, queueMicrotask,
};
const registry = new YjsDocumentSessionRegistry(dependencies);
const sessions = Array.from(snapshots.keys(), id => registry.get('synthetic-project', id, 'synthetic-author'));
const releases = sessions.map(session => session.retain());
await Promise.all(sessions.map(session => session.waitUntilLoaded()));
async function measure(name: string, run: () => Promise<void>) {
  counters = { snapshots: 0, snapshotBytes: 0, compactions: 0, tailReads: 0, authoredUpdates: 0 };
  globalThis.gc?.(); const start = performance.now(); const cpu = process.cpuUsage();
  await run(); const elapsedMs = performance.now() - start; const used = process.cpuUsage(cpu);
  return { name, elapsedMs, cpuMs: (used.user + used.system) / 1000, ...counters };
}
const idle = await measure('twenty-idle-project-barriers', async () => { for (let i = 0; i < 20; i++) await Promise.all(sessions.map(s => s.flushLocalState())); });
const changed = await measure('one-edited-document-project-barrier', async () => {
  const text = (sessions[0]!.ydoc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
  text.insert(0, 'new authored text ');
  await Promise.all(sessions.map(s => s.flushLocalState()));
});
const repeated = await measure('twenty-barriers-after-save', async () => { for (let i = 0; i < 20; i++) await Promise.all(sessions.map(s => s.flushLocalState())); });
let recovered = 0;
for (const session of sessions) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, snapshots.get(session.docId)!);
  for (const row of updates.filter(row => row.docId === session.docId)) Y.applyUpdate(doc, row.updateBlob);
  assert.equal(doc.getXmlFragment('default').toString(), session.ydoc.getXmlFragment('default').toString()); doc.destroy(); recovered++;
}
const close = await measure('release-twenty-five-sessions', async () => { releases.forEach(release => release()); await Promise.resolve(); await Promise.all(sessions.map(s => s.flushPendingWrites())); });
const source = createHash('sha256').update(readFileSync('src/renderer/services/yjs-document-session.ts')).update(readFileSync(new URL(import.meta.url))).digest('hex');
if (process.argv.includes('--assert-incremental')) { assert.equal(idle.snapshots, 0); assert.equal(changed.snapshots, 1); assert.equal(changed.authoredUpdates, 1); assert.equal(repeated.snapshots, 0); assert.equal(close.snapshots, 0); }
const report = { kind: 'synthetic_yjs_durability_work_bounds', source, documents: 25, recovered, phases: [idle, changed, repeated, close], scope: 'Real Yjs and production YjsDocumentSession; in-memory persistence adapter. Not native I/O, UI latency, undo or release acceptance.' };
mkdirSync(output.slice(0, output.lastIndexOf('/')), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
