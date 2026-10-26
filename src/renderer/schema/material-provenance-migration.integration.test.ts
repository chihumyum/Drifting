import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const DRIZZLE_DIRECTORY = new URL('../../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const PROVENANCE_MIGRATION = '0009_material_provenance';
const NOW = '2026-10-26T00:00:00.000Z';
const SHA256 = 'b'.repeat(64);
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

/** A database at the previous public schema with one image and one text material. */
function previousDatabaseWithMaterials(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const tags = journal.entries.map((entry) => entry.tag);
  migrate(database, tags.slice(0, tags.indexOf(PROVENANCE_MIGRATION)));
  database
    .prepare(`INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES ('project-1', 'Migration', 'local-user', ?, ?)`)
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO project_asset (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at)
       VALUES ('asset-1', 'project-1', 'image', 'image/png', 10, ?, 4, 5, ?)`,
    )
    .run(SHA256, NOW);
  database
    .prepare(
      `INSERT INTO library_item (id, project_id, title, kind, asset_id, order_key, created_at, updated_at)
       VALUES ('image-1', 'project-1', 'Portrait', 'image', 'asset-1', 0, ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO library_item (id, project_id, title, kind, order_key, created_at, updated_at)
       VALUES ('text-1', 'project-1', 'Snippet', 'text', 1, ?, ?)`,
    )
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

describe('0009 material provenance migration', () => {
  it('adds a nullable provenance column to existing materials without rebuilding the table', () => {
    const database = previousDatabaseWithMaterials();
    const triggersBefore = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'library_item' ORDER BY name`)
      .all();

    migrate(database, [PROVENANCE_MIGRATION]);

    expect(
      database.prepare(`SELECT id, provenance_json FROM library_item ORDER BY id`).all(),
    ).toEqual([
      { id: 'image-1', provenance_json: null },
      { id: 'text-1', provenance_json: null },
    ]);
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'library_item' ORDER BY name`)
        .all(),
    ).toEqual(triggersBefore);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('accepts versioned JSON only and journals provenance changes for the workspace projection', () => {
    const database = previousDatabaseWithMaterials();
    migrate(database, [PROVENANCE_MIGRATION]);
    const update = database.prepare(`UPDATE library_item SET provenance_json = ? WHERE id = 'image-1'`);

    const before = projectionRevision(database);
    update.run(JSON.stringify({ v: 1, origin: 'element-portrait', elementId: 'e', replacedAt: NOW }));
    expect(projectionRevision(database)).toBe(before + 1);

    for (const invalid of ['not json', '{"origin":"generated"}', '{"v":"1"}', '[]']) {
      expect(() => update.run(invalid)).toThrow(/CHECK constraint failed/);
    }
    update.run(null as unknown as string);
    expect(
      database.prepare(`SELECT provenance_json FROM library_item WHERE id = 'image-1'`).get(),
    ).toEqual({ provenance_json: null });
  });
});
