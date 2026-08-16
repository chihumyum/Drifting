import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const baselineSql = readFileSync(
  new URL('../../../drizzle/0000_local_first_baseline.sql', import.meta.url),
  'utf8',
);

const SYNC_TABLES = [
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
] as const;

const NOW = '2026-08-15T00:00:00.000Z';
const SHA256 = '0'.repeat(64);
const databases: DatabaseSync[] = [];

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(baselineSql);
  return database;
}

function createProjectAndGeneration(
  database: DatabaseSync,
  suffix: string,
): { projectId: string; syncGenerationId: string; projectSyncId: string } {
  const projectId = `project-${suffix}`;
  const syncGenerationId = `sync-generation-${suffix}`;
  const projectSyncId = `project-sync-${suffix}`;
  database
    .prepare(
      `INSERT INTO project (id, name, user_id, created_at, updated_at)
       VALUES (?, ?, 'local-user', ?, ?)`,
    )
    .run(projectId, projectId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO sync_generation
        (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
         domain_schema_version, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 1, 'active', ?, ?)`,
    )
    .run(syncGenerationId, projectId, projectSyncId, NOW, NOW);
  return { projectId, syncGenerationId, projectSyncId };
}

function activateGoogleDrive(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO sync_connect_attempt
        (attempt_id, authority_generation, kind, target_mode,
         target_account_subject_id, target_credential_secret_ref,
         state, created_at, updated_at)
       VALUES ('connect-google', 1, 'connect', 'google-drive',
               'google-subject', 'secret-ref-google', 'preparing', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `UPDATE sync_app_authority
       SET transition_state = 'connecting',
           target_mode = 'google-drive',
           attempt_id = 'connect-google',
           updated_at = ?
       WHERE id = 'app'`,
    )
    .run(NOW);

  const generations = database
    .prepare("SELECT sync_generation_id FROM sync_generation WHERE status = 'active' ORDER BY sync_generation_id")
    .all() as Array<{ sync_generation_id: string }>;
  for (const { sync_generation_id: syncGenerationId } of generations) {
    const remoteObjectId = `remote-marker-${syncGenerationId}`;
    database
      .prepare(
        `INSERT INTO sync_remote_object
          (id, sync_generation_id, provider_object_id, logical_key_id, object_kind,
           stored_sha256, size_bytes, first_observed_at, last_observed_at)
         VALUES (?, ?, ?, ?, 'snapshot-commit', ?, 1, ?, ?)`,
      )
      .run(
        remoteObjectId,
        syncGenerationId,
        `provider-${syncGenerationId}`,
        `logical-${syncGenerationId}`,
        SHA256,
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO sync_connect_generation_attempt
          (attempt_id, source_sync_generation_id, commit_marker_object_id, state, created_at, updated_at)
         VALUES ('connect-google', ?, ?, 'committed', ?, ?)`,
      )
      .run(syncGenerationId, remoteObjectId, NOW, NOW);
    database
      .prepare(
        `UPDATE sync_connect_generation_attempt
         SET state = 'activated', activation_receipt = ?, activated_at = ?, updated_at = ?
         WHERE attempt_id = 'connect-google' AND source_sync_generation_id = ?`,
      )
      .run(`receipt-${syncGenerationId}`, NOW, NOW, syncGenerationId);
  }
  database
    .prepare(
      `UPDATE sync_connect_attempt
       SET state = 'completed', completed_at = ?, updated_at = ?
       WHERE attempt_id = 'connect-google'`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `UPDATE sync_app_authority
       SET mode = 'google-drive',
           generation = generation + 1,
           transition_state = 'stable',
           target_mode = NULL,
           attempt_id = NULL,
           updated_at = ?
       WHERE id = 'app'`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO sync_provider_account
        (id, singleton_key, authority_id, provider_kind, authority_generation, account_subject_id,
         credential_secret_ref, created_at, updated_at)
       VALUES ('account-google', 1, 'app', 'google-drive', 2, 'google-subject',
               'secret-ref-google', ?, ?)`,
    )
    .run(NOW, NOW);
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('SyncEngine fresh schema', () => {
  it('creates the complete first-class schema without retired hosted cursors', () => {
    const database = createDatabase();
    const tables = (
      database
        .prepare(
          `SELECT name
           FROM sqlite_schema
           WHERE type = 'table' AND name LIKE 'sync_%'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);

    expect(tables).toEqual(SYNC_TABLES);
    expect(
      database
        .prepare(
          `SELECT count(*) AS count
           FROM sqlite_schema
           WHERE type = 'table'
             AND name IN ('local_sync_mutation', 'yjs_sync_cursor')`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(database.prepare('SELECT * FROM sync_app_authority').get()).toEqual({
      id: 'app',
      mode: 'local',
      generation: 1,
      transition_state: 'stable',
      target_mode: null,
      attempt_id: null,
      updated_at: '1970-01-01T00:00:00.000Z',
    });
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const bindingColumns = (
      database.prepare("PRAGMA table_info('sync_provider_binding')").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(bindingColumns).toEqual([
      'sync_generation_id',
      'provider_account_id',
      'provider_namespace',
      'provider_generation_ref',
      'state',
      'connected_at',
      'last_pull_success_at',
      'last_publish_success_at',
      'last_converged_at',
      'updated_at',
    ]);

    const generationColumns = (
      database.prepare("PRAGMA table_info('sync_generation')").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(generationColumns).toEqual([
      'sync_generation_id',
      'project_id',
      'project_sync_id',
      'generation_number',
      'protocol_version',
      'domain_schema_version',
      'status',
      'created_at',
      'updated_at',
      'retired_at',
      'purged_at',
    ]);

    const connectGenerationColumns = (
      database.prepare("PRAGMA table_info('sync_connect_generation_attempt')").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(connectGenerationColumns).toContain('source_sync_generation_id');
    expect(connectGenerationColumns).toContain('target_sync_generation_id');

    const restoreColumns = (
      database.prepare("PRAGMA table_info('sync_restore_attempt')").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(restoreColumns).toContain('source_sync_generation_id');

    const providerAuthorityForeignKey = (
      database.prepare("PRAGMA foreign_key_list('sync_provider_account')").all() as Array<{
        table: string;
        from: string;
        to: string;
      }>
    ).filter(({ table }) => table === 'sync_app_authority');
    expect(providerAuthorityForeignKey.map(({ from, to }) => [from, to])).toEqual([
      ['authority_id', 'id'],
      ['provider_kind', 'mode'],
      ['authority_generation', 'generation'],
    ]);

    const forbiddenSecretColumns = database
      .prepare(
        `SELECT m.name AS table_name, p.name AS column_name
         FROM sqlite_schema AS m, pragma_table_info(m.name) AS p
         WHERE m.type = 'table'
           AND m.name LIKE 'sync_%'
           AND p.name IN (
             'access_token', 'refresh_token', 'sync_generation_key',
             'recovery_root_key', 'resumable_session_uri',
             'key_secret_ref', 'encryption',
             'recovery_revealed_at', 'recovery_confirmed_at'
           )`,
      )
      .all();
    expect(forbiddenSecretColumns).toEqual([]);
  });

  it('enforces one app-wide cloud provider and one binding per sync generation', () => {
    const database = createDatabase();
    const first = createProjectAndGeneration(database, 'first');
    const second = createProjectAndGeneration(database, 'second');

    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_provider_account
            (id, singleton_key, authority_id, provider_kind, authority_generation, account_subject_id,
             credential_secret_ref, created_at, updated_at)
           VALUES ('forbidden-local', 1, 'app', 'google-drive', 1, 'subject',
                   'secret-ref', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/does not match app authority|FOREIGN KEY/u);

    activateGoogleDrive(database);
    for (const { syncGenerationId } of [first, second]) {
      database
        .prepare(
          `INSERT INTO sync_provider_binding
            (sync_generation_id, provider_account_id, provider_namespace, state, updated_at)
           VALUES (?, 'account-google', ?, 'ready', ?)`,
        )
        .run(syncGenerationId, `namespace-${syncGenerationId}`, NOW);
    }

    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_provider_account
            (id, singleton_key, authority_id, provider_kind, authority_generation, account_subject_id,
             credential_secret_ref, created_at, updated_at)
           VALUES ('second-account', 1, 'app', 'google-drive', 2, 'google-subject',
                   'secret-ref-google', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/UNIQUE/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_provider_binding
            (sync_generation_id, provider_account_id, provider_namespace, state, updated_at)
           VALUES (?, 'account-google', 'duplicate', 'ready', ?)`,
        )
        .run(first.syncGenerationId, NOW),
    ).toThrow(/UNIQUE/u);

    database
      .prepare(
        `UPDATE sync_app_authority
         SET transition_state = 'switching', target_mode = 'hosted',
             attempt_id = 'switch-hosted', updated_at = ?
         WHERE id = 'app'`,
      )
      .run(NOW);
    expect(() =>
      database
        .prepare(
          `UPDATE sync_app_authority
           SET mode = 'hosted', generation = generation + 1,
               transition_state = 'stable', target_mode = NULL,
               attempt_id = NULL, updated_at = ?
           WHERE id = 'app'`,
        )
        .run(NOW),
    ).toThrow(/FOREIGN KEY|local sync authority|provider|authority transition/u);
  });

  it('keeps sync generation history and purge receipts after project deletion', () => {
    const database = createDatabase();
    const { projectId, syncGenerationId, projectSyncId } = createProjectAndGeneration(database, 'history');

    database
      .prepare(
        `INSERT INTO sync_change_set
          (change_set_id, sync_generation_id, project_id, project_sync_id, writer_id,
           writer_epoch, device_seq, hlc_wall_ms, hlc_counter,
           protocol_version, payload_version, mutation_count, encoded_bytes,
           payload_sha256, origin, apply_state, created_at)
         VALUES
          ('writer:epoch:1', ?, ?, ?, 'writer', 'epoch', 1, 1, 0,
           1, 1, 1, x'01', ?, 'local', 'applied', ?)`,
      )
      .run(syncGenerationId, projectId, projectSyncId, SHA256, NOW);
    database
      .prepare(
        `INSERT INTO sync_mutation
          (change_set_id, mutation_index, target_family, target_kind,
           target_id, incarnation, action, payload_version, payload_cbor,
           payload_sha256)
         VALUES
          ('writer:epoch:1', 0, 'sync-generation', 'sync-generation', ?, 0, 'sync-generation.purge',
           1, x'02', ?)`,
      )
      .run(syncGenerationId, SHA256);
    database
      .prepare(
        `INSERT INTO sync_apply_receipt
          (change_set_id, sync_generation_id, mutation_count, applied_at)
         VALUES ('writer:epoch:1', ?, 1, ?)`,
      )
      .run(syncGenerationId, NOW);

    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_mutation
            (change_set_id, mutation_index, target_family, target_kind,
             target_id, incarnation, action, payload_version, payload_cbor,
             payload_sha256)
           VALUES
            ('writer:epoch:1', 0, 'sync-generation', 'sync-generation', ?, 0, 'sync-generation.purge',
             1, x'03', ?)`,
        )
        .run(syncGenerationId, SHA256),
    ).toThrow(/UNIQUE/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_change_set
            (change_set_id, sync_generation_id, project_id, project_sync_id, writer_id,
             writer_epoch, device_seq, hlc_wall_ms, hlc_counter,
             protocol_version, payload_version, mutation_count, encoded_bytes,
             payload_sha256, origin, apply_state, created_at)
           VALUES
            ('other-id', ?, ?, ?, 'writer', 'epoch', 1, 2, 0,
             1, 1, 1, x'04', ?, 'local', 'pending', ?)`,
        )
        .run(syncGenerationId, projectId, projectSyncId, SHA256, NOW),
    ).toThrow(/UNIQUE/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_mutation
            (change_set_id, mutation_index, target_family, target_kind,
             target_id, incarnation, action, payload_version, payload_cbor,
             payload_sha256)
           VALUES
            ('writer:epoch:1', 1, 'sync-generation', 'sync-generation', ?, 0, 'sync-generation.purge',
             1, x'05', ?)`,
        )
        .run(syncGenerationId, SHA256),
    ).toThrow(/index exceeds/u);

    database
      .prepare(
        `INSERT INTO sync_change_set
          (change_set_id, sync_generation_id, project_id, project_sync_id, writer_id,
           writer_epoch, device_seq, hlc_wall_ms, hlc_counter,
           protocol_version, payload_version, mutation_count, encoded_bytes,
           payload_sha256, origin, apply_state, created_at)
         VALUES
          ('writer:epoch:2', ?, ?, ?, 'writer', 'epoch', 2, 2, 0,
           1, 1, 2, x'06', ?, 'local', 'pending', ?)`,
      )
      .run(syncGenerationId, projectId, projectSyncId, SHA256, NOW);
    database
      .prepare(
        `INSERT INTO sync_mutation
          (change_set_id, mutation_index, target_family, target_kind,
           target_id, incarnation, action, payload_version, payload_cbor,
           payload_sha256)
         VALUES
          ('writer:epoch:2', 0, 'entity', 'project', ?, 0, 'field.set',
           1, x'07', ?)`,
      )
      .run(projectId, SHA256);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_apply_receipt
            (change_set_id, sync_generation_id, mutation_count, applied_at)
           VALUES ('writer:epoch:2', ?, 2, ?)`,
        )
        .run(syncGenerationId, NOW),
    ).toThrow(/complete change set/u);

    database.prepare('DELETE FROM project WHERE id = ?').run(projectId);
    expect(
      database.prepare('SELECT project_id FROM sync_generation WHERE sync_generation_id = ?').get(syncGenerationId),
    ).toEqual({ project_id: null });
    expect(
      database
        .prepare('SELECT change_set_id FROM sync_apply_receipt WHERE sync_generation_id = ?')
        .get(syncGenerationId),
    ).toEqual({ change_set_id: 'writer:epoch:1' });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
  });

  it('allows unified connect to stage a projectless remote sync generation and rejects invalid staging', () => {
    const database = createDatabase();
    database
      .prepare(
        `INSERT INTO sync_generation
          (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
           domain_schema_version, status, created_at, updated_at)
         VALUES
          ('sync-generation-remote-connect', NULL, 'project-sync-remote-connect', 1, 1, 1,
           'staged', ?, ?),
          ('sync-generation-remote-restore', NULL, 'project-sync-remote-restore', 1, 1, 1,
           'staged', ?, ?),
          ('sync-generation-target', NULL, 'project-sync-target', 1, 1, 1,
           'staged', ?, ?)`,
      )
      .run(NOW, NOW, NOW, NOW, NOW, NOW);
    database
      .prepare(
        `INSERT INTO sync_generation
          (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
           domain_schema_version, status, created_at, updated_at, retired_at)
         VALUES ('sync-generation-retired', NULL, 'project-sync-retired', 1, 1, 1,
                 'retired', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);
    database
      .prepare(
        `INSERT INTO project (id, name, user_id, created_at, updated_at)
         VALUES ('project-local-staged', 'project-local-staged', 'local-user', ?, ?)`,
      )
      .run(NOW, NOW);
    database
      .prepare(
        `INSERT INTO sync_generation
          (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
           domain_schema_version, status, created_at, updated_at)
         VALUES ('sync-generation-local-staged', 'project-local-staged',
                 'project-sync-local-staged', 1, 1, 1, 'staged', ?, ?)`,
      )
      .run(NOW, NOW);

    for (const [attemptId, kind] of [
      ['connect-remote', 'connect'],
      ['restore-remote', 'restore'],
      ['connect-with-target', 'connect'],
      ['connect-local-staged', 'connect'],
      ['connect-retired', 'connect'],
    ] as const) {
      database
        .prepare(
          `INSERT INTO sync_connect_attempt
            (attempt_id, authority_generation, kind, target_mode,
             target_account_subject_id, target_credential_secret_ref,
             state, created_at, updated_at)
           VALUES (?, 1, ?, 'google-drive', 'google-subject', 'secret-ref-google',
                   'discovering', ?, ?)`,
        )
        .run(attemptId, kind, NOW, NOW);
    }

    for (const [attemptId, sourceSyncGenerationId] of [
      ['connect-remote', 'sync-generation-remote-connect'],
      ['restore-remote', 'sync-generation-remote-restore'],
    ] as const) {
      database
        .prepare(
          `INSERT INTO sync_connect_generation_attempt
            (attempt_id, source_sync_generation_id, state, created_at, updated_at)
           VALUES (?, ?, 'restoring', ?, ?)`,
        )
        .run(attemptId, sourceSyncGenerationId, NOW, NOW);
    }

    expect(
      database
        .prepare(
          `SELECT attempt_id, source_sync_generation_id, target_sync_generation_id
           FROM sync_connect_generation_attempt
           ORDER BY attempt_id`,
        )
        .all(),
    ).toEqual([
      {
        attempt_id: 'connect-remote',
        source_sync_generation_id: 'sync-generation-remote-connect',
        target_sync_generation_id: null,
      },
      {
        attempt_id: 'restore-remote',
        source_sync_generation_id: 'sync-generation-remote-restore',
        target_sync_generation_id: null,
      },
    ]);

    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_connect_generation_attempt
            (attempt_id, source_sync_generation_id, target_sync_generation_id,
             state, created_at, updated_at)
           VALUES ('connect-with-target', 'sync-generation-remote-connect',
                   'sync-generation-target', 'restoring', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/invalid sync connect generation staging/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_connect_generation_attempt
            (attempt_id, source_sync_generation_id, state, created_at, updated_at)
           VALUES ('connect-local-staged', 'sync-generation-local-staged',
                   'restoring', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/invalid sync connect generation staging/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_connect_generation_attempt
            (attempt_id, source_sync_generation_id, state, created_at, updated_at)
           VALUES ('connect-retired', 'sync-generation-retired',
                   'restoring', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/invalid sync connect generation staging/u);
  });

  it('claims only the clean-break restore-pending sync generation identity', () => {
    const database = createDatabase();
    database
      .prepare(
        `INSERT INTO sync_generation
          (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
           domain_schema_version, status, created_at, updated_at)
         VALUES
          ('sync-generation-restore-claim', NULL,
           'restore-pending:sync-generation-restore-claim', 1, 1, 1, 'staged', ?, ?),
          ('sync-generation-retired-prefix', NULL,
           'recovery-pending:sync-generation-retired-prefix', 1, 1, 1, 'staged', ?, ?)`,
      )
      .run(NOW, NOW, NOW, NOW);

    database
      .prepare(
        `UPDATE sync_generation
         SET project_sync_id = 'project-sync-claimed', generation_number = 7, updated_at = ?
         WHERE sync_generation_id = 'sync-generation-restore-claim'`,
      )
      .run(NOW);
    expect(
      database
        .prepare(
          `SELECT project_sync_id, generation_number
           FROM sync_generation
           WHERE sync_generation_id = 'sync-generation-restore-claim'`,
        )
        .get(),
    ).toEqual({ project_sync_id: 'project-sync-claimed', generation_number: 7 });

    expect(() =>
      database
        .prepare(
          `UPDATE sync_generation
           SET project_sync_id = 'project-sync-legacy-claim', generation_number = 3, updated_at = ?
           WHERE sync_generation_id = 'sync-generation-retired-prefix'`,
        )
        .run(NOW),
    ).toThrow(/sync generation identity is immutable/u);
    expect(
      database
        .prepare(
          `SELECT project_sync_id, generation_number
           FROM sync_generation
           WHERE sync_generation_id = 'sync-generation-retired-prefix'`,
        )
        .get(),
    ).toEqual({
      project_sync_id: 'recovery-pending:sync-generation-retired-prefix',
      generation_number: 1,
    });
  });

  it('stages and atomically activates every sync generation before a provider switch', () => {
    const database = createDatabase();
    const source = createProjectAndGeneration(database, 'migration');
    activateGoogleDrive(database);

    database
      .prepare(
        `INSERT INTO sync_connect_attempt
          (attempt_id, authority_generation, kind, target_mode,
           target_account_subject_id, target_credential_secret_ref,
           state, created_at, updated_at)
         VALUES ('switch-hosted', 2, 'switch-provider', 'hosted',
                 'hosted-subject', 'secret-ref-hosted', 'preparing', ?, ?)`,
      )
      .run(NOW, NOW);
    database
      .prepare(
        `UPDATE sync_app_authority
         SET transition_state = 'switching', target_mode = 'hosted',
             attempt_id = 'switch-hosted', updated_at = ?
         WHERE id = 'app'`,
      )
      .run(NOW);
    database
      .prepare(
        `INSERT INTO sync_generation
          (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
           domain_schema_version, status, created_at, updated_at)
         VALUES ('sync-generation-migration-v2', ?, ?, 2, 1, 1, 'staged', ?, ?)`,
      )
      .run(source.projectId, source.projectSyncId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO sync_remote_object
          (id, sync_generation_id, provider_object_id, logical_key_id, object_kind,
           stored_sha256, size_bytes, first_observed_at, last_observed_at)
         VALUES ('hosted-marker', 'sync-generation-migration-v2', 'hosted-object',
                 'hosted-logical-key', 'snapshot-commit', ?, 1, ?, ?)`,
      )
      .run(SHA256, NOW, NOW);
    database
      .prepare(
        `INSERT INTO sync_connect_generation_attempt
          (attempt_id, source_sync_generation_id, target_sync_generation_id, commit_marker_object_id,
           state, created_at, updated_at)
         VALUES ('switch-hosted', ?, 'sync-generation-migration-v2', 'hosted-marker',
                 'committed', ?, ?)`,
      )
      .run(source.syncGenerationId, NOW, NOW);

    expect(() =>
      database
        .prepare(
          `UPDATE sync_connect_attempt
           SET state = 'completed', completed_at = ?, updated_at = ?
           WHERE attempt_id = 'switch-hosted'`,
        )
        .run(NOW, NOW),
    ).toThrow(/missing a sync generation activation receipt/u);
    expect(() =>
      database
        .prepare(
          `UPDATE sync_connect_generation_attempt
           SET state = 'activated', activation_receipt = 'too-early',
               activated_at = ?, updated_at = ?
           WHERE attempt_id = 'switch-hosted' AND source_sync_generation_id = ?`,
        )
        .run(NOW, NOW, source.syncGenerationId),
    ).toThrow(/activation is not durable/u);

    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          `UPDATE sync_generation
           SET status = 'retired', retired_at = ?, updated_at = ?
           WHERE sync_generation_id = ?`,
        )
        .run(NOW, NOW, source.syncGenerationId);
      database
        .prepare(
          `UPDATE sync_generation
           SET status = 'active', updated_at = ?
           WHERE sync_generation_id = 'sync-generation-migration-v2'`,
        )
        .run(NOW);
      database
        .prepare(
          `UPDATE sync_connect_generation_attempt
           SET state = 'activated', activation_receipt = 'hosted-receipt',
               activated_at = ?, updated_at = ?
           WHERE attempt_id = 'switch-hosted' AND source_sync_generation_id = ?`,
        )
        .run(NOW, NOW, source.syncGenerationId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database
      .prepare(
        `UPDATE sync_connect_attempt
         SET state = 'completed', completed_at = ?, updated_at = ?
         WHERE attempt_id = 'switch-hosted'`,
      )
      .run(NOW, NOW);

    expect(() =>
      database
        .prepare(
          `UPDATE sync_app_authority
           SET mode = 'hosted', generation = generation + 1,
               transition_state = 'stable', target_mode = NULL,
               attempt_id = NULL, updated_at = ?
           WHERE id = 'app'`,
        )
        .run(NOW),
    ).toThrow(/FOREIGN KEY/u);
    database.prepare("DELETE FROM sync_provider_account WHERE id = 'account-google'").run();
    database
      .prepare(
        `UPDATE sync_app_authority
         SET mode = 'hosted', generation = generation + 1,
             transition_state = 'stable', target_mode = NULL,
             attempt_id = NULL, updated_at = ?
         WHERE id = 'app'`,
      )
      .run(NOW);
    database
      .prepare(
        `INSERT INTO sync_provider_account
          (id, singleton_key, authority_id, provider_kind, authority_generation,
           account_subject_id, credential_secret_ref, created_at, updated_at)
         VALUES ('account-hosted', 1, 'app', 'hosted', 3, 'hosted-subject',
                 'secret-ref-hosted', ?, ?)`,
      )
      .run(NOW, NOW);

    expect(
      database
        .prepare(
          `SELECT sync_generation_id, status, generation_number
           FROM sync_generation
           WHERE project_sync_id = ?
           ORDER BY generation_number`,
        )
        .all(source.projectSyncId),
    ).toEqual([
      {
        sync_generation_id: source.syncGenerationId,
        status: 'retired',
        generation_number: 1,
      },
      {
        sync_generation_id: 'sync-generation-migration-v2',
        status: 'active',
        generation_number: 2,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT provider_kind, authority_generation
           FROM sync_provider_account`,
        )
        .get(),
    ).toEqual({ provider_kind: 'hosted', authority_generation: 3 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
