import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { BookElementTable } from '../schema/drizzle';
import { captureWorkspaceProjection } from './workspace-projection.service';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from './workspace-projection.test-support';

const results: unknown[] = [];
afterAll(async () => { if (process.env.DRIFTING_ELEMENT_READ_COUNTERS) await writeFile(process.env.DRIFTING_ELEMENT_READ_COUNTERS, JSON.stringify(results)); });
describe('element edit read volume', () => {
  it.each([64, 1024])('measures covered refresh of one body among %i elements against a full oracle', async (entities) => {
    const fixture = await createWorkspaceProjectionFixture(); const { db, gateway } = fixture;
    const empty = () => ({ queries: 0, rows: 0, serializedBytes: 0, elementBodyRows: 0 }); let reads = empty();
    const query = gateway.query.bind(gateway);
    gateway.query = async (...args) => {
      const result = await query(...args); reads.queries++; reads.rows += result.rows.length;
      reads.serializedBytes += Buffer.byteLength(JSON.stringify(result.rows));
      if (/from "element"/i.test(args[0]) && /"content_json"/i.test(args[0])) reads.elementBodyRows += result.rows.length;
      return result;
    };
    try {
      const text = 'Synthetic '.repeat(820);
      const body = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
      await db.transaction(async (tx) => {
        for (let index = 0; index < entities; index++) await tx.insert(BookElementTable).values({ id: `bulk-${index}`, projectId: INPUT.projectId, name: 'Synthetic', contentJson: body, createdAt: NOW, updatedAt: NOW });
      });
      const samples = [];
      for (let iteration = 0; iteration < 6; iteration++) {
        const previous = (await captureWorkspaceProjection(INPUT))!;
        await db.update(BookElementTable).set({ contentJson: body.replace('Synthetic', `Change ${iteration}`), updatedAt: `2027-01-0${iteration + 1}` }).where(eq(BookElementTable.id, 'bulk-0'));
        reads = empty(); const start = performance.now();
        const capture = (await captureWorkspaceProjection({ ...INPUT, previous }))!;
        const sample = { ...reads, captureMs: performance.now() - start };
        expect(capture.mode).toBe('changes');
        expect(capture.data).toEqual((await captureWorkspaceProjection(INPUT))!.data);
        if (iteration > 0) samples.push(sample);
      }
      results.push({ entities, bodyCharacters: text.length, samples });
    } finally { await fixture.close(); }
  });
});
