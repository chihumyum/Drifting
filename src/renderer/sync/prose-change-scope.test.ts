import { describe, expect, it } from 'vitest';
import { boundedProseDocIds, committedProseDocIds, MAX_PROSE_CHANGE_DOCS } from './prose-change-scope';

const mutation = (id: string) => ({ action: 'yjs.update', target: { family: 'yjs', kind: 'prose-document', id } });

describe('committed prose notification scope', () => {
  it('deduplicates and freezes all four canonical prose kinds without copying payload bytes', () => {
    const ids = ['node-content:a', 'element:b', 'category:c', 'storyline:d', 'node-content:a'];
    const scope = committedProseDocIds(ids.map(mutation));
    expect(scope).toEqual(ids.slice(0, 4));
    expect(Object.isFrozen(scope)).toBe(true);
  });
  it.each([[], [mutation('node-content:')], [mutation('unknown:a')], [{ ...mutation('node-content:a'), action: 'field.set' }], [mutation('node-content:a'), { ...mutation('element:b'), action: 'entity.trash' }], [{ ...mutation('node-content:a'), target: { family: 'entity', kind: 'node', id: 'a' } }]])('falls back to full coverage for empty, unknown or mixed mutations: %j', (...mutations) => {
    expect(committedProseDocIds(mutations)).toBeUndefined();
  });
  it('bounds unique source identities and promotes overflow to complete capture', () => {
    const ids = Array.from({ length: MAX_PROSE_CHANGE_DOCS }, (_, index) => `node-content:${index}`);
    expect(boundedProseDocIds(ids)).toHaveLength(MAX_PROSE_CHANGE_DOCS);
    expect(boundedProseDocIds([...ids, 'element:overflow'])).toBeUndefined();
  });
});
