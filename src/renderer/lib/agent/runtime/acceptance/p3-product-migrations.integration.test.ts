import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from './p3-file-backed-sqlite';

const DRIZZLE_DIRECTORY = new URL('../../../../../../drizzle/', import.meta.url);

describe('product file-backed migration acceptance', () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    directories.clear();
  });

  it('follows the checked-in journal and reopens idempotently', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'drifting-product-migrations-'),
    );
    directories.add(directory);
    const databasePath = path.join(directory, 'drifting.db');
    const journal = JSON.parse(
      readFileSync(
        new URL('meta/_journal.json', DRIZZLE_DIRECTORY),
        'utf8',
      ),
    ) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const latest = journal.entries[journal.entries.length - 1]!;
    const latestBytes = readFileSync(
      new URL(`${latest.tag}.sql`, DRIZZLE_DIRECTORY),
    );

    const first = new ProductFileBackedSqliteGateway(databasePath);
    expect((await first.open('drifting.db')).migrationsApplied).toBe(
      journal.entries.length,
    );
    expect(
      first.database
        .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: journal.entries.length });
    expect(
      first.database
        .prepare(
          'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1',
        )
        .get(),
    ).toEqual({
      hash: createHash('sha256').update(latestBytes).digest('hex'),
      created_at: latest.when,
    });
    expect(
      first.database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('book_node', 'node_content', 'yjs_updates', 'agent_runtime_write_effect', 'entity_snapshot_history', 'entity_relation_type', 'entity_relation_type_endpoint_kind', 'agent_working_memory')",
        )
        .get(),
    ).toEqual({ count: 8 });
    const relationColumns = first.database
      .prepare("PRAGMA table_info('entity_relation')")
      .all() as Array<{ name: string }>;
    expect(relationColumns.map((column) => column.name)).toContain('relation_type_id');
    expect(
      first.database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_user_checkpoint%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    const conversationColumns = first.database
      .prepare("PRAGMA table_info('agent_conversation')")
      .all() as Array<{ name: string }>;
    expect(conversationColumns.map((column) => column.name)).not.toContain('fork_checkpoint_id');
    expect(conversationColumns.map((column) => column.name)).not.toContain(
      'parent_conversation_id',
    );
    const taskStepColumns = first.database
      .prepare("PRAGMA table_info('agent_runtime_task_step')")
      .all() as Array<{ name: string }>;
    expect(taskStepColumns.map((column) => column.name)).toContain('work_kind');
    const workingMemoryColumns = first.database
      .prepare("PRAGMA table_info('agent_working_memory')")
      .all() as Array<{ name: string; pk: number }>;
    expect(workingMemoryColumns.find((column) => column.name === 'project_id')?.pk).toBe(1);
    expect(workingMemoryColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'content_md',
        'revision',
        'approx_tokens',
        'updated_by',
        'last_compacted_at',
        'deleted_at',
      ]),
    );
    await first.close();

    const reopened = new ProductFileBackedSqliteGateway(databasePath);
    expect((await reopened.open('drifting.db')).migrationsApplied).toBe(0);
    expect(
      reopened.database
        .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: journal.entries.length });
    await reopened.close();
  });

  it('backfills legacy relation labels without flipping or deleting their endpoints', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE project (id text PRIMARY KEY NOT NULL);
      CREATE TABLE entity_relation (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        from_kind text NOT NULL,
        from_id text NOT NULL,
        to_kind text NOT NULL,
        to_id text NOT NULL,
        kind text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE TABLE agent_runtime_write_effect (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL,
        session_id text NOT NULL,
        tool_name text NOT NULL,
        arguments_json text NOT NULL,
        phase text NOT NULL
      );
      CREATE TABLE agent_runtime_session (
        id text NOT NULL,
        project_id text NOT NULL,
        PRIMARY KEY (id, project_id)
      );
      CREATE TABLE agent_runtime_entity_write_receipt (
        id text PRIMARY KEY NOT NULL,
        effect_id text NOT NULL,
        command_id text NOT NULL,
        direction text NOT NULL,
        project_id text NOT NULL,
        session_id text NOT NULL,
        tool_name text NOT NULL,
        entity_kind text NOT NULL,
        entity_id text NOT NULL,
        expected_revision text,
        result_revision text,
        preimage_json text,
        preimage_hash text,
        postimage_json text,
        postimage_hash text,
        created_at text NOT NULL
      );
      INSERT INTO project (id) VALUES ('project-1');
      INSERT INTO entity_relation VALUES
        ('relation-a', 'project-1', 'node', 'chapter-z', 'element', 'element-a', 'Knows', '2026-01-01', '2026-01-02'),
        ('relation-b', 'project-1', 'element', 'element-b', 'node', 'chapter-a', 'knows', '2026-01-03', '2026-01-04');
    `);
    const migration = readFileSync(
      new URL('0084_entity_relation_type.sql', DRIZZLE_DIRECTORY),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) database.exec(statement);
    }

    expect(
      database
        .prepare(
          'SELECT id, from_kind, from_id, to_kind, to_id, kind, relation_type_id FROM entity_relation ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'relation-a',
        from_kind: 'node',
        from_id: 'chapter-z',
        to_kind: 'element',
        to_id: 'element-a',
        kind: 'Knows',
        relation_type_id: 'legacy:70726f6a6563742d313a6b6e6f7773',
      },
      {
        id: 'relation-b',
        from_kind: 'element',
        from_id: 'element-b',
        to_kind: 'node',
        to_id: 'chapter-a',
        kind: 'knows',
        relation_type_id: 'legacy:70726f6a6563742d313a6b6e6f7773',
      },
    ]);
    expect(
      database
        .prepare('SELECT name, normalized_name, orientation FROM entity_relation_type')
        .all(),
    ).toEqual([{ name: 'Knows', normalized_name: 'knows', orientation: 'unconfigured' }]);
    expect(
      database
        .prepare('SELECT count(*) AS count FROM entity_relation_type_endpoint_kind')
        .get(),
    ).toEqual({ count: 12 });
    database.close();
  });
});
