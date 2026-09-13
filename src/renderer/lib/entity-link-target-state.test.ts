import { expect, it } from 'vitest';
import { resolveEntityLinkTargetState, type EntityLinkTargetSnapshot } from './entity-link-target-state';

const empty = (): EntityLinkTargetSnapshot => ({ bookElements: [], bookNodes: [], storylines: [], bookElementCategories: [], trashedEntityIds: new Set() });
const collections = [
  ['element', 'bookElements'], ['node', 'bookNodes'],
  ['storyline', 'storylines'], ['category', 'bookElementCategories'],
] as const;
it.each(collections)('%s follows deletion, restoration and replacement snapshots', (kind, key) => {
  const alive = { ...empty(), [key]: [{ id: 'synthetic-target' }] };
  const trashed = { ...empty(), trashedEntityIds: new Set([`${kind}:synthetic-target`]) };
  expect(resolveEntityLinkTargetState(alive, kind, 'synthetic-target')).toBe('alive');
  expect(resolveEntityLinkTargetState(trashed, kind, 'synthetic-target')).toBe('trashed');
  expect(resolveEntityLinkTargetState(empty(), kind, 'synthetic-target')).toBe('gone');
  expect(resolveEntityLinkTargetState({ ...alive, trashedEntityIds: trashed.trashedEntityIds }, kind, 'synthetic-target')).toBe('alive');
  expect(resolveEntityLinkTargetState({ ...alive, [key]: [{ id: 'replacement-target' }] }, kind, 'synthetic-target')).toBe('gone');
  expect(resolveEntityLinkTargetState(alive, kind, 'synthetic-target')).toBe('alive');
  expect(resolveEntityLinkTargetState(trashed, kind, 'replacement-target')).toBe('gone');
});
it('preserves permissive navigation for kinds owned elsewhere', () => {
  expect(resolveEntityLinkTargetState({ ...empty(), trashedEntityIds: new Set(['patch:synthetic-target']) }, 'patch', 'synthetic-target')).toBe('alive');
});
it('shares a snapshot index across consumers and rebuilds only the replaced collection', () => {
  let reads = 0;
  const rows = () => Array.from({ length: 5000 }, (_, n) => ({ get id() { reads++; return `synthetic-${n}`; } }));
  const state = { ...empty(), bookNodes: rows(), bookElements: rows() };
  for (let n = 0; n < 20; n++) {
    expect(resolveEntityLinkTargetState(state, 'node', 'synthetic-4999')).toBe('alive');
    expect(resolveEntityLinkTargetState(state, 'node', 'missing')).toBe('gone');
  }
  expect(reads).toBe(5000);
  resolveEntityLinkTargetState({ ...state, trashedEntityIds: new Set(['node:missing']) }, 'node', 'missing');
  expect(reads).toBe(5000);
  resolveEntityLinkTargetState({ ...state, bookNodes: rows() }, 'node', 'synthetic-4999');
  expect(reads).toBe(10000);
  resolveEntityLinkTargetState(state, 'element', 'synthetic-4999');
  expect(reads).toBe(15000);
});
