import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OfflineProductDatabase } from './offline-database';
import { executeResourceOperation } from './resource-store';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('generic resource SyncEngine boundary', () => {
  it('keeps inspection available and rejects every unjournaled scalar write', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-resource-cli-'));
    directories.push(directory);
    const product = new OfflineProductDatabase(path.join(directory, 'fixture.db'), {
      migrate: true,
    });
    await product.open();
    try {
      const now = '2026-08-15T00:00:00.000Z';
      product.gateway.database
        .prepare(
          `INSERT INTO project (id, user_id, name, created_at, updated_at)
           VALUES ('project-1', 'local-user', 'Fixture', ?, ?)`,
        )
        .run(now, now);
      product.gateway.database
        .prepare(
          `INSERT INTO book_act
             (id, project_id, name, color, start_order, drift_node_id, created_at, updated_at)
           VALUES ('act-opener', 'project-1', '第一幕', NULL, NULL, NULL, ?, ?)`,
        )
        .run(now, now);

      expect(
        executeResourceOperation({
          database: product.gateway.database,
          model: 'book_act',
          operation: 'list',
          projectId: 'project-1',
          values: {},
        }),
      ).toMatchObject({
        model: 'book_act',
        count: 1,
        items: [{ id: 'act-opener', projectId: 'project-1', name: '第一幕' }],
      });
      expect(
        executeResourceOperation({
          database: product.gateway.database,
          model: 'book_act',
          operation: 'get',
          projectId: 'project-1',
          values: { id: 'act-opener' },
        }),
      ).toMatchObject({ id: 'act-opener', projectId: 'project-1', name: '第一幕' });

      for (const operation of ['create', 'update', 'delete'] as const) {
        expect(() =>
          executeResourceOperation({
            database: product.gateway.database,
            model: 'book_act',
            operation,
            projectId: 'project-1',
            values: { id: 'act-two', name: '第二幕' },
          }),
        ).toThrow(/workflow_only; .* is unavailable/u);
      }
      expect(
        product.gateway.database.prepare('SELECT count(*) AS count FROM book_act').get(),
      ).toEqual({ count: 1 });
      expect(
        product.gateway.database.prepare('SELECT count(*) AS count FROM sync_change_set').get(),
      ).toEqual({ count: 0 });
    } finally {
      await product.close();
    }
  });
});
