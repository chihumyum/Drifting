import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { BookElementTable, BookNodeTable } from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { captureWorkspaceProjection } from './workspace-projection.service';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from './workspace-projection.test-support';

interface Reads { queries: number; rows: number; serializedBytes: number; queryAwaitMs: number }
interface ReadSample { mode: 'full' | 'changes'; reads: Reads; captureMs: number; publicationMs: number; publications: number; nodeRead: string }
interface WriteSample { tracking: boolean; updates: number; executeMs: number; transactionMs: number }
const results: Array<{ entitiesPerKind: number; bodyCharacters: number; reads: ReadSample[]; writes: WriteSample[] }> = [];
const empty = (): Reads => ({ queries: 0, rows: 0, serializedBytes: 0, queryAwaitMs: 0 });
const TEXT = 'Synthetic '.repeat(820);
afterAll(async () => { if (process.env.DRIFTING_WORKSPACE_READ_COUNTERS) await writeFile(process.env.DRIFTING_WORKSPACE_READ_COUNTERS, JSON.stringify(results)); });

describe('workspace SQLite read scope and invalidation write cost', () => {
  it.each([64, 1024])('measures full versus row-scoped capture with %i nodes and prose-bearing elements', async (entities) => {
    const fixture = await createWorkspaceProjectionFixture();
    const { db, gateway } = fixture;
    let reads = empty();
    const query = gateway.query.bind(gateway);
    gateway.query = async (...args) => {
      const start = performance.now(); const result = await query(...args);
      reads.queryAwaitMs += performance.now() - start;
      reads.queries += 1; reads.rows += result.rows.length;
      reads.serializedBytes += Buffer.byteLength(JSON.stringify(result.rows));
      return result;
    };
    let executeMs = 0;
    const execute = gateway.execute.bind(gateway);
    gateway.execute = async (...args) => { const start = performance.now(); const result = await execute(...args); executeMs += performance.now() - start; return result; };
    try {
      const body = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: TEXT }] }] });
      await db.transaction(async (tx) => {
        for (let start = 0; start < entities; start += 32) {
          const ids = Array.from({ length: Math.min(32, entities - start) }, (_, index) => start + index);
          await tx.insert(BookNodeTable).values(ids.map((id) => ({ id: `bulk-node-${id}`, projectId: INPUT.projectId, title: `Synthetic ${id}`, kind: 'chapter', bookOrder: id + 2, positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW })));
          await tx.insert(BookElementTable).values(ids.map((id) => ({ id: `bulk-element-${id}`, projectId: INPUT.projectId, name: `Synthetic ${id}`, contentJson: body, createdAt: NOW, updatedAt: NOW })));
        }
      });
      const samples: ReadSample[] = [];
      // One warm pair, then five alternating pairs, in this isolated process.
      for (let iteration = 0; iteration < 6; iteration += 1) for (const mode of ['full', 'changes'] as const) {
        const before = (await captureWorkspaceProjection(INPUT))!;
        const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
        useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, before.data, undefined, before.coverage?.epoch ?? null);
        await db.update(BookNodeTable).set({ title: `Changed ${iteration} ${mode}` }).where(eq(BookNodeTable.id, 'chapter'));
        const refreshEpoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'refreshing');
        const base = useDataStore.getState();
        reads = empty();
        const start = performance.now();
        const capture = (await captureWorkspaceProjection({ ...INPUT, previous: mode === 'changes' ? before : undefined }))!;
        const captureMs = performance.now() - start;
        let publications = 0;
        const unsubscribe = useDataStore.subscribe((next, previous) => { if (next.bookNodes !== previous.bookNodes) publications += 1; });
        const publishStart = performance.now();
        const accepted = useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, refreshEpoch, capture.data, base, capture.coverage?.epoch ?? null);
        const publicationMs = performance.now() - publishStart;
        unsubscribe();
        const sample = { mode, reads: { ...reads }, captureMs, publicationMs, publications, nodeRead: capture.nodeRead };
        expect(accepted).toBe(true); expect(publications).toBe(1); expect(capture.mode).toBe(mode);
        expect(capture.nodeRead).toBe(mode === 'changes' ? 'changed' : 'all');
        expect(capture.data).toEqual((await captureWorkspaceProjection(INPUT))!.data);
        if (iteration > 0) samples.push(sample);
      }
      const full = samples.filter((sample) => sample.mode === 'full');
      const changed = samples.filter((sample) => sample.mode === 'changes');
      expect(changed.every((sample) => sample.reads.rows === 4 && sample.reads.queries === 4)).toBe(true);
      expect(full.every((sample) => sample.reads.rows > entities * 2)).toBe(true);
      expect(changed.every((sample) => sample.reads.serializedBytes < full[0]!.reads.serializedBytes / 8)).toBe(true);

      // Control intervention is confined to this disposable fixture. Restore
      // exactly the saved trigger SQL between modes; product code has no toggle.
      const triggers = gateway.database.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'workspace_projection_book_node_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
      expect(triggers).toHaveLength(3);
      const writes: WriteSample[] = [];
      for (let iteration = 0; iteration < 6; iteration += 1) for (const tracking of [true, false]) {
        for (const trigger of triggers) gateway.database.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
        if (tracking) for (const trigger of triggers) gateway.database.exec(trigger.sql);
        executeMs = 0;
        const start = performance.now();
        await db.transaction(async (tx) => {
          for (let index = 0; index < 200; index += 1) {
            await tx.update(BookNodeTable).set({ title: `Write ${iteration} ${tracking} ${index}` }).where(eq(BookNodeTable.id, 'chapter'));
          }
        });
        const sample = { tracking, updates: 200, executeMs, transactionMs: performance.now() - start };
        if (iteration > 0) writes.push(sample);
      }
      for (const trigger of triggers) gateway.database.exec(trigger.sql);
      expect(gateway.database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      results.push({ entitiesPerKind: entities, bodyCharacters: TEXT.length, reads: samples, writes });
    } finally { await fixture.close(); }
  });
});
