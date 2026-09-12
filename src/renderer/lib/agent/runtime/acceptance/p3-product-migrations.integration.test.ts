import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from './p3-file-backed-sqlite';
import { WORKSPACE_PROJECTION_SOURCES } from '../../../../services/workspace-projection-sources';

const DRIZZLE_DIRECTORY = new URL('../../../../../../drizzle/', import.meta.url);
const IMMUTABLE_BASELINE_SHA256 =
  '2ee852a7490b3dfb8fb9095a29d90d8c54c0b2bbfc0d00e0c7567be15f38c1e2';

const APPLICATION_TABLES = [
  'agent_chat_binding',
  'agent_chat_branch',
  'agent_chat_cursor',
  'agent_chat_delivery',
  'agent_chat_object',
  'agent_chat_queue',
  'agent_conversation',
  'agent_mcp_server',
  'agent_memory',
  'agent_permission_grant',
  'agent_runtime_checkpoint',
  'agent_runtime_element_patch_receipt',
  'agent_runtime_entity_write_receipt',
  'agent_runtime_event',
  'agent_runtime_message',
  'agent_runtime_read_observation',
  'agent_runtime_read_receipt',
  'agent_runtime_result_artifact',
  'agent_runtime_result_blob',
  'agent_runtime_session',
  'agent_runtime_task',
  'agent_runtime_task_chapter_manifest',
  'agent_runtime_task_command',
  'agent_runtime_task_constraint',
  'agent_runtime_task_step',
  'agent_runtime_tool_call',
  'agent_runtime_turn',
  'agent_runtime_write_effect',
  'agent_runtime_write_expectation',
  'agent_runtime_write_review',
  'agent_runtime_write_review_block',
  'agent_working_memory',
  'block_section',
  'book_act',
  'book_node',
  'comment',
  'comment_action',
  'drift_group',
  'element',
  'element_category',
  'element_patch',
  'entity_kv_entry',
  'entity_relation',
  'entity_relation_type',
  'entity_relation_type_endpoint_kind',
  'entity_snapshot_history',
  'inline_mention',
  'library_item',
  'node_content',
  'node_storyline_link',
  'plot_grid_cell',
  'plot_grid_column',
  'plot_grid_document',
  'plot_grid_row',
  'project',
  'project_asset',
  'storylines',
  'sync_app_authority',
  'sync_apply_receipt',
  'sync_blob_state',
  'sync_change_set',
  'sync_checkpoint',
  'sync_conflict',
  'sync_connect_attempt',
  'sync_connect_generation_attempt',
  'sync_cursor',
  'sync_entity_lifecycle',
  'sync_field_clock',
  'sync_frontier',
  'sync_frontier_gap',
  'sync_generation',
  'sync_generation_purge',
  'sync_generation_writer_state',
  'sync_local_object',
  'sync_mutation',
  'sync_order_register',
  'sync_provider_account',
  'sync_provider_binding',
  'sync_quarantined_object',
  'sync_remote_object',
  'sync_restore_attempt',
  'sync_segment',
  'sync_set_tag',
  'sync_transfer',
  'timeline_marker',
  'workspace_projection_change',
  'workspace_projection_clock',
  'yjs_document_revision',
  'yjs_document_revision_provenance',
  'yjs_prose_command_receipt',
  'yjs_snapshots',
  'yjs_updates',
] as const;

