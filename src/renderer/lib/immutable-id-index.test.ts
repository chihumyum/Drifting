import { describe, expect, it } from 'vitest';
import { findById, indexById } from './immutable-id-index';

describe('immutable collection ID index', () => {
  it('reads each ID once and reuses the index across lookup consumers', () => {
    let reads = 0;
    const records = Array.from({ length: 1_000 }, (_, value) => ({
      get id() { reads++; return String(value); }, value,
    }));
    const index = indexById(records);
    expect(reads).toBe(1_000);
    for (let i = 0; i < 100; i++) {
      expect(findById(records, '999')?.value).toBe(999);
      expect(indexById(records)).toBe(index);
    }
    expect(reads).toBe(1_000);
  });

  it('preserves first-match, missing-ID and isolated snapshot behavior', () => {
    const original = [{ id: 'same', name: 'first' }, { id: 'same', name: 'duplicate' }];
    expect(findById(original, 'same')).toBe(original[0]);
    expect(findById(original, 'missing')).toBeUndefined();
    const replacement = [{ id: 'same', name: 'renamed' }];
    expect(findById(replacement, 'same')?.name).toBe('renamed');
    expect(findById([], 'same')).toBeUndefined();
    expect(findById(original, 'same')?.name).toBe('first');
    expect(indexById(replacement)).not.toBe(indexById(original));
  });
});
