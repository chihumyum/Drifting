import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_EDIT_CACHE_MAX_CHARS, createAgentEditStorage } from './agent-edit-storage';
import { useAgentEditStore } from './agent-edit-store';

const key = 'agent-edit-pending';
const change = {
  blockId: 'synthetic-block', op: 'new' as const, oldText: '',
  newText: 'Synthetic prose', afterPrevId: null,
};

describe('Agent edit cache quota recovery', () => {
  const values = new Map<string, string>();
  let full = false;
  const storage = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, raw: string) => {
      if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      values.set(name, raw);
    }),
    removeItem: vi.fn((name: string) => { values.delete(name); }),
  };

  beforeEach(() => {
    values.clear(); full = false; vi.clearAllMocks();
    vi.stubGlobal('localStorage', storage);
    useAgentEditStore.getState().clearAll();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps Added seeding, completion, and acknowledgement usable when the shared quota is full', async () => {
    const store = useAgentEditStore.getState();
    store.recordAddition('category', 'synthetic-category');
    values.set('unrelated-settings', 'keep');
    expect(values.has(key)).toBe(true);
    full = true;

    expect(() => store.beginAdditionReveal('category', 'synthetic-category', [change])).not.toThrow();
    expect(useAgentEditStore.getState().pending['category:synthetic-category'].changes).toEqual([
      change,
    ]);
    expect(values.has(key)).toBe(false);
    expect(() => store.resolveBlocks('category', 'synthetic-category', [change.blockId])).not.toThrow();
    expect(() => store.resolveAddition('category', 'synthetic-category')).not.toThrow();
    expect(useAgentEditStore.getState().additions).toEqual({});

    expect(() => store.recordReview('node', 'synthetic-node', [change], {
      reviewId: 'synthetic-review', effectId: 'synthetic-effect',
    })).not.toThrow();
    expect(() => store.markSeen(['node:synthetic-node'])).not.toThrow();
    expect(store.recordReview('node', 'synthetic-node', [change], {
      reviewId: 'synthetic-review', effectId: 'synthetic-effect',
    })).toBe(false);
    expect(useAgentEditStore.getState().pending).toEqual({});
    await useAgentEditStore.persist.rehydrate();
    expect(useAgentEditStore.getState().pending).toEqual({});
    expect(values.get('unrelated-settings')).toBe('keep');

    full = false;
    store.recordAddition('node', 'later-node');
    expect(JSON.parse(values.get(key)!).state.additions['node:later-node']).toBeDefined();
  });

  it('evicts an oversized first-open cache without truncating live prose or changing the v2 envelope', async () => {
    const store = useAgentEditStore.getState();
    store.recordAddition('node', 'long-node');
    const largeChange = { ...change, newText: '合'.repeat(AGENT_EDIT_CACHE_MAX_CHARS) };
    const writesBefore = storage.setItem.mock.calls.length;
    expect(store.beginAdditionReveal('node', 'long-node', [largeChange])).toEqual([change.blockId]);
    expect(useAgentEditStore.getState().pending['node:long-node'].changes[0].newText).toBe(largeChange.newText);
    expect(storage.setItem.mock.calls.length).toBe(writesBefore);
    expect(values.has(key)).toBe(false);

    store.resolveBlocks('node', 'long-node', [change.blockId]);
    const saved = values.get(key)!;
    expect(saved.length).toBeLessThanOrEqual(AGENT_EDIT_CACHE_MAX_CHARS);
    expect(JSON.parse(saved).version).toBe(2);
    useAgentEditStore.setState({ additions: {} });
    values.set(key, saved);
    await useAgentEditStore.persist.rehydrate();
    expect(useAgentEditStore.getState().additions['node:long-node'].revealBlockIds).toEqual([change.blockId]);
  });

  it('discards oversized pre-fix and corrupt caches on startup', async () => {
    const cache = createAgentEditStorage(() => storage);
    for (const raw of ['{broken', JSON.stringify({ state: { pending: 'x'.repeat(AGENT_EDIT_CACHE_MAX_CHARS) }, version: 1 })]) {
      values.set(key, raw);
      expect(cache.getItem(key)).toBeNull();
      expect(values.has(key)).toBe(false);
      await useAgentEditStore.persist.rehydrate();
      expect(useAgentEditStore.persist.hasHydrated()).toBe(true);
    }
  });

  it('contains storage access, read, deletion and serialization failures', () => {
    const unavailable = createAgentEditStorage(() => { throw new DOMException('Denied', 'SecurityError'); });
    expect(unavailable.getItem(key)).toBeNull();
    expect(() => unavailable.setItem(key, { state: {}, version: 1 })).not.toThrow();
    expect(() => unavailable.removeItem(key)).not.toThrow();
    const denied = createAgentEditStorage(() => ({
      ...storage,
      getItem: () => { throw new Error('read denied'); },
      removeItem: () => { throw new Error('delete denied'); },
    }));
    expect(denied.getItem(key)).toBeNull();
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    values.set(key, 'stale snapshot');
    expect(() => createAgentEditStorage(() => storage).setItem(key, { state: cyclic })).not.toThrow();
    expect(values.has(key)).toBe(false);
  });
});