const APPLICATION_TRIGGERS = [
  'agent_chat_queue_conversation_insert',
  'agent_chat_queue_conversation_update',
  'agent_chat_queue_terminal',
  'element_portrait_asset_binding_insert',
  'element_portrait_asset_binding_update',
  'element_portrait_asset_owner_insert',
  'element_portrait_asset_owner_update',
  'library_item_asset_binding_insert',
  'library_item_asset_binding_update',
  'library_item_asset_owner_insert',
  'library_item_asset_owner_update',
  'project_asset_immutable_update',
  'protect_locked_relation_type_delete',
  'protect_locked_relation_type_endpoint_delete',
  'protect_locked_relation_type_endpoint_insert',
  'protect_locked_relation_type_endpoint_update',
  'protect_locked_relation_type_update',
  'trg_agent_runtime_element_patch_receipt_immutable',
  'trg_agent_runtime_element_patch_receipt_provenance',
  'trg_agent_runtime_entity_write_receipt_immutable',
  'trg_agent_runtime_entity_write_receipt_provenance',
  'trg_agent_runtime_read_observation_immutable',
  'trg_agent_runtime_read_receipt_immutable',
  'trg_agent_runtime_result_artifact_delete_orphan',
  'trg_agent_runtime_result_artifact_immutable',
  'trg_agent_runtime_result_blob_immutable',
  'trg_agent_runtime_session_effect_route_update',
  'trg_agent_runtime_write_effect_authorization_immutable',
  'trg_agent_runtime_write_effect_authorization_insert',
  'trg_agent_runtime_write_effect_route_insert',
  'trg_agent_runtime_write_effect_route_update',
  'trg_agent_runtime_write_expectation_exact_insert',
  'trg_agent_runtime_write_expectation_immutable',
  'trg_sync_app_authority_local_guard',
  'trg_sync_app_authority_transition_guard',
  'trg_sync_apply_receipt_complete_change_set',
  'trg_sync_apply_receipt_immutable_update',
  'trg_sync_apply_receipt_no_delete',
  'trg_sync_change_set_immutable_fields',
  'trg_sync_change_set_no_delete',
  'trg_sync_connect_attempt_completed_immutable',
  'trg_sync_connect_attempt_completed_insert',
  'trg_sync_connect_attempt_completed_update',
  'trg_sync_connect_generation_attempt_activated_immutable',
  'trg_sync_connect_generation_attempt_activation_guard',
  'trg_sync_connect_generation_attempt_identity_guard',
  'trg_sync_connect_generation_attempt_insert_guard',
  'trg_sync_connect_generation_attempt_no_delete',
  'trg_sync_generation_no_delete',
  'trg_sync_generation_project_identity_guard',
  'trg_sync_mutation_immutable_update',
  'trg_sync_mutation_index_bounds',
  'trg_sync_mutation_no_delete',
  'trg_sync_provider_account_authority_insert',
  'trg_sync_provider_account_authority_update',
  'trg_sync_provider_binding_authority_insert',
  'trg_sync_provider_binding_authority_update',
] as const;

