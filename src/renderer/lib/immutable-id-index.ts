// Collections are immutable snapshots. Weak keys let retired project arrays
// and their indexes be collected together; callers must never mutate the map.
const indexes = new WeakMap<readonly { id: string }[], ReadonlyMap<string, { id: string }>>();

/** Share one first-match ID index across consumers of the same snapshot. */
export function indexById<T extends { id: string }>(records: readonly T[]): ReadonlyMap<string, T> {
  let index = indexes.get(records);
  if (!index) {
    const next = new Map<string, T>();
    for (const record of records) {
      const id = record.id;
      if (!next.has(id)) next.set(id, record);
    }
    index = next;
    indexes.set(records, index);
  }
  return index as ReadonlyMap<string, T>;
}

export function findById<T extends { id: string }>(records: readonly T[], id: string): T | undefined {
  return indexById(records).get(id);
}
