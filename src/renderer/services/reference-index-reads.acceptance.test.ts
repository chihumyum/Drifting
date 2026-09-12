import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { BookNodeTable, InlineMentionTable, NodeContentTable, ProjectTable } from '../schema/drizzle';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { createReferenceIndexRepository } from './reference-index-repository';
import { createReferenceIndexQueue, type ReferenceIndexRunStats } from './reference-index-queue';

const NOW = '2026-09-12T00:00:00.000Z';
const TEXT = 'Synthetic '.repeat(820);
interface Reads { queries: number; rows: number; serializedBytes: number; queryMs: number }
interface Sample { capture: 'full' | 'sources'; reads: Reads; elapsedMs: number; publications: number; stats: Readonly<ReferenceIndexRunStats> }
const results: Array<{ sources: number; charactersPerSource: number; samples: Sample[] }> = [];
const empty = (): Reads => ({ queries: 0, rows: 0, serializedBytes: 0, queryMs: 0 });

afterAll(async () => {
  if (process.env.DRIFTING_REFERENCE_READ_COUNTERS) await writeFile(process.env.DRIFTING_REFERENCE_READ_COUNTERS, JSON.stringify(results));
});

describe('reference index SQLite read scope', () => {
  it.each([64, 1024])('compares full and selected capture after one durable body change among %i sources', async (sources) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-reference-reads-'));
    const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
    const db = gateway.client();
    let reads = empty();
    const query = gateway.query.bind(gateway);
    gateway.query = async (...args) => {
      const start = performance.now();
      const result = await query(...args);
      reads.queryMs += performance.now() - start;
      reads.queries += 1; reads.rows += result.rows.length;
      reads.serializedBytes += Buffer.byteLength(JSON.stringify(result.rows));
      return result;
    };
    let publications = 0;
    const queue = createReferenceIndexQueue({
      isCurrent: () => true,
      createRepository: (isCurrent) => createReferenceIndexRepository({ database: db, projectId: 'synthetic-project', isCurrent }),
      onSnapshot: () => {}, onChanged: () => { publications += 1; }, onError: () => {},
    });
    const doc = new Y.Doc({ gc: false });
    try {
      await db.insert(ProjectTable).values({ id: 'synthetic-project', userId: 'synthetic-user', name: 'Synthetic', createdAt: NOW, updatedAt: NOW });
      const body = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block' }, content: [{ type: 'text', text: TEXT, marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId: 'seed-target' } }] }] }] });
      for (let start = 0; start < sources; start += 32) {
        const ids = Array.from({ length: Math.min(32, sources - start) }, (_, i) => `node-${start + i}`);
        await db.insert(BookNodeTable).values(ids.map((id) => ({ id, projectId: 'synthetic-project', title: 'Synthetic', positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW })));
        await db.insert(NodeContentTable).values(ids.map((nodeId) => ({ nodeId, contentJson: body, outlineJson: '[]', plotGridJson: '{}', createdAt: NOW, updatedAt: NOW })));
      }
      const block = new Y.XmlElement('paragraph'); block.setAttribute('id', 'block');
      const text = new Y.XmlText(); text.insert(0, TEXT, { entityLink: { targetKind: 'element', targetId: 'seed-target' } });
      block.insert(0, [text]); doc.getXmlFragment('default').insert(0, [block]);
      await db.transaction((tx) => createYjsRepository(tx).appendUpdate('node-content:node-0', Y.encodeStateAsUpdate(doc)));
      await queue.flush();
      expect(queue.getSnapshot().lastRun?.written).toBe(sources);
      const samples: Sample[] = [];
      // Warm both paths, then alternate five pairs in one isolated test process.
      for (let iteration = 0; iteration < 6; iteration += 1) for (const capture of ['full', 'sources'] as const) {
        const vector = Y.encodeStateVector(doc);
        const targetId = `changed-${iteration}-${capture}`;
        text.format(0, text.length, { entityLink: { targetKind: 'element', targetId } });
        await db.transaction((tx) => createYjsRepository(tx).appendUpdate('node-content:node-0', Y.encodeStateAsUpdate(doc, vector)));
        reads = empty(); publications = 0;
        const start = performance.now();
        queue.request(false, capture === 'sources' ? [{ kind: 'node', id: 'node-0' }] : undefined);
        await queue.flush();
        const sample: Sample = { capture, reads: { ...reads }, elapsedMs: performance.now() - start, publications, stats: queue.getSnapshot().lastRun! };
        expect(sample.stats).toMatchObject({ capture, written: 1, prepared: 1, stale: false, failedSources: 0 });
        expect(sample.publications).toBe(1);
        expect(queue.getSnapshot().hasError).toBe(false);
        const [row] = await db.select().from(InlineMentionTable).where(eq(InlineMentionTable.fromId, 'node-0'));
        expect(row!.toId).toBe(targetId);
        if (iteration > 0) samples.push(sample);
      }
      const full = samples.filter((sample) => sample.capture === 'full');
      const selected = samples.filter((sample) => sample.capture === 'sources');
      for (const sample of selected) {
        expect(sample.reads.rows).toBeLessThan(50);
        expect(sample.reads.serializedBytes).toBeLessThan(full[0]!.reads.serializedBytes / 8);
        expect(sample.stats.sources).toBe(1);
      }
      expect(full.every((sample) => sample.stats.sources === sources && sample.reads.rows >= sources * 2)).toBe(true);
      expect(await db.select().from(InlineMentionTable)).toHaveLength(sources);
      results.push({ sources, charactersPerSource: TEXT.length, samples });
    } finally {
      queue.dispose(); doc.destroy(); await gateway.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
