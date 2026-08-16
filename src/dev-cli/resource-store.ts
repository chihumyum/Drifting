import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { CliError } from './protocol';
import { resourceCapability } from './manifest';

export type ResourceOperation = 'list' | 'get' | 'create' | 'update' | 'delete';

function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function projectRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [camelCase(key), value])),
  );
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  if (rows.length === 0) {
    throw new CliError('RESOURCE_TABLE_MISSING', `Table ${table} does not exist in this database`);
  }
  return new Set(rows.map((row) => row.name));
}

function scopedWhere(
  columns: Set<string>,
  projectId: string,
  id?: string,
): { sql: string; values: SQLInputValue[] } {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (columns.has('project_id')) {
    clauses.push('project_id = ?');
    values.push(projectId);
  } else if (columns.has('id')) {
    clauses.push('id = ?');
    values.push(projectId);
  }
  if (id !== undefined && columns.has('project_id')) {
    clauses.push('id = ?');
    values.push(id);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
}

function requireProjectResourceIdentity(table: string, projectId: string, id?: string): void {
  if (table === 'project' && id !== undefined && id !== projectId) {
    throw new CliError(
      'CROSS_PROJECT_RESOURCE_REFUSED',
      'The project resource id must equal --project',
    );
  }
}

/**
 * Generic resource access is intentionally read-only during the SyncEngine
 * journal migration. A scalar write that bypasses `runAuthoredTransaction`
 * would create domain state without a change-set, so it fails closed instead
 * of retaining the retired hosted outbox as a second write protocol.
 */
export function executeResourceOperation(input: {
  database: DatabaseSync;
  model: string;
  operation: ResourceOperation;
  projectId: string;
  values: Record<string, unknown>;
}): unknown {
  const capability = resourceCapability(input.model);
  if (!capability.commands.includes(`workspace resource ${input.operation}`)) {
    throw new CliError(
      'RESOURCE_WRITE_EXCLUDED',
      `${input.model} is ${capability.coverage}; ${input.operation} is unavailable`,
    );
  }
  if (input.operation !== 'list' && input.operation !== 'get') {
    throw new CliError(
      'RESOURCE_WRITE_EXCLUDED',
      'Generic resource writes are unavailable until they use the authored transaction journal',
    );
  }

  const table = capability.table!;
  const columns = tableColumns(input.database, table);
  const id = typeof input.values.id === 'string' ? input.values.id : undefined;
  requireProjectResourceIdentity(table, input.projectId, id);

  if (input.operation === 'list') {
    const where = scopedWhere(columns, input.projectId);
    const limit =
      typeof input.values.limit === 'number'
        ? Math.max(1, Math.min(500, input.values.limit))
        : 100;
    const rows = input.database
      .prepare(`SELECT * FROM "${table}"${where.sql} LIMIT ?`)
      .all(...where.values, limit) as Record<string, unknown>[];
    return { model: input.model, count: rows.length, items: projectRows(rows) };
  }

  if (!id) throw new CliError('RESOURCE_ID_REQUIRED', 'get requires --id');
  const where = scopedWhere(columns, input.projectId, id);
  const row = input.database
    .prepare(`SELECT * FROM "${table}"${where.sql} LIMIT 1`)
    .get(...where.values) as Record<string, unknown> | undefined;
  if (!row) throw new CliError('RESOURCE_NOT_FOUND', `${input.model} ${id} was not found`);
  return projectRows([row])[0];
}
