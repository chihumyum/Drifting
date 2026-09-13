import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { CommentActionTable, CommentTable } from '../schema/drizzle';
import { captureWorkspaceProjection } from './workspace-projection.service';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from './workspace-projection.test-support';

const results: unknown[] = [];
afterAll(async () => { if (process.env.DRIFTING_COMMENT_READ_COUNTERS) await writeFile(process.env.DRIFTING_COMMENT_READ_COUNTERS, JSON.stringify(results)); });
for (const kind of ['comments', 'actions'] as const) describe(`${kind} edit read volume`, () => {
  it.each([64, 1024])('measures one edit among %i records against a full oracle', async entities => {
    const fixture = await createWorkspaceProjectionFixture(); const { db, gateway } = fixture;
    const empty = () => ({ queries: 0, rows: 0, serializedBytes: 0, payloadRows: 0 }); let reads = empty();
    const tableName = kind === 'comments' ? 'comment' : 'comment_action';
    const query = gateway.query.bind(gateway);
    gateway.query = async (...args) => {
      const result = await query(...args); reads.queries++; reads.rows += result.rows.length;
      reads.serializedBytes += Buffer.byteLength(JSON.stringify(result.rows));
      if (args[0].includes(`from "${tableName}"`) && /"(?:body|payload)_json"/i.test(args[0])) reads.payloadRows += result.rows.length;
      return result;
    };
    try {
      const text = 'Synthetic '.repeat(820);
      const body = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
      await db.transaction(async tx => {
        for (let index = 0; index < entities; index++) {
          const row = { id: `bulk-${index}`, projectId: INPUT.projectId, createdAt: NOW, updatedAt: NOW };
          if (kind === 'comments') await tx.insert(CommentTable).values({ ...row, bodyJson: body, anchorJson: JSON.stringify({ synthetic: text }) });
          else await tx.insert(CommentActionTable).values({ ...row, commentId: 'comment', kind: 'accept_suggestion', payloadJson: body, resultJson: JSON.stringify({ synthetic: text }) });
        }
      });
      const samples = [];
      for (let iteration = 0; iteration < 6; iteration++) {
        const previous = (await captureWorkspaceProjection(INPUT))!;
        const revised = body.replace('Synthetic', `Change ${iteration}`);
        if (kind === 'comments') await db.update(CommentTable).set({ bodyJson: revised }).where(eq(CommentTable.id, 'bulk-0'));
        else await db.update(CommentActionTable).set({ payloadJson: revised }).where(eq(CommentActionTable.id, 'bulk-0'));
        reads = empty(); const start = performance.now();
        const capture = (await captureWorkspaceProjection({ ...INPUT, previous }))!;
        const sample = { ...reads, captureMs: performance.now() - start };
        expect(capture.mode).toBe('changes');
        expect(capture.data).toEqual((await captureWorkspaceProjection(INPUT))!.data);
        // Pin the historical tie order as well as comparing the complete data.
        const key = kind === 'comments' ? 'comments' : 'commentActions';
        const historicalOrder = gateway.database.prepare(`SELECT id FROM "${tableName}" WHERE project_id = ? ORDER BY created_at ASC`).all(INPUT.projectId);
        expect(capture.data[key].map(row => row.id)).toEqual(historicalOrder.map(row => row.id));
        if (iteration > 0) samples.push(sample);
      }
      results.push({ kind, entities, bodyCharacters: text.length, samples });
    } finally { await fixture.close(); }
  });
});
