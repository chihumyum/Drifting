import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_USER_ID } from '../renderer/store/auth';
import { invalidateSqliteReducerStateCache } from '../renderer/sync/reducer/sqlite-materializer';
import { LOCAL_LIBRARY_USER_ID, seedDevelopmentDatabase } from './seed';

const directories: string[] = [];

afterEach(() => {
  invalidateSqliteReducerStateCache();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function count(database: DatabaseSync, sql: string): number {
  return Number((database.prepare(sql).get() as { n: number }).n);
}

describe('development seed', () => {
  it('creates a migrated local library with one journaled project and its entities, once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'drifting-seed-'));
    directories.push(directory);
    // The profile's database directory does not exist yet.
    const databasePath = join(directory, 'databases', 'drifting-library.db');

    const first = await seedDevelopmentDatabase({ databasePath });
    expect(first.seeded).toBe(true);
    expect(LOCAL_LIBRARY_USER_ID).toBe(LOCAL_USER_ID);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare('SELECT id, user_id AS userId FROM project').all()).toEqual([
        { id: first.projectId, userId: LOCAL_USER_ID },
      ]);
      expect(count(database, "SELECT count(*) AS n FROM book_node WHERE kind = 'chapter'")).toBe(3);
      expect(count(database, "SELECT count(*) AS n FROM book_node WHERE kind = 'drift'")).toBe(2);
      expect(count(database, 'SELECT count(*) AS n FROM storylines')).toBe(2);
      expect(count(database, 'SELECT count(*) AS n FROM node_storyline_link')).toBe(4);
      expect(count(database, 'SELECT count(*) AS n FROM element_category')).toBe(2);
      expect(count(database, 'SELECT count(*) AS n FROM element')).toBe(3);
      expect(count(database, 'SELECT count(*) AS n FROM entity_relation')).toBe(4);
      expect(count(database, "SELECT count(*) AS n FROM comment WHERE kind = 'todo'")).toBe(2);
      expect(count(database, 'SELECT count(*) AS n FROM material_folder')).toBe(2);
      expect(count(database, "SELECT count(*) AS n FROM library_item WHERE kind = 'text'")).toBe(3);
      // Every write was an authored change set, and chapter prose is in Yjs.
      expect(count(database, 'SELECT count(*) AS n FROM sync_change_set')).toBeGreaterThanOrEqual(28);
      expect(count(database, 'SELECT count(*) AS n FROM sync_entity_lifecycle')).toBeGreaterThan(20);
      expect(count(database, 'SELECT count(*) AS n FROM yjs_updates')).toBeGreaterThan(0);
    } finally {
      database.close();
    }

    const again = await seedDevelopmentDatabase({ databasePath });
    expect(again).toEqual({ seeded: false, databasePath, projectId: null });
  });
});
