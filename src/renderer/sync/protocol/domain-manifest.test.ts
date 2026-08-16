import { execFileSync } from 'node:child_process';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as drizzleSchema from '../../schema/drizzle';
import { SYNC_DOMAIN_MANIFEST_V1, getSyncDomainTablePolicy } from './domain-manifest';
import {
  validateDomainManifestAgainstSchema,
  type PersistedTableInventory,
} from './domain-manifest-schema';

function inspectDrizzleSchema(): readonly PersistedTableInventory[] {
  const inventory: PersistedTableInventory[] = [];
  for (const exportedValue of Object.values(drizzleSchema)) {
    try {
      const table = getTableName(exportedValue as Parameters<typeof getTableName>[0]);
      const columns = Object.values(
        getTableColumns(exportedValue as Parameters<typeof getTableColumns>[0]),
      ).map((column) => column.name);
      inventory.push({ table, columns: columns.sort() });
    } catch {
      // The schema module may export non-table helpers in the future.
    }
  }
  return inventory.sort((left, right) => (left.table < right.table ? -1 : 1));
}

describe('SyncEngine v1 domain manifest', () => {
  it('classifies every persisted table and field in the current Drizzle schema', () => {
    expect(validateDomainManifestAgainstSchema(SYNC_DOMAIN_MANIFEST_V1, inspectDrizzleSchema())).toEqual(
      [],
    );
  });

  it('fails closed when a schema field or table is added without a classification', () => {
    const inventory = inspectDrizzleSchema();
    const withUnknownField = inventory.map((entry) =>
      entry.table === 'project'
        ? { ...entry, columns: [...entry.columns, 'new_unclassified_field'] }
        : entry,
    );
    expect(validateDomainManifestAgainstSchema(SYNC_DOMAIN_MANIFEST_V1, withUnknownField)).toContain(
      'unclassified schema field: project.new_unclassified_field',
    );
    expect(
      validateDomainManifestAgainstSchema(SYNC_DOMAIN_MANIFEST_V1, [
        ...inventory,
        { table: 'new_project_table', columns: ['id', 'project_id'] },
      ]),
    ).toContain('unclassified schema table: new_project_table');
  });

  it('keeps checked-in JSON and Markdown evidence current', () => {
    expect(() =>
      execFileSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['exec', 'tsx', 'scripts/generate-sync-domain-manifest.ts', '--check'],
        { cwd: process.cwd(), stdio: 'pipe' },
      ),
    ).not.toThrow();
  });

  it('locks the v1 include and exclusion boundaries', () => {
    expect(getSyncDomainTablePolicy('agent_memory')?.disposition).toBe('include');
    expect(getSyncDomainTablePolicy('agent_memory')?.fields.body.classification).toBe('authored');
    expect(getSyncDomainTablePolicy('project_asset')?.disposition).toBe('include');
    expect(getSyncDomainTablePolicy('project_asset')?.fields.source_sha256.classification).toBe(
      'authored',
    );
    expect(getSyncDomainTablePolicy('entity_kv_entry')?.disposition).toBe('include');
    expect(getSyncDomainTablePolicy('entity_kv_entry')?.fields.value.classification).toBe(
      'authored',
    );
    expect(getSyncDomainTablePolicy('yjs_updates')?.fields.update_blob.classification).toBe('crdt');
    expect(getSyncDomainTablePolicy('yjs_snapshots')?.fields.state_blob.classification).toBe('crdt');

    for (const table of ['agent_working_memory', 'block_section', 'inline_mention']) {
      expect(getSyncDomainTablePolicy(table)?.disposition).toBe('exclude');
    }
    for (const table of SYNC_DOMAIN_MANIFEST_V1.tables.filter((entry) =>
      entry.table.startsWith('agent_runtime_'),
    )) {
      expect(table.disposition).toBe('exclude');
      expect(Object.values(table.fields).every((field) => field.classification === 'device-local')).toBe(
        true,
      );
    }
    expect(getSyncDomainTablePolicy('book_node')?.fields.word_count.classification).toBe('derived');
    expect(getSyncDomainTablePolicy('node_content')?.fields.outline_json.classification).toBe('derived');
    expect(getSyncDomainTablePolicy('library_item')?.fields.preview_image_url.classification).toBe(
      'derived',
    );
    expect(getSyncDomainTablePolicy('agent_mcp_server')?.fields.secret_env_json.classification).toBe(
      'secret',
    );
    expect(getSyncDomainTablePolicy('sync_change_set')?.fields.encoded_bytes.classification).toBe(
      'transport',
    );
    for (const table of SYNC_DOMAIN_MANIFEST_V1.tables.filter((entry) =>
      entry.table.startsWith('sync_'),
    )) {
      expect(table.disposition).toBe('exclude');
      expect(
        Object.values(table.fields).every(
          (field) => field.classification === 'transport' || field.classification === 'secret',
        ),
      ).toBe(true);
    }
    expect(
      getSyncDomainTablePolicy('sync_provider_account')?.fields.credential_secret_ref.classification,
    ).toBe('secret');
    expect(
      getSyncDomainTablePolicy('sync_provider_account')?.fields.authority_generation.classification,
    ).toBe('transport');
    expect(
      getSyncDomainTablePolicy('sync_connect_attempt')?.fields.target_credential_secret_ref
        .classification,
    ).toBe('secret');
    expect(
      getSyncDomainTablePolicy('sync_connect_generation_attempt')?.fields.activation_receipt
        .classification,
    ).toBe('transport');
    expect(getSyncDomainTablePolicy('sync_generation_purge')?.scope).toBe('project-via-reference');
    expect(
      Object.values(getSyncDomainTablePolicy('sync_generation_purge')?.fields ?? {}).every(
        (field) => field.classification === 'transport',
      ),
    ).toBe(true);
    expect(getSyncDomainTablePolicy('sync_transfer')?.fields.session_secret_ref.classification).toBe(
      'secret',
    );
    expect(getSyncDomainTablePolicy('sync_app_authority')?.scope).toBe('global');
    expect(getSyncDomainTablePolicy('sync_app_authority')?.fields.mode.classification).toBe(
      'transport',
    );
  });
});
