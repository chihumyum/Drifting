import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  return values;
});

import { useAgentActivityStore } from './agent-activity-store';
import { useAgentEditStore } from './agent-edit-store';
import { collectAgentUnreadMarks } from '../hooks/useAgentUnreadMarks';
import { createAgentDecorationSelector } from '../features/editor/agent-decoration-projection';
import { effectiveAgentEditMode, setAgentEditModeOverride } from '../lib/agent/agent-edit-mode';
import type { ActivityEntityType } from '../lib/agent/tool-entity-ref';

function write(entityType: ActivityEntityType, id: string, reviewId: string, mode: 'auto' | 'approve' = 'auto') {
  useAgentEditStore.getState().recordReview(entityType, id, [
    { blockId: 'paragraph', op: 'changed', oldText: 'Synthetic before', newText: 'Synthetic after', afterPrevId: null },
    { blockId: 'field:summary', op: 'changed', oldText: 'Old summary', newText: 'New summary', afterPrevId: null, field: { kind: 'summary', label: 'Summary' } },
  ], mode, { reviewId, effectId: `effect-${reviewId}` });
}

const unread = () => {
  const state = useAgentEditStore.getState();
  return collectAgentUnreadMarks(useAgentActivityStore.getState().touched, state.pending, state.additions);
};

beforeEach(() => {
  useAgentActivityStore.getState().clearAll();
  useAgentEditStore.getState().clearAll();
  setAgentEditModeOverride(null);
});
afterEach(() => { vi.unstubAllEnvs(); setAgentEditModeOverride(null); values.clear(); });

describe('Agent unread acknowledgement', () => {
  it('clears prose, fields and Added presentation only for the clicked entity kind and id', () => {
    write('node', 'same-id', 'node-review');
    write('element', 'same-id', 'element-review');
    useAgentEditStore.getState().recordAddition('node', 'same-id');
    const active = { entityType: 'node' as const, id: 'other-running', op: 'write' as const };
    useAgentActivityStore.setState({ active: { 'node:other-running': active } });
    useAgentActivityStore.getState().markSeen(['node:same-id']);
    expect(Object.keys(unread())).toEqual(['element:same-id']);
    expect(useAgentEditStore.getState().additions).toEqual({});
    expect(useAgentActivityStore.getState().active).toEqual({ 'node:other-running': active });
    expect(createAgentDecorationSelector('node', 'same-id')(useAgentEditStore.getState()))
      .toEqual({ approveChanges: [], autoRevealBlockIds: undefined });
  });

  it('persists acknowledgement and prevents receipt replay from resurrecting a reveal', async () => {
    write('node', 'chapter', 'review-1');
    useAgentActivityStore.getState().markSeen(['node:chapter']);
    const saved = JSON.parse(values.get('agent-edit-pending')!).state;
    useAgentEditStore.setState({ pending: {}, reviewBatches: {}, reviewOrder: [], settledReviewIds: {} });
    // Restore the exact persisted snapshot, as a fresh renderer would.
    values.set('agent-edit-pending', JSON.stringify({ state: saved, version: 1 }));
    await useAgentEditStore.persist.rehydrate();
    write('node', 'chapter', 'review-1');
    expect(unread()).toEqual({});
    expect(useAgentEditStore.getState().pending).toEqual({});
    write('node', 'chapter', 'review-2');
    expect(Object.keys(unread())).toEqual(['node:chapter']);
  });

  it('acknowledges a group scope without clearing another group or an incoming write guard', () => {
    write('storyline', 'story', 'story-review', 'approve');
    write('node', 'child', 'child-review');
    write('node', 'outside', 'outside-review');
    useAgentEditStore.getState().stageAutoRevealGuard('node', 'child', 'incoming', ['next-paragraph']);
    useAgentActivityStore.getState().markSeen(['storyline:story', 'node:child']);
    expect(Object.keys(unread())).toEqual(['node:outside']);
    expect(useAgentEditStore.getState().autoRevealGuards.incoming.blockIds).toEqual(['next-paragraph']);
    expect(useAgentEditStore.getState().reviewBatches['outside-review']).toBeDefined();
  });

  it('defaults to direct writes and cannot activate author review in a production renderer', () => {
    expect(effectiveAgentEditMode()).toBe('auto');
    vi.stubEnv('MODE', 'production');
    setAgentEditModeOverride('approve');
    expect(effectiveAgentEditMode()).toBe('auto');
  });
});
