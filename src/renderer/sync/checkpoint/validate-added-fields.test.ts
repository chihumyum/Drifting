import { describe, expect, it } from 'vitest';
import { SYNC_DOMAIN_MANIFEST_V1 } from '../protocol/domain-manifest';
import { withNullableFieldsAddedAfterV1 } from './validate';

describe('checkpoint rows captured before a nullable column existed', () => {
  it('fills provenance_json with null for library items captured before migration 0009', () => {
    const row = { id: 'library-1', title: 'Reference', notes_json: null };
    expect(withNullableFieldsAddedAfterV1('library_item', row)).toEqual({ ...row, provenance_json: null });
    const current = { ...row, provenance_json: '{"v":1}' };
    expect(withNullableFieldsAddedAfterV1('library_item', current)).toBe(current);
    expect(withNullableFieldsAddedAfterV1('book_node', row)).toBe(row);
  });

  it('only back-fills columns the current manifest includes', () => {
    const library = SYNC_DOMAIN_MANIFEST_V1.tables.find((table) => table.table === 'library_item');
    expect(library?.fields.provenance_json?.disposition).toBe('include');
  });
});
