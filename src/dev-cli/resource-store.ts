import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { canMoveGroupUnder, type DriftGroup } from '../renderer/domain/drift-group';
import { stripLibraryItemDeviceFields } from '../renderer/services/library-item-sync-boundary';
import { CliError } from './protocol';
import { resourceCapability } from './manifest';

type ResourceOperation = 'list' | 'get' | 'create' | 'update' | 'delete';

const SYNC_TYPES: Readonly<Record<string, string>> = {
  project: 'project',
  book_node: 'node',
  book_act: 'bookAct',
  drift_group: 'driftGroup',
  timeline_marker: 'timelineMarker',
  library_item: 'libraryItem',
};

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function encodeValue(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  )
    return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function projectRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [camelCase(key), value])),
  );
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  if (rows.length === 0)
    throw new CliError('RESOURCE_TABLE_MISSING', `Table ${table} does not exist in this database`);
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

function validateDriftBinding(
  database: DatabaseSync,
  projectId: string,
  driftNodeId: unknown,
): void {
  if (driftNodeId === undefined || driftNodeId === null) return;
  if (typeof driftNodeId !== 'string') {
    throw new CliError('INVALID_DRIFT_BINDING', 'driftNodeId must be a string or null');
  }
  const row = database
    .prepare('SELECT kind FROM book_node WHERE id = ? AND project_id = ? AND deleted_at IS NULL')
    .get(driftNodeId, projectId) as { kind?: unknown } | undefined;
  if (row?.kind !== 'drift') {
    throw new CliError(
      'INVALID_DRIFT_BINDING',
      `Node ${driftNodeId} is not an active inspiration in this project`,
    );
  }
}

function validateBookActMutation(
  database: DatabaseSync,
  projectId: string,
  id: string,
  values: Record<string, unknown>,
): void {
  validateDriftBinding(database, projectId, values.driftNodeId);
  if (!Object.prototype.hasOwnProperty.call(values, 'startOrder')) return;
  const startOrder = values.startOrder;
  if (startOrder !== null && (typeof startOrder !== 'number' || !Number.isFinite(startOrder))) {
    throw new CliError('INVALID_ACT_BOUNDARY', 'startOrder must be a finite number or null');
  }
  const sql =
    startOrder === null
      ? 'SELECT id FROM book_act WHERE project_id = ? AND start_order IS NULL AND id <> ? LIMIT 1'
      : 'SELECT id FROM book_act WHERE project_id = ? AND start_order = ? AND id <> ? LIMIT 1';
  const parameters: SQLInputValue[] =
    startOrder === null ? [projectId, id] : [projectId, startOrder as number, id];
  if (database.prepare(sql).get(...parameters)) {
    throw new CliError('DUPLICATE_ACT_BOUNDARY', 'An act already owns this boundary');
  }
}

function loadDriftGroups(database: DatabaseSync, projectId: string): DriftGroup[] {
  const rows = database
    .prepare('SELECT * FROM drift_group WHERE project_id = ?')
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    parentGroupId: row.parent_group_id === null ? null : String(row.parent_group_id),
    color: row.color === null ? null : String(row.color),
    sortOrder: row.sort_order === null ? null : Number(row.sort_order),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

function validateDriftGroupMutation(
  database: DatabaseSync,
  projectId: string,
  id: string,
  parentGroupId: unknown,
): void {
  if (parentGroupId === undefined || parentGroupId === null) return;
  if (typeof parentGroupId !== 'string') {
    throw new CliError('INVALID_GROUP_PARENT', 'parentGroupId must be a string or null');
  }
  const groups = loadDriftGroups(database, projectId);
  if (!groups.some((group) => group.id === parentGroupId)) {
    throw new CliError('INVALID_GROUP_PARENT', `Parent group ${parentGroupId} was not found`);
  }
  if (!canMoveGroupUnder(groups, id, parentGroupId)) {
    throw new CliError(
      'INVALID_GROUP_PARENT',
      'The requested parent would create a cycle or exceed the nesting limit',
    );
  }
}

function validateResourceMutation(input: {
  database: DatabaseSync;
  table: string;
  projectId: string;
  id: string;
  operation: 'create' | 'update';
  values: Record<string, unknown>;
}): void {
  if (input.table === 'project') {
    requireProjectResourceIdentity(input.table, input.projectId, input.id);
    if (
      input.values.userId !== undefined &&
      (typeof input.values.userId !== 'string' || !input.values.userId.trim())
    ) {
      throw new CliError('INVALID_PROJECT_USER', 'userId must be a non-empty string');
    }
  } else if (input.table === 'book_act') {
    validateBookActMutation(
      input.database,
      input.projectId,
      input.id,
      input.operation === 'create' &&
        !Object.prototype.hasOwnProperty.call(input.values, 'startOrder')
        ? { ...input.values, startOrder: null }
        : input.values,
    );
  } else if (input.table === 'timeline_marker') {
    validateDriftBinding(input.database, input.projectId, input.values.driftNodeId);
  } else if (input.table === 'drift_group') {
    validateDriftGroupMutation(
      input.database,
      input.projectId,
      input.id,
      input.values.parentGroupId,
    );
  }
}

function normalizedMutationInput(
  columns: Set<string>,
  values: Record<string, unknown>,
  projectId: string,
  operation: 'create' | 'update',
): Record<string, SQLInputValue> {
  const now = new Date().toISOString();
  const normalized: Record<string, SQLInputValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const column = snakeCase(key);
    if (!columns.has(column))
      throw new CliError('UNKNOWN_RESOURCE_FIELD', `Unknown resource field: ${key}`);
    if (['project_id', 'created_at', 'updated_at'].includes(column)) continue;
    normalized[column] = encodeValue(value);
  }
  if (columns.has('project_id')) normalized.project_id = projectId;
  if (operation === 'create' && columns.has('id') && normalized.id === undefined)
    normalized.id = randomUUID();
  if (operation === 'create' && columns.has('created_at')) normalized.created_at = now;
  if (columns.has('updated_at')) normalized.updated_at = now;
  return normalized;
}

