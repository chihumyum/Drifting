import { describe, expect, it } from 'vitest';

import { countCanonicalCborNodes, decodeCanonicalCbor, MAX_CBOR_NODES } from '../protocol';
import { decodeAuthoredStatePagesV2, encodeAuthoredStatePagesV2 } from './authored-pages';

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    title: `Synthetic chapter ${index}`,
    order_key: index,
  }));
}

describe('paged authored checkpoint state', () => {
  it('splits a large table into canonical pages under the node limit and rejoins it', () => {
    const tables = [
      { table: 'project', rows: rows(1) },
      { table: 'book_node', rows: rows(40_000) },
      { table: 'project_asset', rows: [] },
    ];
    const pages = encodeAuthoredStatePagesV2(tables);
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) {
      const decoded = decodeCanonicalCbor(page);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(countCanonicalCborNodes(decoded.value)).toBeLessThanOrEqual(MAX_CBOR_NODES);
    }
    expect(decodeAuthoredStatePagesV2(pages)).toEqual(tables);
  });

  it('rejects a table split around another table', () => {
    const pages = encodeAuthoredStatePagesV2([
      { table: 'book_node', rows: rows(40_000) },
      { table: 'project', rows: rows(1) },
    ]);
    const reordered = [pages[0]!, pages[pages.length - 1]!, ...pages.slice(1, -1)];
    expect(() => decodeAuthoredStatePagesV2(reordered)).toThrow(/not contiguous/u);
  });
});
