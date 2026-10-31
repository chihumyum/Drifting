import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const DRIZZLE_DIRECTORY = new URL('../../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const RETIREMENT_MIGRATION = '0014_retire_google_drive_sync';
const NOW = '2026-10-30T00:00:00.000Z';
const SHA256 = '0'.repeat(64);
const databases: DatabaseSync[] = [];

/** Applies journal entries like the native migrator: one transaction, foreign keys off. */
function migrate(database: DatabaseSync, tags: readonly string[]): void {
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const tag of tags) {
      const sql = readFileSync(new URL(`${tag}.sql`, DRIZZLE_DIRECTORY), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (statement.trim()) database.exec(statement);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

/** The previous public schema, where Drive was still a valid provider. */
function previousDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const tags = journal.entries.map((entry) => entry.tag);
  const index = tags.indexOf(RETIREMENT_MIGRATION);
  expect(index).toBeGreaterThan(0);
  migrate(database, tags.slice(0, index));
  return database;
}

function retireDrive(database: DatabaseSync): void {
  migrate(database, [RETIREMENT_MIGRATION]);
}

function insertProject(database: DatabaseSync, suffix: string) {
  const project = {
    projectId: `project-${suffix}`,
    syncGenerationId: `sync-generation-${suffix}`,
    projectSyncId: `project-sync-${suffix}`,
  };
  database
    .prepare(
      `INSERT INTO project (id, name, user_id, created_at, updated_at)
       VALUES (?, ?, 'local-user', ?, ?)`,
    )
    .run(project.projectId, `Project ${suffix}`, NOW, NOW);
  database
    .prepare(
      `INSERT INTO sync_generation
        (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
         domain_schema_version, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 1, 'active', ?, ?)`,
    )
    .run(project.syncGenerationId, project.projectId, project.projectSyncId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO sync_change_set
        (change_set_id, sync_generation_id, project_id, project_sync_id, writer_id,
         writer_epoch, device_seq, hlc_wall_ms, hlc_counter,
         protocol_version, payload_version, mutation_count, encoded_bytes,
         payload_sha256, origin, apply_state, created_at)
       VALUES (?, ?, ?, ?, 'writer', 'epoch', 1, 1, 0, 1, 1, 1, x'01', ?, 'local', 'applied', ?)`,
    )
    .run(`change-${suffix}`, project.syncGenerationId, project.projectId, project.projectSyncId, SHA256, NOW);
  database
    .prepare(
      `INSERT INTO sync_mutation
        (change_set_id, mutation_index, target_family, target_kind,
         target_id, incarnation, action, payload_version, payload_cbor, payload_sha256)
       VALUES (?, 0, 'entity', 'project', ?, 0, 'field.set', 1, x'02', ?)`,
    )
    .run(`change-${suffix}`, project.projectId, SHA256);
  database
    .prepare(
      `INSERT INTO sync_apply_receipt (change_set_id, sync_generation_id, mutation_count, applied_at)
       VALUES (?, ?, 1, ?)`,
    )
    .run(`change-${suffix}`, project.syncGenerationId, NOW);
  return project;
}

function insertRemoteMarker(database: DatabaseSync, syncGenerationId: string, provider: string): string {
  const id = `${provider}-marker-${syncGenerationId}`;
  database
    .prepare(
      `INSERT INTO sync_remote_object
        (id, sync_generation_id, provider_object_id, logical_key_id, object_kind,
         stored_sha256, size_bytes, first_observed_at, last_observed_at)
       VALUES (?, ?, ?, ?, 'snapshot-commit', ?, 1, ?, ?)`,
    )
    .run(id, syncGenerationId, `${provider}-object-${syncGenerationId}`, `${provider}-key-${syncGenerationId}`, SHA256, NOW, NOW);
  return id;
}

function activeGenerationIds(database: DatabaseSync): string[] {
  return (
    database
      .prepare("SELECT sync_generation_id FROM sync_generation WHERE status = 'active' ORDER BY sync_generation_id")
      .all() as Array<{ sync_generation_id: string }>
  ).map((row) => row.sync_generation_id);
}

/** Completes a local -> cloud connect exactly as the published triggers require. */
function connectCloud(database: DatabaseSync, mode: 'google-drive' | 'hosted'): void {
  const attemptId = `connect-${mode}`;
  const authority = database.prepare('SELECT generation FROM sync_app_authority').get() as { generation: number };
  database
    .prepare(
      `INSERT INTO sync_connect_attempt
        (attempt_id, authority_generation, kind, target_mode,
         target_account_subject_id, target_credential_secret_ref, state, created_at, updated_at)
       VALUES (?, ?, 'connect', ?, ?, ?, 'preparing', ?, ?)`,
    )
    .run(attemptId, authority.generation, mode, `${mode}-subject`, `secret-ref-${mode}`, NOW, NOW);
  database
    .prepare(
      `UPDATE sync_app_authority
       SET transition_state = 'connecting', target_mode = ?, attempt_id = ?, updated_at = ?`,
    )
    .run(mode, attemptId, NOW);
  for (const syncGenerationId of activeGenerationIds(database)) {
    const marker = insertRemoteMarker(database, syncGenerationId, mode);
    database
      .prepare(
        `INSERT INTO sync_connect_generation_attempt
          (attempt_id, source_sync_generation_id, commit_marker_object_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', ?, ?)`,
      )
      .run(attemptId, syncGenerationId, marker, NOW, NOW);
    database
      .prepare(
        `UPDATE sync_connect_generation_attempt
         SET state = 'activated', activation_receipt = ?, activated_at = ?, updated_at = ?
         WHERE attempt_id = ? AND source_sync_generation_id = ?`,
      )
      .run(`receipt-${syncGenerationId}`, NOW, NOW, attemptId, syncGenerationId);
  }
  database
    .prepare(
      `UPDATE sync_connect_attempt SET state = 'completed', completed_at = ?, updated_at = ?
       WHERE attempt_id = ?`,
    )
    .run(NOW, NOW, attemptId);
  database
    .prepare(
      `UPDATE sync_app_authority
       SET mode = ?, generation = generation + 1, transition_state = 'stable',
           target_mode = NULL, attempt_id = NULL, updated_at = ?`,
    )
    .run(mode, NOW);
  database
    .prepare(
      `INSERT INTO sync_provider_account
        (id, singleton_key, authority_id, provider_kind, authority_generation,
         account_subject_id, credential_secret_ref, created_at, updated_at)
       VALUES (?, 1, 'app', ?, ?, ?, ?, ?, ?)`,
    )
    .run(`account-${mode}`, mode, authority.generation + 1, `${mode}-subject`, `secret-ref-${mode}`, NOW, NOW);
  for (const syncGenerationId of activeGenerationIds(database)) {
    database
      .prepare(
        `INSERT INTO sync_provider_binding
          (sync_generation_id, provider_account_id, provider_namespace, provider_generation_ref,
           state, connected_at, updated_at)
         VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
      )
      .run(
        syncGenerationId,
        `account-${mode}`,
        mode === 'google-drive' ? 'appDataFolder' : 'project-v1',
        `${mode}:${syncGenerationId}`,
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO sync_cursor
          (sync_generation_id, provider_epoch, committed_cursor, inventory_complete, updated_at)
         VALUES (?, ?, 'cursor-1', 1, ?)`,
      )
      .run(syncGenerationId, `${mode}-epoch`, NOW);
  }
}

function rows(database: DatabaseSync, table: string, order: string): unknown[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
}

/** Every table the migration may touch plus the local content it must never touch. */
function snapshot(database: DatabaseSync) {
  return {
    authority: rows(database, 'sync_app_authority', 'id'),
    accounts: rows(database, 'sync_provider_account', 'id'),
    bindings: rows(database, 'sync_provider_binding', 'sync_generation_id'),
    cursors: rows(database, 'sync_cursor', 'sync_generation_id'),
    attempts: rows(database, 'sync_connect_attempt', 'attempt_id'),
    generationAttempts: rows(database, 'sync_connect_generation_attempt', 'attempt_id, source_sync_generation_id'),
    ...localContent(database),
  };
}

function localContent(database: DatabaseSync) {
  return {
    projects: rows(database, 'project', 'id'),
    generations: rows(database, 'sync_generation', 'sync_generation_id'),
    changeSets: rows(database, 'sync_change_set', 'change_set_id'),
    mutations: rows(database, 'sync_mutation', 'change_set_id, mutation_index'),
    applyReceipts: rows(database, 'sync_apply_receipt', 'change_set_id'),
    remoteObjects: rows(database, 'sync_remote_object', 'id'),
  };
}

/** Drive objects without local bytes become removed; every other column stays. */
function retiredRemoteObjects(before: unknown[]): unknown[] {
  return (before as Array<Record<string, unknown>>).map((row) =>
    row.provider_object_id && String(row.provider_object_id).startsWith('google-drive-')
      ? { ...row, removed_at: expect.any(String), last_observed_at: expect.any(String) }
      : row,
  );
}

function authority(database: DatabaseSync) {
  return database
    .prepare('SELECT mode, generation, transition_state, target_mode, attempt_id FROM sync_app_authority')
    .get();
}

function expectHealthy(database: DatabaseSync): void {
  expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('0014 Google Drive sync retirement migration', () => {
  it('turns a stable Drive library into a local one and keeps every project, generation and journal row', () => {
    const database = previousDatabase();
    insertProject(database, 'a');
    insertProject(database, 'b');
    connectCloud(database, 'google-drive');
    expect(authority(database)).toMatchObject({ mode: 'google-drive', generation: 2 });
    expect(rows(database, 'sync_provider_binding', 'sync_generation_id')).toHaveLength(2);
    expect(rows(database, 'sync_cursor', 'sync_generation_id')).toHaveLength(2);
    const before = snapshot(database);

    retireDrive(database);

    expect(authority(database)).toEqual({
      mode: 'local',
      generation: 3,
      transition_state: 'stable',
      target_mode: null,
      attempt_id: null,
    });
    expect(rows(database, 'sync_provider_account', 'id')).toEqual([]);
    expect(rows(database, 'sync_provider_binding', 'sync_generation_id')).toEqual([]);
    expect(rows(database, 'sync_cursor', 'sync_generation_id')).toEqual([]);
    expect(localContent(database)).toEqual({
      projects: before.projects,
      generations: before.generations,
      changeSets: before.changeSets,
      mutations: before.mutations,
      applyReceipts: before.applyReceipts,
      remoteObjects: retiredRemoteObjects(before.remoteObjects),
    });
    expect(activeGenerationIds(database)).toEqual(['sync-generation-a', 'sync-generation-b']);
    // The completed Drive connect stays as history.
    expect(rows(database, 'sync_connect_attempt', 'attempt_id')).toEqual(before.attempts);
    expect(rows(database, 'sync_connect_generation_attempt', 'attempt_id, source_sync_generation_id')).toEqual(
      before.generationAttempts,
    );
    expectHealthy(database);
  });

  it.each([
    {
      name: 'Drive -> local disconnect',
      attemptId: 'disconnect-drive',
      kind: 'disconnect',
      targetMode: 'local',
      transitionState: 'blocked',
    },
    {
      name: 'Drive -> Hosted switch',
      attemptId: 'switch-hosted',
      kind: 'switch-provider',
      targetMode: 'hosted',
      transitionState: 'switching',
    },
  ] as const)('finishes an unfinished $name as a stable local library', (transition) => {
    const database = previousDatabase();
    const project = insertProject(database, 'drive');
    connectCloud(database, 'google-drive');
    const cloudTarget = transition.targetMode === 'hosted';
    database
      .prepare(
        `INSERT INTO sync_connect_attempt
          (attempt_id, authority_generation, kind, target_mode,
           target_account_subject_id, target_credential_secret_ref, state, created_at, updated_at)
         VALUES (?, 2, ?, ?, ?, ?, 'preparing', ?, ?)`,
      )
      .run(
        transition.attemptId,
        transition.kind,
        transition.targetMode,
        cloudTarget ? 'hosted-subject' : null,
        cloudTarget ? 'secret-ref-hosted' : null,
        NOW,
        NOW,
      );
    database
      .prepare(
        `UPDATE sync_app_authority
         SET transition_state = ?, target_mode = ?, attempt_id = ?, updated_at = ?`,
      )
      .run(transition.transitionState, transition.targetMode, transition.attemptId, NOW);
    if (cloudTarget) {
      database
        .prepare(
          `INSERT INTO sync_generation
            (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
             domain_schema_version, status, created_at, updated_at)
           VALUES ('sync-generation-hosted-target', ?, ?, 2, 1, 1, 'staged', ?, ?)`,
        )
        .run(project.projectId, project.projectSyncId, NOW, NOW);
    }
    database
      .prepare(
        `INSERT INTO sync_connect_generation_attempt
          (attempt_id, source_sync_generation_id, target_sync_generation_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', ?, ?)`,
      )
      .run(transition.attemptId, project.syncGenerationId, cloudTarget ? 'sync-generation-hosted-target' : null, NOW, NOW);
    const before = localContent(database);

    retireDrive(database);

    expect(authority(database)).toEqual({
      mode: 'local',
      generation: 3,
      transition_state: 'stable',
      target_mode: null,
      attempt_id: null,
    });
    expect(rows(database, 'sync_provider_account', 'id')).toEqual([]);
    expect(rows(database, 'sync_provider_binding', 'sync_generation_id')).toEqual([]);
    expect(rows(database, 'sync_cursor', 'sync_generation_id')).toEqual([]);
    expect(
      database
        .prepare('SELECT state, completed_at IS NOT NULL AS completed FROM sync_connect_attempt WHERE attempt_id = ?')
        .get(transition.attemptId),
    ).toEqual({ state: 'cancelled', completed: 1 });
    expect(
      database
        .prepare('SELECT state FROM sync_connect_generation_attempt WHERE attempt_id = ?')
        .all(transition.attemptId),
    ).toEqual([{ state: 'cancelled' }]);
    expect(
      database
        .prepare('SELECT sync_generation_id, status FROM sync_generation ORDER BY sync_generation_id')
        .all(),
    ).toEqual([
      { sync_generation_id: project.syncGenerationId, status: 'active' },
      ...(cloudTarget ? [{ sync_generation_id: 'sync-generation-hosted-target', status: 'retired' }] : []),
    ]);
    expect(localContent(database)).toMatchObject({
      projects: before.projects,
      changeSets: before.changeSets,
      mutations: before.mutations,
      applyReceipts: before.applyReceipts,
      remoteObjects: retiredRemoteObjects(before.remoteObjects),
    });
    expectHealthy(database);
  });

  it('records Drive objects this device never fetched as removed and cancels their downloads', () => {
    const database = previousDatabase();
    const project = insertProject(database, 'a');
    connectCloud(database, 'google-drive');
    const insertRemote = database.prepare(
      `INSERT INTO sync_remote_object
        (id, sync_generation_id, provider_object_id, logical_key_id, object_kind,
         stored_sha256, size_bytes, first_observed_at, last_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    insertRemote.run('fetched-segment', project.syncGenerationId, 'drive-fetched', 'segment-key', 'segment', SHA256, NOW, NOW);
    insertRemote.run('unfetched-segment', project.syncGenerationId, 'drive-unfetched', 'missing-key', 'segment', SHA256, NOW, NOW);
    insertRemote.run('unfetched-blob', project.syncGenerationId, 'drive-blob', 'blob-key', 'blob', SHA256, NOW, NOW);
    database
      .prepare(
        `INSERT INTO sync_local_object
          (id, sync_generation_id, object_kind, logical_key_id, storage_ref, stored_sha256, size_bytes, codec, state, created_at)
         VALUES ('local-segment', ?, 'segment', 'segment-key', 'syncobj:local-segment', ?, 1, 'opaque', 'verified', ?)`,
      )
      .run(project.syncGenerationId, SHA256, NOW);
    database
      .prepare(
        `INSERT INTO sync_transfer
          (transfer_id, sync_generation_id, direction, object_kind, logical_key_id, remote_object_id,
           expected_stored_sha256, total_bytes, state, attempt_count, last_error_code, next_attempt_at, created_at, updated_at)
         VALUES ('stuck-download', ?, 'download', 'segment', 'missing-key', 'unfetched-segment', ?, 1, 'retry-wait', 3,
                 'REMOTE_OBJECT_MISSING', ?, ?, ?)`,
      )
      .run(project.syncGenerationId, SHA256, NOW, NOW, NOW);
    const removed = () =>
      Object.fromEntries(
        (database.prepare('SELECT id, removed_at FROM sync_remote_object ORDER BY id').all() as Array<{ id: string; removed_at: string | null }>)
          .map((row) => [row.id, row.removed_at !== null]),
      );

    retireDrive(database);

    expect(removed()).toMatchObject({ 'fetched-segment': false, 'unfetched-segment': true, 'unfetched-blob': false });
    expect(database.prepare('SELECT state, next_attempt_at FROM sync_transfer').get()).toEqual({
      state: 'cancelled',
      next_attempt_at: null,
    });
    expectHealthy(database);
  });

  it('cancels an unfinished local -> Drive connect and retires the projectless generation it staged', () => {
    const database = previousDatabase();
    const local = insertProject(database, 'local');
    database
      .prepare(
        `INSERT INTO sync_connect_attempt
          (attempt_id, authority_generation, kind, target_mode,
           target_account_subject_id, target_credential_secret_ref, state, created_at, updated_at)
         VALUES ('connect-drive', 1, 'connect', 'google-drive', 'drive-subject', 'secret-ref-drive',
                 'restoring', ?, ?)`,
      )
      .run(NOW, NOW);
    database
      .prepare(
        `UPDATE sync_app_authority
         SET transition_state = 'blocked', target_mode = 'google-drive',
             attempt_id = 'connect-drive', updated_at = ?`,
      )
      .run(NOW);
    database
      .prepare(
        `INSERT INTO sync_generation
          (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
           domain_schema_version, status, created_at, updated_at)
         VALUES ('sync-generation-remote', NULL, 'restore-pending:sync-generation-remote', 1, 1, 1,
                 'staged', ?, ?)`,
      )
      .run(NOW, NOW);
    const insertChild = database.prepare(
      `INSERT INTO sync_connect_generation_attempt
        (attempt_id, source_sync_generation_id, state, error_code, created_at, updated_at)
       VALUES ('connect-drive', ?, ?, ?, ?, ?)`,
    );
    insertChild.run(local.syncGenerationId, 'publishing', 'OFFLINE', NOW, NOW);
    insertChild.run('sync-generation-remote', 'restoring', null, NOW, NOW);
    const before = localContent(database);

    retireDrive(database);

    expect(authority(database)).toEqual({
      mode: 'local',
      generation: 1,
      transition_state: 'stable',
      target_mode: null,
      attempt_id: null,
    });
    const attempt = database
      .prepare("SELECT state, completed_at FROM sync_connect_attempt WHERE attempt_id = 'connect-drive'")
      .get() as { state: string; completed_at: string | null };
    expect(attempt.state).toBe('cancelled');
    expect(attempt.completed_at).toEqual(expect.any(String));
    expect(
      database
        .prepare(
          `SELECT source_sync_generation_id, state, error_code FROM sync_connect_generation_attempt
           ORDER BY source_sync_generation_id`,
        )
        .all(),
    ).toEqual([
      { source_sync_generation_id: local.syncGenerationId, state: 'cancelled', error_code: null },
      { source_sync_generation_id: 'sync-generation-remote', state: 'cancelled', error_code: null },
    ]);
    const generations = database
      .prepare('SELECT sync_generation_id, project_id, status, retired_at FROM sync_generation ORDER BY sync_generation_id')
      .all() as Array<{ sync_generation_id: string; project_id: string | null; status: string; retired_at: string | null }>;
    expect(generations).toEqual([
      { sync_generation_id: local.syncGenerationId, project_id: local.projectId, status: 'active', retired_at: null },
      {
        sync_generation_id: 'sync-generation-remote',
        project_id: null,
        status: 'retired',
        retired_at: expect.any(String),
      },
    ]);
    expect(localContent(database)).toMatchObject({
      projects: before.projects,
      changeSets: before.changeSets,
      mutations: before.mutations,
      applyReceipts: before.applyReceipts,
    });
    expectHealthy(database);
  });

  it('returns a Hosted library with an unfinished switch to Drive to stable Hosted', () => {
    const database = previousDatabase();
    const project = insertProject(database, 'hosted');
    connectCloud(database, 'hosted');
    database
      .prepare(
        `INSERT INTO sync_connect_attempt
          (attempt_id, authority_generation, kind, target_mode,
           target_account_subject_id, target_credential_secret_ref, state, created_at, updated_at)
         VALUES ('switch-drive', 2, 'switch-provider', 'google-drive', 'drive-subject',
                 'secret-ref-drive', 'publishing-genesis', ?, ?)`,
      )
      .run(NOW, NOW);
    database
      .prepare(
        `UPDATE sync_app_authority
         SET transition_state = 'switching', target_mode = 'google-drive',
             attempt_id = 'switch-drive', updated_at = ?`,
      )
      .run(NOW);
    database
      .prepare(
        `INSERT INTO sync_generation
          (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
           domain_schema_version, status, created_at, updated_at)
         VALUES ('sync-generation-drive-target', ?, ?, 2, 1, 1, 'staged', ?, ?)`,
      )
      .run(project.projectId, project.projectSyncId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO sync_connect_generation_attempt
          (attempt_id, source_sync_generation_id, target_sync_generation_id, state, created_at, updated_at)
         VALUES ('switch-drive', ?, 'sync-generation-drive-target', 'publishing', ?, ?)`,
      )
      .run(project.syncGenerationId, NOW, NOW);
    const before = snapshot(database);

    retireDrive(database);

    expect(authority(database)).toEqual({
      mode: 'hosted',
      generation: 2,
      transition_state: 'stable',
      target_mode: null,
      attempt_id: null,
    });
    expect(rows(database, 'sync_provider_account', 'id')).toEqual(before.accounts);
    expect(rows(database, 'sync_provider_binding', 'sync_generation_id')).toEqual(before.bindings);
    expect(rows(database, 'sync_cursor', 'sync_generation_id')).toEqual(before.cursors);
    expect(
      database
        .prepare(
          `SELECT attempt_id, state, completed_at IS NOT NULL AS completed
           FROM sync_connect_attempt ORDER BY attempt_id`,
        )
        .all(),
    ).toEqual([
      { attempt_id: 'connect-hosted', state: 'completed', completed: 1 },
      { attempt_id: 'switch-drive', state: 'cancelled', completed: 1 },
    ]);
    expect(
      database
        .prepare(
          `SELECT attempt_id, state FROM sync_connect_generation_attempt
           ORDER BY attempt_id, source_sync_generation_id`,
        )
        .all(),
    ).toEqual([
      { attempt_id: 'connect-hosted', state: 'activated' },
      { attempt_id: 'switch-drive', state: 'cancelled' },
    ]);
    expect(
      database
        .prepare('SELECT sync_generation_id, status FROM sync_generation ORDER BY sync_generation_id')
        .all(),
    ).toEqual([
      { sync_generation_id: 'sync-generation-drive-target', status: 'retired' },
      { sync_generation_id: project.syncGenerationId, status: 'active' },
    ]);
    expectHealthy(database);
  });

  it('leaves a library already on Hosted or local untouched', () => {
    const hosted = previousDatabase();
    insertProject(hosted, 'hosted');
    connectCloud(hosted, 'hosted');
    const hostedBefore = snapshot(hosted);
    retireDrive(hosted);
    expect(snapshot(hosted)).toEqual(hostedBefore);
    expectHealthy(hosted);

    const local = previousDatabase();
    insertProject(local, 'local');
    const localBefore = snapshot(local);
    retireDrive(local);
    expect(snapshot(local)).toEqual(localBefore);
    expectHealthy(local);
  });

  it('refuses new Drive authority, account and connect rows after the migration', () => {
    const database = previousDatabase();
    insertProject(database, 'guarded');
    retireDrive(database);

    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_connect_attempt
            (attempt_id, authority_generation, kind, target_mode,
             target_account_subject_id, target_credential_secret_ref, state, created_at, updated_at)
           VALUES ('connect-drive', 1, 'connect', 'google-drive', 'drive-subject', 'secret-ref-drive',
                   'preparing', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/Google Drive sync is retired/u);
    expect(() =>
      database
        .prepare(
          `UPDATE sync_app_authority
           SET transition_state = 'connecting', target_mode = 'google-drive',
               attempt_id = 'connect-drive', updated_at = ?`,
        )
        .run(NOW),
    ).toThrow(/Google Drive sync is retired/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_app_authority
            (id, mode, generation, transition_state, target_mode, attempt_id, updated_at)
           VALUES ('app', 'google-drive', 1, 'stable', NULL, NULL, ?)`,
        )
        .run(NOW),
    ).toThrow(/Google Drive sync is retired/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_provider_account
            (id, singleton_key, authority_id, provider_kind, authority_generation,
             account_subject_id, credential_secret_ref, created_at, updated_at)
           VALUES ('account-drive', 1, 'app', 'google-drive', 1, 'drive-subject', 'secret-ref-drive', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/Google Drive sync is retired/u);

    // Hosted keeps working through the same published triggers.
    connectCloud(database, 'hosted');
    expect(authority(database)).toMatchObject({ mode: 'hosted', generation: 2, transition_state: 'stable' });
    expectHealthy(database);
  });
});