function deleteBookAct(database: DatabaseSync, projectId: string, id: string): void {
  const target = database
    .prepare('SELECT start_order FROM book_act WHERE id = ? AND project_id = ?')
    .get(id, projectId) as { start_order?: unknown } | undefined;
  if (!target) throw new CliError('RESOURCE_NOT_FOUND', `book_act ${id} was not found`);
  if (target.start_order === null) {
    const heir = database
      .prepare(
        'SELECT id FROM book_act WHERE project_id = ? AND id <> ? ORDER BY start_order ASC LIMIT 1',
      )
      .get(projectId, id) as { id?: unknown } | undefined;
    if (typeof heir?.id === 'string') {
      const updatedAt = new Date().toISOString();
      database
        .prepare('UPDATE book_act SET start_order = NULL, updated_at = ? WHERE id = ?')
        .run(updatedAt, heir.id);
      writeOutbox(database, {
        table: 'book_act',
        operation: 'update',
        id: heir.id,
        projectId,
        payload: { startOrder: null, updatedAt },
      });
    }
  }
  database.prepare('DELETE FROM book_act WHERE id = ? AND project_id = ?').run(id, projectId);
}

function deleteDriftGroup(database: DatabaseSync, projectId: string, id: string): void {
  const target = database
    .prepare('SELECT parent_group_id FROM drift_group WHERE id = ? AND project_id = ?')
    .get(id, projectId) as { parent_group_id?: unknown } | undefined;
  if (!target) throw new CliError('RESOURCE_NOT_FOUND', `drift_group ${id} was not found`);
  const parent = target.parent_group_id === null ? null : String(target.parent_group_id);
  const updatedAt = new Date().toISOString();
  const childIds = database
    .prepare('SELECT id FROM drift_group WHERE project_id = ? AND parent_group_id = ?')
    .all(projectId, id) as Array<{ id: string }>;
  for (const child of childIds) {
    database
      .prepare('UPDATE drift_group SET parent_group_id = ?, updated_at = ? WHERE id = ?')
      .run(parent, updatedAt, child.id);
    writeOutbox(database, {
      table: 'drift_group',
      operation: 'update',
      id: child.id,
      projectId,
      payload: { parentGroupId: parent, updatedAt },
    });
  }
  const driftIds = database
    .prepare(
      "SELECT id FROM book_node WHERE project_id = ? AND kind = 'drift' AND drift_group_id = ?",
    )
    .all(projectId, id) as Array<{ id: string }>;
  for (const drift of driftIds) {
    database
      .prepare('UPDATE book_node SET drift_group_id = ?, updated_at = ? WHERE id = ?')
      .run(parent, updatedAt, drift.id);
    writeOutbox(database, {
      table: 'book_node',
      operation: 'update',
      id: drift.id,
      projectId,
      payload: { driftGroupId: parent, updatedAt },
    });
  }
  database.prepare('DELETE FROM drift_group WHERE id = ? AND project_id = ?').run(id, projectId);
}

function writeOutbox(
  database: DatabaseSync,
  input: {
    table: string;
    operation: 'create' | 'update' | 'delete';
    id: string;
    projectId: string;
    payload?: Record<string, unknown>;
  },
): void {
  const entityType = SYNC_TYPES[input.table];
  if (!entityType) return;
  const now = new Date().toISOString();
  database
    .prepare(
      `
    INSERT INTO local_sync_mutation
      (entity_type, mutation_type, entity_id, project_id, parent_id, payload_json, mutation_ts, status, retry_count, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending', 0, NULL, ?, ?)
  `,
    )
    .run(
      entityType,
      input.operation,
      input.id,
      input.projectId,
      input.payload
        ? JSON.stringify(
            input.table === 'library_item'
              ? stripLibraryItemDeviceFields(input.payload)
              : input.payload,
          )
        : null,
      Date.now(),
      now,
      now,
    );
}

