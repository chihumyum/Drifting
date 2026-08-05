import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { P3FileBackedSqliteGateway } from './p3-file-backed-sqlite';

describe('P3 file-backed SQLite native deferral mode', () => {
  it('holds an independent root query until the active transaction commits', async () => {
    const prefix = path.join(tmpdir(), 'drifting-sqlite-deferral-');
    const directory = await mkdtemp(prefix);
    const gateway = new P3FileBackedSqliteGateway(
      path.join(directory, 'drifting.db'),
      true,
      'runtime',
      { deferRootRequestsDuringTransaction: true },
    );

    try {
      await gateway.open('drifting.db');
      const transaction = await gateway.begin('immediate');
      let settled = false;
      const rootQuery = gateway.query('SELECT 1 AS value').then((result) => {
        settled = true;
        return result;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      await gateway.commit(transaction.id);
      await expect(rootQuery).resolves.toEqual({
        columns: ['value'],
        rows: [[1]],
      });
    } finally {
      await gateway.close();
      if (directory.startsWith(prefix)) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
