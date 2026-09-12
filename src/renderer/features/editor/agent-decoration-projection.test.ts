import { describe, expect, it } from 'vitest';
import type { AgentBlockChange } from '../../lib/agent/block-diff';
import { createAgentDecorationSelector, type AgentDecorationSnapshot } from './agent-decoration-projection';

const empty = (): AgentDecorationSnapshot => ({ pending: {}, additions: {}, autoRevealGuards: {} });
const change = (blockId: string, mode: 'auto' | 'approve' = 'approve'): AgentBlockChange => ({
  blockId, mode, op: 'changed', oldText: '旧合成正文', newText: '新合成正文', afterPrevId: null,
});

describe('Agent decoration semantic selection', () => {
  it('ignores other entities and non-prose field updates', () => {
    const select = createAgentDecorationSelector('node', 'target');
    const initial = select(empty());
    expect(select({ ...empty(), pending: { 'node:other': { entityType: 'node', id: 'other', changes: [change('block')] } } })).toBe(initial);
    expect(select({ ...empty(), pending: { 'node:target': {
      entityType: 'node', id: 'target', changes: [{ ...change('field:summary'), field: { kind: 'summary', label: '摘要' } }],
    } } })).toBe(initial);
  });

  it('keeps prose identity when unrelated field changes are merged into an entity', () => {
    const prose = change('block');
    const select = createAgentDecorationSelector('node', 'target');
    const state = { ...empty(), pending: { 'node:target': { entityType: 'node' as const, id: 'target', changes: [prose] } } };
    const before = select(state);
    expect(select({ ...state, pending: { 'node:target': {
      ...state.pending['node:target'], changes: [prose, { ...change('field:summary'), field: { kind: 'summary', label: '摘要' } }],
    } } })).toBe(before);
    expect(select(empty())).toEqual({ approveChanges: [], autoRevealBlockIds: undefined });
  });

  it('isolates guards by entity kind and compares retained guard identities', () => {
    const guard = { entityType: 'node' as const, id: 'target', reviewId: 'review', blockIds: ['block'] };
    const select = createAgentDecorationSelector('node', 'target');
    const state = { ...empty(), autoRevealGuards: { review: guard } };
    const projected = select(state);
    expect(projected.autoRevealBlockIds).toEqual(['block']);
    expect(select({ ...state, autoRevealGuards: {
      ...state.autoRevealGuards, other: { ...guard, entityType: 'element', reviewId: 'other' },
    } })).toBe(projected);
    expect(select({ ...state, autoRevealGuards: { review: { ...guard, blockIds: ['next'] } } }).autoRevealBlockIds).toEqual(['next']);
    expect(select(empty()).autoRevealBlockIds).toBeUndefined();
  });

  it('preserves pre-live to durable review handoff and Added mask-all semantics', () => {
    const select = createAgentDecorationSelector('node', 'target');
    expect(select({ ...empty(), additions: { 'node:target': { entityType: 'node', id: 'target', revealBlockIds: null } } }).autoRevealBlockIds).toBeNull();
    const auto = change('block', 'auto');
    expect(select({ ...empty(), pending: { 'node:target': {
      entityType: 'node', id: 'target', changes: [auto, { ...change('deleted', 'auto'), op: 'deleted' }],
    } } })).toEqual({ approveChanges: [], autoRevealBlockIds: ['block'] });
    expect(select({ ...empty(), pending: { 'node:target': {
      entityType: 'node', id: 'target', changes: [{ ...auto, mode: 'approve' }],
    } } })).toEqual({ approveChanges: [{ ...auto, mode: 'approve' }], autoRevealBlockIds: undefined });
  });
});
