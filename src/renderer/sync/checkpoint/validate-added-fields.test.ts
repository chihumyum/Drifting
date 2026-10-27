import { describe, expect, it } from 'vitest';
import { SYNC_DOMAIN_MANIFEST_V1 } from '../protocol/domain-manifest';
import { withNullableFieldsAddedAfterV1, withTablesAddedAfterV1 } from './validate';

describe('checkpoint rows captured before a column existed', () => {
  it('back-fills library item columns added by migrations 0009 and 0012', () => {
    const row = { id: 'library-1', title: 'Reference', notes_json: null };
    expect(withNullableFieldsAddedAfterV1('library_item', row)).toEqual({
      ...row,
      provenance_json: null,
      folder_id: null,
      task_todos: true,
    });
    const current = { ...row, provenance_json: '{"v":1}', folder_id: 'folder-1', task_todos: false };
    expect(withNullableFieldsAddedAfterV1('library_item', current)).toBe(current);
    expect(withNullableFieldsAddedAfterV1('book_node', row)).toBe(row);
  });

  it('only back-fills columns the current manifest includes', () => {
    const library = SYNC_DOMAIN_MANIFEST_V1.tables.find((table) => table.table === 'library_item');
    for (const field of ['provenance_json', 'folder_id', 'task_todos']) {
      expect(library?.fields[field]?.disposition).toBe('include');
    }
  });
});

describe('checkpoints captured before a table existed', () => {
  it('restores material folders empty, in UTF-8 table order', () => {
    const entries = [
      { table: 'library_item', rows: [] },
      { table: 'node_content', rows: [] },
    ];
    expect(withTablesAddedAfterV1(entries)).toEqual([
      { table: 'library_item', rows: [] },
      { table: 'material_folder', rows: [] },
      { table: 'node_content', rows: [] },
    ]);
    const current = [...entries, { table: 'material_folder', rows: [] }];
    expect(withTablesAddedAfterV1(current)).toBe(current);
  });
});