export function executeResourceOperation(input: {
  database: DatabaseSync;
  model: string;
  operation: ResourceOperation;
  projectId: string;
  values: Record<string, unknown>;
}): unknown {
  const capability = resourceCapability(input.model);
  const table = capability.table!;
  const columns = tableColumns(input.database, table);
  const suppliedId = typeof input.values.id === 'string' ? input.values.id : undefined;
  const id =
    input.operation === 'create'
      ? input.model === 'project'
        ? input.projectId
        : (suppliedId ?? randomUUID())
      : suppliedId;
  requireProjectResourceIdentity(table, input.projectId, id);

  if (input.operation === 'list') {
    const where = scopedWhere(columns, input.projectId);
    const limit =
      typeof input.values.limit === 'number' ? Math.max(1, Math.min(500, input.values.limit)) : 100;
    const rows = input.database
      .prepare(`SELECT * FROM "${table}"${where.sql} LIMIT ?`)
      .all(...where.values, limit) as Record<string, unknown>[];
    return { model: input.model, count: rows.length, items: projectRows(rows) };
  }
  if (!id) throw new CliError('RESOURCE_ID_REQUIRED', `${input.operation} requires --id`);
  const where = scopedWhere(columns, input.projectId, id);
  if (input.operation === 'get') {
    const row = input.database
      .prepare(`SELECT * FROM "${table}"${where.sql} LIMIT 1`)
      .get(...where.values) as Record<string, unknown> | undefined;
    if (!row) throw new CliError('RESOURCE_NOT_FOUND', `${input.model} ${id} was not found`);
    return projectRows([row])[0];
  }
  if (
    capability.coverage !== 'full_lifecycle' ||
    !capability.commands.includes(`workspace resource ${input.operation}`)
  ) {
    throw new CliError(
      'RESOURCE_WRITE_EXCLUDED',
      `${input.model} is ${capability.coverage}; ${input.operation} is unavailable`,
    );
  }

  input.database.exec('BEGIN IMMEDIATE');
  try {
    if (input.operation === 'delete') {
      if (table === 'book_act') {
        deleteBookAct(input.database, input.projectId, id);
      } else if (table === 'drift_group') {
        deleteDriftGroup(input.database, input.projectId, id);
      } else {
        const result = input.database
          .prepare(`DELETE FROM "${table}"${where.sql}`)
          .run(...where.values);
        if (Number(result.changes) !== 1) {
          throw new CliError('RESOURCE_NOT_FOUND', `${input.model} ${id} was not found`);
        }
      }
      writeOutbox(input.database, { table, operation: 'delete', id, projectId: input.projectId });
      input.database.exec('COMMIT');
      return { id, deleted: true };
    }
    validateResourceMutation({
      database: input.database,
      table,
      projectId: input.projectId,
      id,
      operation: input.operation,
      values: input.values,
    });
    const record = normalizedMutationInput(columns, input.values, input.projectId, input.operation);
    delete record.id;
    if (input.operation === 'create') record.id = id;
    if (input.operation === 'create') {
      const names = Object.keys(record);
      const placeholders = names.map(() => '?').join(', ');
      input.database
        .prepare(
          `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${placeholders})`,
        )
        .run(...names.map((name) => record[name]!));
    } else {
      const names = Object.keys(record);
      if (names.length === 0)
        throw new CliError('RESOURCE_UPDATE_EMPTY', 'No resource fields were supplied');
      const result = input.database
        .prepare(
          `UPDATE "${table}" SET ${names.map((name) => `"${name}" = ?`).join(', ')}${where.sql}`,
        )
        .run(...names.map((name) => record[name]!), ...where.values);
      if (Number(result.changes) !== 1)
        throw new CliError('RESOURCE_NOT_FOUND', `${input.model} ${id} was not found`);
    }
    const row = input.database
      .prepare(`SELECT * FROM "${table}"${where.sql} LIMIT 1`)
      .get(...where.values) as Record<string, unknown>;
    const projected = projectRows([row])[0]!;
    writeOutbox(input.database, {
      table,
      operation: input.operation,
      id,
      projectId: input.projectId,
      payload: projected,
    });
    input.database.exec('COMMIT');
    return projected;
  } catch (error) {
    try {
      input.database.exec('ROLLBACK');
    } catch {
      /* original error is authoritative */
    }
    throw error;
  }
}
