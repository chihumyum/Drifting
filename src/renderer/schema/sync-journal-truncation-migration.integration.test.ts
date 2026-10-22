import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const DRIZZLE_DIRECTORY = new URL('../../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const TRUNCATION_MIGRATION = '0008_sync_journal_truncation';
const NOW = '2026-10-21T00:00:00.000Z';
const SHA256 = 'a'.repeat(64);
const DOCUMENT_ID = 'node-content:node-migration';
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

function insert(database: DatabaseSync, sql: string, ...values: (string | number)[]): void {
  database.prepare(sql).run(...values);
}

/** A database at the previous public schema holding one applied remote Yjs change-set. */
function previousDatabaseWithJournal(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const tags = journal.entries.map((entry) => entry.tag);
  migrate(database, tags.slice(0, tags.indexOf(TRUNCATION_MIGRATION)));
  insert(database, `INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES ('project-migration', 'Migration', 'local-user', ?, ?)`, NOW, NOW);
  insert(
    database,
    `INSERT INTO sync_generation
      (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
       domain_schema_version, status, created_at, updated_at)
     VALUES ('generation-migration', 'project-migration', 'project-sync-migration', 1, 1, 1, 'active', ?, ?)`,
    NOW,
    NOW,
  );
  for (const seq of [1, 2]) {
    const id = `writer:epoch:${seq}`;
    insert(
      database,
      `INSERT INTO sync_change_set
        (change_set_id, sync_generation_id, project_id, project_sync_id, writer_id, writer_epoch,
         device_seq, hlc_wall_ms, hlc_counter, mutation_count, encoded_bytes, payload_sha256,
         origin, apply_state, created_at, applied_at)
       VALUES (?, 'generation-migration', 'project-migration', 'project-sync-migration', 'writer', 'epoch',
               ?, ?, 0, 1, X'00', ?, 'remote', 'applied', ?, ?)`,
      id, seq, seq, SHA256, NOW, NOW,
    );
    insert(
      database,
      `INSERT INTO sync_mutation
        (change_set_id, mutation_index, target_family, target_kind, target_id, incarnation, action,
         payload_cbor, payload_sha256)
       VALUES (?, 0, 'yjs', 'prose-document', ?, 0, 'yjs.update', X'a0', ?)`,
      id, DOCUMENT_ID, SHA256,
    );
    insert(
      database,
      `INSERT INTO sync_apply_receipt (change_set_id, sync_generation_id, mutation_count, applied_at)
       VALUES (?, 'generation-migration', 1, ?)`,
      id, NOW,
    );
  }
  insert(database, `INSERT INTO yjs_updates (id, document_id, update_blob, created_at) VALUES (1, ?, X'0000', ?)`, DOCUMENT_ID, NOW);
  insert(database, `INSERT INTO yjs_document_revision (document_id, revision, updated_at) VALUES (?, 1, ?)`, DOCUMENT_ID, NOW);
  insert(
    database,
    `INSERT INTO yjs_document_revision_provenance (document_id, revision, source_kind, created_at) VALUES (?, 1, 'remote', ?)`,
    DOCUMENT_ID,
    NOW,
  );
  insert(
    database,
    `INSERT INTO sync_yjs_materialization_receipt
      (change_set_id, mutation_index, admission_version, original_envelope_sha256, document_id,
       incarnation, event_sha256, update_row_id, document_revision, created_at)
     VALUES ('writer:epoch:1', 0, 1, ?, ?, 0, ?, 1, 1, ?)`,
    SHA256, DOCUMENT_ID, SHA256, NOW,
  );
  return database;
}

function rows(database: DatabaseSync, sql: string): unknown[] {
  return database.prepare(sql).all();
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe(`${TRUNCATION_MIGRATION} migration`, () => {
  it('keeps every Yjs materialization receipt and drops only its mutation foreign key', () => {
    const database = previousDatabaseWithJournal();
    const receipts = rows(database, 'SELECT * FROM sync_yjs_materialization_receipt');
    expect(rows(database, `PRAGMA foreign_key_list('sync_yjs_materialization_receipt')`)).toHaveLength(2);

    migrate(database, [TRUNCATION_MIGRATION]);
    expect(rows(database, 'SELECT * FROM sync_yjs_materialization_receipt')).toEqual(receipts);
    expect(rows(database, `PRAGMA foreign_key_list('sync_yjs_materialization_receipt')`)).toEqual([]);
    expect(rows(database, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(
      rows(
        database,
        `SELECT name FROM sqlite_schema
         WHERE tbl_name IN ('sync_yjs_materialization_receipt', 'sync_journal_truncation') AND type IN ('trigger', 'index')
         ORDER BY name`,
      ).map((row) => (row as { name: string }).name),
    ).toEqual([
      'sqlite_autoindex_sync_journal_truncation_1',
      'sqlite_autoindex_sync_yjs_materialization_receipt_1',
      'sync_yjs_materialization_receipt_immutable_delete',
      'sync_yjs_materialization_receipt_immutable_update',
      'sync_yjs_materialization_receipt_insert_guard',
      'trg_sync_journal_truncation_insert_guard',
      'trg_sync_journal_truncation_monotonic',
      'trg_sync_journal_truncation_no_delete',
      'uniq_sync_yjs_materialization_update',
    ]);
    // The rebuilt receipt still rejects a duplicate and any rewrite.
    expect(() => insert(database, `INSERT INTO sync_yjs_materialization_receipt SELECT * FROM sync_yjs_materialization_receipt`)).toThrow(
      /already exists/,
    );
    expect(() => insert(database, `UPDATE sync_yjs_materialization_receipt SET created_at = 'later'`)).toThrow(/immutable/);
  });

  it('admits journal deletes only at or below a recorded floor with a reducer base', () => {
    const database = previousDatabaseWithJournal();
    migrate(database, [TRUNCATION_MIGRATION]);
    const removeFirst = () => {
      insert(database, `DELETE FROM sync_apply_receipt WHERE change_set_id = 'writer:epoch:1'`);
      insert(database, `DELETE FROM sync_mutation WHERE change_set_id = 'writer:epoch:1'`);
      insert(database, `DELETE FROM sync_change_set WHERE change_set_id = 'writer:epoch:1'`);
    };
    expect(removeFirst).toThrow(/cannot be deleted/);
    const floor = `INSERT INTO sync_journal_truncation
      (sync_generation_id, writer_id, writer_epoch, truncated_through_seq, source_checkpoint_id, updated_at)
      VALUES ('generation-migration', 'writer', 'epoch', 1, 'checkpoint-1', ?)`;
    expect(() => insert(database, floor, NOW)).toThrow(/requires a reducer base/);
    insert(
      database,
      `INSERT INTO sync_reducer_base
        (sync_generation_id, profile_key, payload_version, pages_cbor, source_checkpoint_id, created_at)
       VALUES ('generation-migration', '[]', 2, X'80', 'checkpoint-1', ?)`,
      NOW,
    );
    insert(database, floor, NOW);

    removeFirst();
    expect(rows(database, 'SELECT change_set_id FROM sync_change_set')).toEqual([{ change_set_id: 'writer:epoch:2' }]);
    expect(rows(database, 'SELECT count(*) AS count FROM sync_yjs_materialization_receipt')).toEqual([{ count: 1 }]);
    expect(rows(database, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(() => insert(database, `DELETE FROM sync_mutation WHERE change_set_id = 'writer:epoch:2'`)).toThrow(/cannot be deleted/);
    expect(() => insert(database, `DELETE FROM sync_yjs_materialization_receipt`)).toThrow(/immutable/);
    expect(() => insert(database, `UPDATE sync_journal_truncation SET truncated_through_seq = 0`)).toThrow();
  });

  it('keeps an own change-set inside an open published gap even below the published frontier', () => {
    const database = previousDatabaseWithJournal();
    migrate(database, [TRUNCATION_MIGRATION]);
    for (const seq of [1, 2]) {
      const id = `own:epoch:${seq}`;
      insert(
        database,
        `INSERT INTO sync_change_set
          (change_set_id, sync_generation_id, project_id, project_sync_id, writer_id, writer_epoch,
           device_seq, hlc_wall_ms, hlc_counter, mutation_count, encoded_bytes, payload_sha256,
           origin, apply_state, created_at, applied_at)
         VALUES (?, 'generation-migration', 'project-migration', 'project-sync-migration', 'own', 'epoch',
                 ?, ?, 0, 1, X'00', ?, 'local', 'applied', ?, ?)`,
        id, seq, 10 + seq, SHA256, NOW, NOW,
      );
      insert(
        database,
        `INSERT INTO sync_mutation
          (change_set_id, mutation_index, target_family, target_kind, target_id, incarnation, action,
           payload_cbor, payload_sha256)
         VALUES (?, 0, 'yjs', 'prose-document', ?, 0, 'yjs.update', X'a0', ?)`,
        id, DOCUMENT_ID, SHA256,
      );
      insert(
        database,
        `INSERT INTO sync_apply_receipt (change_set_id, sync_generation_id, mutation_count, applied_at)
         VALUES (?, 'generation-migration', 1, ?)`,
        id, NOW,
      );
    }
    // Segment 2 published while segment 1 still waits for its blobs.
    insert(
      database,
      `INSERT INTO sync_frontier
        (sync_generation_id, writer_id, writer_epoch, received_seq, applied_seq, published_seq, segment_head_sha256, updated_at)
       VALUES ('generation-migration', 'own', 'epoch', 2, 2, 2, ?, ?)`,
      SHA256, NOW,
    );
    insert(
      database,
      `INSERT INTO sync_frontier_gap
        (id, sync_generation_id, writer_id, writer_epoch, lane, first_seq, last_seq, state, observed_at)
       VALUES ('gap-own-1', 'generation-migration', 'own', 'epoch', 'published', 1, 1, 'open', ?)`,
      NOW,
    );
    insert(
      database,
      `INSERT INTO sync_reducer_base
        (sync_generation_id, profile_key, payload_version, pages_cbor, source_checkpoint_id, created_at)
       VALUES ('generation-migration', '[]', 2, X'80', 'checkpoint-1', ?)`,
      NOW,
    );
    insert(
      database,
      `INSERT INTO sync_journal_truncation
        (sync_generation_id, writer_id, writer_epoch, truncated_through_seq, source_checkpoint_id, updated_at)
       VALUES ('generation-migration', 'own', 'epoch', 2, 'checkpoint-1', ?)`,
      NOW,
    );
    const remove = (id: string) => {
      insert(database, `DELETE FROM sync_apply_receipt WHERE change_set_id = ?`, id);
      insert(database, `DELETE FROM sync_mutation WHERE change_set_id = ?`, id);
      insert(database, `DELETE FROM sync_change_set WHERE change_set_id = ?`, id);
    };
    expect(() => remove('own:epoch:1')).toThrow(/cannot be deleted/);
    remove('own:epoch:2');
    insert(database, `UPDATE sync_frontier_gap SET state = 'resolved', resolved_at = ? WHERE id = 'gap-own-1'`, NOW);
    remove('own:epoch:1');
    expect(rows(database, `SELECT change_set_id FROM sync_change_set WHERE writer_id = 'own'`)).toEqual([]);
  });
});
