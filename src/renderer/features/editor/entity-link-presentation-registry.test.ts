import { expect, it, vi } from 'vitest';
import { createEntityLinkPresentationRegistry } from './entity-link-presentation-registry';
import { entityLinkConfig } from '../../lib/extensions/entity-link';
import { DEFAULT_ENTITY_LINK_KIND_COLORS, type EntityLinkColorMode } from '../../lib/entity-link-appearance';
import { createSyntheticWorkspaceProjection } from '../../performance/fixture';
function store<T>(initial: T) {
  let value = initial; const listeners = new Set<() => void>();
  return { getState: () => value, listeners, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set(patch: Partial<T>) { value = { ...value, ...patch }; for (const listener of [...listeners]) if (listeners.has(listener)) listener(); } };
}
function fixture() {
  const data = store(createSyntheticWorkspaceProjection('synthetic-project', 20, 20));
  const settings = store({ entityLinkInteractive: true, entityLinkColorMode: 'contextual' as EntityLinkColorMode, entityLinkKindColors: DEFAULT_ENTITY_LINK_KIND_COLORS });
  const config = { ...entityLinkConfig, targetColorVersion: 0 };
  return { data, settings, config, registry: createEntityLinkPresentationRegistry(data, settings, config) };
}
it('shares exactly one data and settings subscription across twenty independent owners', () => {
  const f = fixture(); const callbacks = Array.from({ length: 20 }, () => vi.fn());
  const off = callbacks.map(callback => f.registry.attach(callback));
  expect(f.data.listeners.size).toBe(1); expect(f.settings.listeners.size).toBe(1); expect(f.config.targetColorVersion).toBe(1);
  for (const callback of callbacks) expect(callback).toHaveBeenCalledExactlyOnceWith({ targetsChanged: true });
  for (const release of off) { release(); release(); }
  expect(f.data.listeners.size).toBe(0); expect(f.settings.listeners.size).toBe(0);
  f.settings.set({ entityLinkColorMode: 'kind' }); expect(f.config.targetColorVersion).toBe(1);
  for (const callback of callbacks) expect(callback).toHaveBeenCalledTimes(1);
});
it('ignores body, title, alias and order changes that preserve display semantics', () => {
  const f = fixture(); const changed = vi.fn(); const off = f.registry.attach(changed); changed.mockClear();
  f.data.set({ bookNodes: f.data.getState().bookNodes.map(n => ({ ...n, title: n.title + '新', summary: '合成摘要' })),
    bookElements: f.data.getState().bookElements.map(e => ({ ...e, name: e.name + '新', aliases: ['合成别名'], contentJson: '{"type":"doc"}' })) });
  expect(changed).not.toHaveBeenCalled(); expect(f.config.targetColorVersion).toBe(1);
  // In prose mode, even category assignments and input-order differences cannot
  // change colors; membership is an ID set rather than an array identity.
  f.settings.set({ entityLinkColorMode: 'prose' }); changed.mockClear(); const version = f.config.targetColorVersion;
  f.data.set({ bookNodes: [...f.data.getState().bookNodes].reverse(), bookElements: [...f.data.getState().bookElements].reverse(), trashedEntityIds: new Set() });
  expect(changed).not.toHaveBeenCalled(); expect(f.config.targetColorVersion).toBe(version); off();
});
it('updates colors once without requesting liveness scans and treats interaction separately', () => {
  const f = fixture(); const changed = vi.fn(); const off = f.registry.attach(changed); changed.mockClear();
  const id = f.data.getState().bookElements[0].id;
  f.data.set({ bookElementCategories: f.data.getState().bookElementCategories.map(c => ({ ...c, color: '#abcdef' })) });
  expect(changed).toHaveBeenCalledExactlyOnceWith({ targetsChanged: false }); expect(f.config.targetColorVersion).toBe(2);
  expect(f.config.resolveTargetColor('element', id)).toBe('#abcdef'); changed.mockClear();
  f.settings.set({ entityLinkInteractive: false }); expect(f.config.interactionEnabled).toBe(false);
  expect(changed).not.toHaveBeenCalled(); expect(f.config.targetColorVersion).toBe(2); off();
});
it('refreshes deletion, trash transitions and restoration even with unchanged automatic-link names', () => {
  const f = fixture(); f.settings.set({ entityLinkColorMode: 'prose' });
  const original = f.data.getState().bookNodes; const id = original[0].id;
  const changed = vi.fn(); const off = f.registry.attach(changed); changed.mockClear();
  f.data.set({ bookNodes: original.slice(1), trashedEntityIds: new Set([`node:${id}`]) });
  expect(f.config.resolveTargetState('node', id)).toBe('trashed');
  f.data.set({ trashedEntityIds: new Set() }); expect(f.config.resolveTargetState('node', id)).toBe('gone');
  f.data.set({ bookNodes: original }); expect(f.config.resolveTargetState('node', id)).toBe('alive');
  expect(changed.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ targetsChanged: true }]));
  expect(f.config.targetColorVersion).toBe(1); off();
});
it('skips an owner disposed during delivery and keeps duplicate callbacks independent', () => {
  const f = fixture(); let deliver = false; let offB = () => undefined as void;
  const offA = f.registry.attach(() => { if (deliver) offB(); }); const b = vi.fn(); offB = f.registry.attach(b); b.mockClear();
  deliver = true; f.settings.set({ entityLinkColorMode: 'kind' }); expect(b).not.toHaveBeenCalled(); offA();
  const first = f.registry.attach(b); const second = f.registry.attach(b); first(); b.mockClear();
  f.settings.set({ entityLinkColorMode: 'prose' }); expect(b).toHaveBeenCalledTimes(1); second();
  expect(f.data.listeners.size).toBe(0);
});
it('finishes a reentrant store update with current resolvers and all remaining owners refreshed', () => {
  const f = fixture(); let reenter = false; const id = f.data.getState().bookNodes[0].id;
  const offA = f.registry.attach(() => { if (reenter) { reenter = false; f.data.set({ bookNodes: [] }); } });
  const b = vi.fn(); const offB = f.registry.attach(b); b.mockClear(); reenter = true;
  f.settings.set({ entityLinkColorMode: 'kind' });
  expect(b.mock.calls[b.mock.calls.length - 1]).toEqual([{ targetsChanged: true }]); expect(f.config.resolveTargetState('node', id)).toBe('gone');
  offA(); offB(); expect(f.settings.listeners.size).toBe(0);
});
it('releases the last snapshot and reconnects current state after repeated teardown', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    const changed = vi.fn(); const off = f.registry.attach(changed); off();
    expect(f.data.listeners.size).toBe(0); expect(f.settings.listeners.size).toBe(0);
    f.settings.set({ entityLinkInteractive: i % 2 === 0 }); expect(changed).toHaveBeenCalledTimes(1);
  }
  const off = f.registry.attach(() => undefined);
  expect(f.config.interactionEnabled).toBe(f.settings.getState().entityLinkInteractive); off();
});