function applicationObjectNames(
  database: DatabaseSync,
  type: 'table' | 'trigger',
): string[] {
  return (
    database
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = ?
           AND name NOT LIKE 'sqlite_%'
           AND name <> '__drizzle_migrations'
         ORDER BY name`,
      )
      .all(type) as Array<{ name: string }>
  ).map(({ name }) => name);
}

describe('product file-backed migration acceptance', () => {
  const directories = new Set<string>();

  async function createDatabasePath(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    directories.add(directory);
    return path.join(directory, 'drifting.db');
  }

  afterEach(async () => {
    await Promise.all(
      [...directories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    directories.clear();
  });

  it('creates the exact current baseline and reopens idempotently', async () => {
    const target = await createDatabasePath('drifting-product-baseline-');
    const journal = JSON.parse(
      readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    expect(journal.entries).toHaveLength(3);
    expect(journal.entries[2]?.tag).toBe('0002_workspace_projection_journal');
    expect(journal.entries[1]?.tag).toBe('0001_agent_chat_sync');
    expect(journal.entries[0]?.idx).toBe(0);
    expect(journal.entries[0]?.tag).toBe('0000_local_first_baseline');
    const baselineBytes = readFileSync(
      new URL('0000_local_first_baseline.sql', DRIZZLE_DIRECTORY),
    );
    expect(createHash('sha256').update(baselineBytes).digest('hex')).toBe(
      IMMUTABLE_BASELINE_SHA256,
    );

    expect(createHash('sha256').update(readFileSync(new URL('0001_agent_chat_sync.sql', DRIZZLE_DIRECTORY))).digest('hex'))
      .toBe('b188d6c3c38c0af7662d7516593c767bba26df67a100d9ecf7be93048246b9b0');

    const first = new ProductFileBackedSqliteGateway(target);
    expect((await first.open('drifting.db')).migrationsApplied).toBe(journal.entries.length);
    expect(
      first.database
        .prepare('SELECT hash, created_at FROM __drizzle_migrations')
        .get(),
    ).toEqual({
      hash: createHash('sha256').update(baselineBytes).digest('hex'),
      created_at: journal.entries[0]!.when,
    });
    expect(applicationObjectNames(first.database, 'table')).toEqual(
      APPLICATION_TABLES,
    );
    expect(applicationObjectNames(first.database, 'trigger')).toEqual(
      [...APPLICATION_TRIGGERS, ...[...WORKSPACE_PROJECTION_SOURCES.map(({ table }) => table), 'sync_generation']
        .flatMap((table) => ['insert', 'update', 'delete'].map((action) => `workspace_projection_${table}_${action}`))].sort(),
    );
    expect(
      first.database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
        )
        .get(),
    ).toEqual({ count: 195 });
    expect(first.database.prepare('PRAGMA integrity_check').all()).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(first.database.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );
    expect(first.database.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });

    for (const [table, from] of [
      ['element', 'portrait_asset_id'],
      ['library_item', 'asset_id'],
    ] as const) {
      const foreignKey = (
        first.database.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
          from: string;
          on_delete: string;
        }>
      ).find((candidate) => candidate.from === from);
      expect(foreignKey?.on_delete).toBe('NO ACTION');
    }
    await first.close();

    const reopened = new ProductFileBackedSqliteGateway(target);
    expect((await reopened.open('drifting.db')).migrationsApplied).toBe(0);
    expect(applicationObjectNames(reopened.database, 'table')).toEqual(
      APPLICATION_TABLES,
    );
    await reopened.close();
  });

  it('preserves continuous chapter coordinates in integer-affinity baseline columns', async () => {
    const target = await createDatabasePath('drifting-product-continuous-order-');
    const gateway = new ProductFileBackedSqliteGateway(target);
    const database = gateway.database;
    database
      .prepare(
        `INSERT INTO project
          (id, name, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('project-1', 'Project', 'local', '2026-08-18', '2026-08-18');

    const insertChapter = database.prepare(
      `INSERT INTO book_node
        (id, title, book_order, narrative_order, project_id, kind,
         created_at, updated_at, position_x, position_y)
       VALUES (?, ?, ?, ?, ?, 'chapter', ?, ?, 0, 0)`,
    );
    insertChapter.run(
      'chapter-a',
      'Chapter A',
      12.375,
      -4.125,
      'project-1',
      '2026-08-18',
      '2026-08-18',
    );
    insertChapter.run(
      'chapter-b',
      'Chapter B',
      12.5,
      -4.25,
      'project-1',
      '2026-08-18',
      '2026-08-18',
    );

    expect(
      database
        .prepare(
          `SELECT id, book_order, narrative_order,
                  typeof(book_order) AS book_storage,
                  typeof(narrative_order) AS narrative_storage
           FROM book_node
           ORDER BY book_order, id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'chapter-a',
        book_order: 12.375,
        narrative_order: -4.125,
        book_storage: 'real',
        narrative_storage: 'real',
      },
      {
        id: 'chapter-b',
        book_order: 12.5,
        narrative_order: -4.25,
        book_storage: 'real',
        narrative_storage: 'real',
      },
    ]);
    expect(
      database
        .prepare('SELECT id FROM book_node ORDER BY narrative_order, id')
        .all(),
    ).toEqual([{ id: 'chapter-b' }, { id: 'chapter-a' }]);
    await gateway.close();
  });

  it('enforces immutable, single-owner assets while preserving project cascade', async () => {
    const target = await createDatabasePath('drifting-product-assets-');
    const gateway = new ProductFileBackedSqliteGateway(target);
    const database = gateway.database;
    database
      .prepare(
        `INSERT INTO project
          (id, name, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('project-1', 'Project', 'local', '2026-08-15', '2026-08-15');
    database
      .prepare(
        `INSERT INTO project_asset
          (id, project_id, kind, source_mime, source_size_bytes, source_sha256, width, height, created_at)
         VALUES (?, ?, 'image', 'image/png', 10, ?, 10, 10, ?)`,
      )
      .run('asset-1', 'project-1', 'a'.repeat(64), '2026-08-15');

    expect(() =>
      database
        .prepare('UPDATE project_asset SET source_size_bytes = 11 WHERE id = ?')
        .run('asset-1'),
    ).toThrow(/metadata is immutable/u);
    database
      .prepare(
        `INSERT INTO element
          (id, project_id, name, created_at, updated_at, portrait_asset_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'element-1',
        'project-1',
        'Element',
        '2026-08-15',
        '2026-08-15',
        'asset-1',
      );
    expect(() =>
      database
        .prepare(
          `INSERT INTO element
            (id, project_id, name, created_at, updated_at, portrait_asset_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'element-2',
          'project-1',
          'Element 2',
          '2026-08-15',
          '2026-08-15',
          'asset-1',
        ),
    ).toThrow(/UNIQUE constraint failed/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO library_item
            (id, project_id, title, kind, asset_id, created_at, updated_at)
           VALUES (?, ?, ?, 'image', ?, ?, ?)`,
        )
        .run(
          'library-1',
          'project-1',
          'Image',
          'asset-1',
          '2026-08-15',
          '2026-08-15',
        ),
    ).toThrow(/already has an owner/u);
    expect(() =>
      database.prepare('DELETE FROM project_asset WHERE id = ?').run('asset-1'),
    ).toThrow(/FOREIGN KEY constraint failed/u);

    database.prepare('DELETE FROM project WHERE id = ?').run('project-1');
    expect(
      database
        .prepare(
          'SELECT (SELECT count(*) FROM project_asset) AS assets, (SELECT count(*) FROM element) AS elements',
        )
        .get(),
    ).toEqual({ assets: 0, elements: 0 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    await gateway.close();
  });

  it('fails closed when an applied baseline hash is tampered', async () => {
    const target = await createDatabasePath('drifting-product-hash-drift-');
    const first = new ProductFileBackedSqliteGateway(target);
    await first.close();
    const raw = new DatabaseSync(target);
    raw.prepare("UPDATE __drizzle_migrations SET hash = 'tampered'").run();
    raw.close();

    expect(() => new ProductFileBackedSqliteGateway(target)).toThrow(
      /reset this pre-release local database/u,
    );
  });

  it('fails closed when application tables have no current baseline history', async () => {
    const target = await createDatabasePath('drifting-product-untracked-schema-');
    const raw = new DatabaseSync(target);
    raw.exec('CREATE TABLE legacy_product_data (id text PRIMARY KEY)');
    raw.close();

    expect(() => new ProductFileBackedSqliteGateway(target)).toThrow(
      /application tables exist without the current migration baseline/u,
    );
  });

  it('refuses a database created by a newer migration journal', async () => {
    const target = await createDatabasePath('drifting-product-future-schema-');
    const first = new ProductFileBackedSqliteGateway(target);
    await first.close();
    const raw = new DatabaseSync(target);
    raw
      .prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      )
      .run('future-hash', Number.MAX_SAFE_INTEGER);
    raw.close();

    expect(() => new ProductFileBackedSqliteGateway(target)).toThrow(
      /schema is newer than this checkout/u,
    );
  });
});
