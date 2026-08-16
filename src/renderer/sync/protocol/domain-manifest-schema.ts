import {
  SYNC_DOMAIN_FIELD_CLASSES,
  type SyncDomainTablePolicy,
} from './domain-manifest';

export interface PersistedTableInventory {
  readonly table: string;
  readonly columns: readonly string[];
}

export interface DomainManifestLike {
  readonly tables: readonly SyncDomainTablePolicy[];
}

/**
 * Returns stable, human-readable drift messages instead of throwing so the
 * same validator can power Vitest and checked-in evidence generation.
 */
export function validateDomainManifestAgainstSchema(
  manifest: DomainManifestLike,
  inventory: readonly PersistedTableInventory[],
): readonly string[] {
  const issues: string[] = [];
  const schemaByTable = new Map(inventory.map((entry) => [entry.table, entry]));
  const manifestByTable = new Map<string, SyncDomainTablePolicy>();
  const allowedClasses = new Set<string>(SYNC_DOMAIN_FIELD_CLASSES);

  for (const table of manifest.tables) {
    if (manifestByTable.has(table.table)) {
      issues.push(`duplicate manifest table: ${table.table}`);
      continue;
    }
    manifestByTable.set(table.table, table);
    if (table.reason.trim().length === 0) issues.push(`missing table reason: ${table.table}`);

    const includedFields: string[] = [];
    for (const [column, policy] of Object.entries(table.fields)) {
      if (!allowedClasses.has(policy.classification)) {
        issues.push(`invalid classification: ${table.table}.${column}`);
      }
      if (policy.reason.trim().length === 0) {
        issues.push(`missing field reason: ${table.table}.${column}`);
      }
      if (policy.disposition === 'include') includedFields.push(column);
    }
    if (table.disposition === 'include' && includedFields.length === 0) {
      issues.push(`included table has no included fields: ${table.table}`);
    }
    if (table.disposition === 'exclude' && includedFields.length > 0) {
      issues.push(`excluded table has included fields: ${table.table}.${includedFields.join(',')}`);
    }
  }

  for (const entry of inventory) {
    const policy = manifestByTable.get(entry.table);
    if (!policy) {
      issues.push(`unclassified schema table: ${entry.table}`);
      continue;
    }
    const schemaColumns = new Set(entry.columns);
    const manifestColumns = new Set(Object.keys(policy.fields));
    for (const column of [...schemaColumns].sort()) {
      if (!manifestColumns.has(column)) {
        issues.push(`unclassified schema field: ${entry.table}.${column}`);
      }
    }
    for (const column of [...manifestColumns].sort()) {
      if (!schemaColumns.has(column)) {
        issues.push(`stale manifest field: ${entry.table}.${column}`);
      }
    }
  }

  for (const table of manifestByTable.keys()) {
    if (!schemaByTable.has(table)) issues.push(`stale manifest table: ${table}`);
  }

  return issues.sort();
}
