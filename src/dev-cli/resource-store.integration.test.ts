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

describe('generic resource domain guards', () => {
  it('preserves act opener and drift-group reparent invariants with sync evidence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-resource-cli-'));
    directories.push(directory);
    const product = new OfflineProductDatabase(path.join(directory, 'fixture.db'), {
      migrate: true,
    });
    await product.open();
    try {
      executeResourceOperation({
        database: product.gateway.database,
        model: 'project',
        operation: 'create',
        projectId: 'project-1',
        values: {
          userId: 'user-1',
          name: 'CLI Resource Book',
          summary: '',
          kvJson: '[]',
          storylineTemplateKvJson: '[]',
        },
      });
      executeResourceOperation({
        database: product.gateway.database,
        model: 'book_act',
        operation: 'create',
        projectId: 'project-1',
        values: {
          id: 'act-opener',
          name: '第一幕',
          startOrder: null,
          color: null,
          driftNodeId: null,
        },
      });
      executeResourceOperation({
        database: product.gateway.database,
        model: 'book_act',
        operation: 'create',
        projectId: 'project-1',
        values: { id: 'act-two', name: '第二幕', startOrder: 100, color: null, driftNodeId: null },
      });
      executeResourceOperation({
        database: product.gateway.database,
        model: 'book_act',
        operation: 'delete',
        projectId: 'project-1',
        values: { id: 'act-opener' },
      });
      const promoted = product.gateway.database
        .prepare('SELECT start_order FROM book_act WHERE id = ?')
        .get('act-two') as { start_order: unknown };
      expect(promoted.start_order).toBeNull();

      executeResourceOperation({
        database: product.gateway.database,
        model: 'drift_group',
        operation: 'create',
        projectId: 'project-1',
        values: {
          id: 'group-parent',
          name: '父分组',
          parentGroupId: null,
          color: null,
          sortOrder: null,
        },
      });
      executeResourceOperation({
        database: product.gateway.database,
        model: 'drift_group',
        operation: 'create',
        projectId: 'project-1',
        values: {
          id: 'group-child',
          name: '子分组',
          parentGroupId: 'group-parent',
          color: null,
          sortOrder: null,
        },
      });
      executeResourceOperation({
        database: product.gateway.database,
        model: 'drift_group',
        operation: 'delete',
        projectId: 'project-1',
        values: { id: 'group-parent' },
      });
      const child = product.gateway.database
        .prepare('SELECT parent_group_id FROM drift_group WHERE id = ?')
        .get('group-child') as { parent_group_id: unknown };
      expect(child.parent_group_id).toBeNull();
      const outboxCount = product.gateway.database
        .prepare('SELECT count(*) AS count FROM local_sync_mutation')
        .get() as { count: number };
      expect(Number(outboxCount.count)).toBeGreaterThanOrEqual(7);

      expect(() =>
        executeResourceOperation({
          database: product.gateway.database,
          model: 'comment_action',
          operation: 'delete',
          projectId: 'project-1',
          values: { id: 'workflow-evidence' },
        }),
      ).toThrow(/workflow_only; delete is unavailable/u);
    } finally {
      await product.close();
    }
  });
});
