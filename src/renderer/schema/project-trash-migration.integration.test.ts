import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const DRIZZLE_DIRECTORY = new URL('../../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const TRASH_MIGRATION = '0010_project_trash';
const NOW = '2026-10-27T00:00:00.000Z';
const databases: DatabaseSync[] = [];

/** Applies journal entries like the native migrator: one transaction, foreign keys off. */
function migrate(database: DatabaseSync, tags: readonly string[]): void {
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  for (const tag of tags) {
    const sql = readFileSync(new URL(`${tag}.sql`, DRIZZLE_DIRECTORY), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) database.exec(statement);
    }
  }
  database.exec('COMMIT');
  database.exec('PRAGMA foreign_keys = ON');
}

/** A database at the previous public schema with one project. */
function previousDatabaseWithProject(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const tags = journal.entries.map((entry) => entry.tag);
  migrate(database, tags.slice(0, tags.indexOf(TRASH_MIGRATION)));
  database
    .prepare(`INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES ('project-1', 'Migration', 'local-user', ?, ?)`)
    .run(NOW, NOW);
  return database;
}

function projectionRevision(database: DatabaseSync): number {
  const row = database
    .prepare(`SELECT revision FROM workspace_projection_clock WHERE project_id = 'project-1'`)
    .get() as { revision: number } | undefined;
  return row?.revision ?? 0;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('0010 project trash migration', () => {
  it('adds a nullable trash marker to existing projects and keeps every project trigger', () => {
    const database = previousDatabaseWithProject();
    const triggersBefore = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'project' ORDER BY name`)
      .all();

    migrate(database, [TRASH_MIGRATION]);

    expect(database.prepare(`SELECT id, name, deleted_at FROM project`).all()).toEqual([
      { id: 'project-1', name: 'Migration', deleted_at: null },
    ]);
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'project' ORDER BY name`)
        .all(),
    ).toEqual(triggersBefore);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('journals trashing and restoring a project for the workspace projection', () => {
    const database = previousDatabaseWithProject();
    migrate(database, [TRASH_MIGRATION]);
    const update = database.prepare(`UPDATE project SET deleted_at = ? WHERE id = 'project-1'`);

    const before = projectionRevision(database);
    update.run(NOW);
    expect(projectionRevision(database)).toBe(before + 1);
    update.run(null as unknown as string);
    expect(projectionRevision(database)).toBe(before + 2);
  });
});
