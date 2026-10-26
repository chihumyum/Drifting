import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { legacyUrlNoteBodyJson, normalizeLegacyUrlRecord } from '../domain/library-item';
import { withRetiredUrlMaterialAsNote } from '../sync/checkpoint/validate';

const DRIZZLE_DIRECTORY = new URL('../../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const RETIREMENT_MIGRATION = '0011_retire_url_materials';
const NOW = '2026-10-27T00:00:00.000Z';
const SHA256 = 'c'.repeat(64);
// Non-ASCII, quotes and a slash-heavy path: SQLite json_object and
// JSON.stringify must still produce the same bytes.
const URLS = [
  'https://example.com/lighthouse-history',
  'https://例子.测试/路径/灯塔?q="雾"&p=1#第二节',
] as const;
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

/** The previous public schema with url, text and image materials. */
function previousDatabaseWithMaterials(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const tags = journal.entries.map((entry) => entry.tag);
  migrate(database, tags.slice(0, tags.indexOf(RETIREMENT_MIGRATION)));
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
  const insertUrl = database.prepare(
    `INSERT INTO library_item (id, project_id, title, kind, external_url, preview_image_url, notes_json, order_key, created_at, updated_at)
     VALUES (?, 'project-1', ?, 'url', ?, ?, ?, ?, ?, ?)`,
  );
  insertUrl.run('url-1', '灯塔史', URLS[0], 'https://example.com/cover.png', null, 1, NOW, NOW);
  insertUrl.run(
    'url-2',
    '雾',
    URLS[1],
    null,
    JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第二节' }] }] }),
    2,
    NOW,
    NOW,
  );
  database
    .prepare(
      `INSERT INTO library_item (id, project_id, title, kind, body_json, order_key, created_at, updated_at)
       VALUES ('text-1', 'project-1', 'Snippet', 'text', ?, 3, ?, ?)`,
    )
    .run(JSON.stringify({ type: 'doc', content: [] }), NOW, NOW);
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

describe('0011 url material retirement migration', () => {
  it('turns every url material into a note holding its link and keeps everything else', () => {
    const database = previousDatabaseWithMaterials();
    const before = projectionRevision(database);

    migrate(database, [RETIREMENT_MIGRATION]);

    const rows = database
      .prepare(
        `SELECT id, title, kind, asset_id, external_url, preview_image_url, body_json, notes_json, order_key
         FROM library_item ORDER BY order_key`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.id, row.kind])).toEqual([
      ['image-1', 'image'],
      ['url-1', 'text'],
      ['url-2', 'text'],
      ['text-1', 'text'],
    ]);
    expect(rows[1]).toMatchObject({ title: '灯塔史', external_url: null, preview_image_url: null, notes_json: null });
    expect(rows[2]?.notes_json).toContain('第二节');
    // Byte parity with the sync/checkpoint conversion of the same record.
    expect(rows[1]?.body_json).toBe(legacyUrlNoteBodyJson(URLS[0]));
    expect(rows[2]?.body_json).toBe(legacyUrlNoteBodyJson(URLS[1]));
    expect(rows[0]).toMatchObject({ asset_id: 'asset-1', body_json: null });
    expect(rows[3]?.body_json).toBe(JSON.stringify({ type: 'doc', content: [] }));
    expect(projectionRevision(database)).toBeGreaterThan(before);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('refuses new url rows and url kind changes after the migration', () => {
    const database = previousDatabaseWithMaterials();
    migrate(database, [RETIREMENT_MIGRATION]);

    expect(() =>
      database
        .prepare(
          `INSERT INTO library_item (id, project_id, title, kind, external_url, order_key, created_at, updated_at)
           VALUES ('url-3', 'project-1', 'x', 'url', 'https://example.com', 9, ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/url materials are retired/);
    expect(() =>
      database.prepare(`UPDATE library_item SET kind = 'url', body_json = NULL, external_url = 'https://example.com' WHERE id = 'text-1'`).run(),
    ).toThrow(/url materials are retired/);
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'library_item_retired_url_%' ORDER BY name`)
        .all(),
    ).toEqual([{ name: 'library_item_retired_url_insert' }, { name: 'library_item_retired_url_update' }]);
  });

  it('converts url records from sync history and old checkpoints to the same note', () => {
    expect(
      normalizeLegacyUrlRecord({ kind: 'url', externalUrl: URLS[0], bodyJson: null, title: 't' }),
    ).toEqual({ kind: 'text', externalUrl: null, bodyJson: legacyUrlNoteBodyJson(URLS[0]), title: 't' });
    const image = { kind: 'image', externalUrl: null, bodyJson: null };
    expect(normalizeLegacyUrlRecord(image)).toBe(image);

    const checkpointRow = {
      id: 'url-1',
      kind: 'url',
      external_url: URLS[1],
      body_json: null,
      title: '雾',
    };
    expect(withRetiredUrlMaterialAsNote('library_item', checkpointRow)).toEqual({
      ...checkpointRow,
      kind: 'text',
      external_url: null,
      body_json: legacyUrlNoteBodyJson(URLS[1]),
    });
    expect(withRetiredUrlMaterialAsNote('book_node', checkpointRow)).toBe(checkpointRow);
  });
});
