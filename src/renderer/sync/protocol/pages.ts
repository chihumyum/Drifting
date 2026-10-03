import { MAX_CBOR_NODES, type CanonicalCborValue } from './primitives';

/**
 * One canonical CBOR value is capped at `MAX_CBOR_NODES`. Collections whose
 * size grows with a project are split into pages that stay well below it.
 */
export const CANONICAL_PAGE_NODE_BUDGET = MAX_CBOR_NODES / 2;

/** Counts nodes exactly as the canonical CBOR validator does. */
export function countCanonicalCborNodes(value: CanonicalCborValue): number {
  if (Array.isArray(value)) {
    let nodes = 1;
    for (const entry of value) nodes += countCanonicalCborNodes(entry);
    return nodes;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    let nodes = 1;
    for (const entry of Object.values(value)) nodes += countCanonicalCborNodes(entry);
    return nodes;
  }
  return 1;
}

/**
 * Greedily groups ordered entries so each page, including `pageOverhead`
 * nodes for its envelope, stays within the budget. An entry that cannot fit
 * on an empty page is rejected rather than silently producing an invalid page.
 */
export function paginateCanonicalEntries<T extends CanonicalCborValue>(
  entries: readonly T[],
  pageOverhead: number,
  budget = CANONICAL_PAGE_NODE_BUDGET,
): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let nodes = pageOverhead;
  for (const entry of entries) {
    const size = countCanonicalCborNodes(entry);
    if (pageOverhead + size > MAX_CBOR_NODES) {
      throw new RangeError(`a single entry needs ${size} CBOR nodes, above the ${MAX_CBOR_NODES} limit`);
    }
    if (page.length > 0 && nodes + size > budget) {
      pages.push(page);
      page = [];
      nodes = pageOverhead;
    }
    page.push(entry);
    nodes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}
