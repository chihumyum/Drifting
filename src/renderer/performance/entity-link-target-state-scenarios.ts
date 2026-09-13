import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { useEntityLinkConfiguration } from '../features/editor/useEntityLinkConfiguration';
import { EntityLink, entityLinkConfig } from '../lib/extensions/entity-link';
import { resolveEntityLinkTargetState, type EntityLinkTargetSnapshot } from '../lib/entity-link-target-state';
import type { EntityKind } from '../domain/entity-kinds';
import { useDataStore, trashedKey } from '../store/data-store';
import { createSyntheticWorkspaceProjection } from './fixture';

const tracked = ['element', 'node', 'storyline', 'category'] as const;
const empty = (): EntityLinkTargetSnapshot => ({ bookElements: [], bookNodes: [], storylines: [], bookElementCategories: [], trashedEntityIds: new Set() });
// Linear reference reproduces the lookup before this batch. This is an operation
// comparison in one headless build, not historical whole-app timing.
function linear(state: EntityLinkTargetSnapshot, kind: EntityKind, id: string) {
  const alive = (() => {
    switch (kind) {
      case 'element': return state.bookElements.some(e => e.id === id);
      case 'node': return state.bookNodes.some(n => n.id === id);
      case 'storyline': return state.storylines.some(s => s.id === id);
      case 'category': return state.bookElementCategories.some(c => c.id === id);
      default: return true;
    }
  })();
  return alive ? 'alive' : state.trashedEntityIds.has(trashedKey(kind, id)) ? 'trashed' : 'gone';
}

export function runEntityLinkTargetStateScenarios() {
  const checks: { id: string; passed: true }[] = [];
  const check = (id: string, condition: boolean) => {
    if (!condition) throw new Error(`Entity target state: ${id}`);
    checks.push({ id, passed: true });
  };
  const profiles = [];
  for (const entitiesPerKind of [100, 1000, 5000]) for (const consumers of [1, 5, 20]) {
    let rowReads = 0;
    const collection = () => Array.from({ length: entitiesPerKind }, (_, n) => ({ get id() { rowReads++; return `synthetic-${n}`; } }));
    const state = { ...empty(), bookElements: collection(), bookNodes: collection(), storylines: collection(), bookElementCategories: collection() };
    const linksPerConsumer = 500;
    const targets = Array.from({ length: consumers * linksPerConsumer }, (_, n) => ({ kind: tracked[n % 4], id: n % 2 ? 'missing' : `synthetic-${entitiesPerKind - 1}` }));
    const reference = targets.map(({ kind, id }) => linear(state, kind, id));
    const linearRowReads = rowReads; rowReads = 0;
    const indexed = targets.map(({ kind, id }) => resolveEntityLinkTargetState(state, kind, id));
    const indexedRowReads = rowReads; rowReads = 0;
    for (const { kind, id } of targets) resolveEntityLinkTargetState(state, kind, id);
    const repeatedRowReads = rowReads;
    check(`${entitiesPerKind}:${consumers}:equivalent`, indexed.every((value, n) => value === reference[n]));
    check(`${entitiesPerKind}:${consumers}:bounded-index`, linearRowReads === entitiesPerKind * targets.length && indexedRowReads === entitiesPerKind * 4 && repeatedRowReads === 0);
    profiles.push({ entitiesPerKind, consumers, linksPerConsumer, lookups: targets.length, linearRowReads, indexedRowReads, repeatedRowReads });
  }

  const previous = useDataStore.getState();
  const previousConfig = { ...entityLinkConfig };
  const fixture = createSyntheticWorkspaceProjection('synthetic-link-state', 2, 2);
  const hosts = [document.createElement('div'), document.createElement('div')];
  const binding = document.createElement('div'); document.body.append(...hosts, binding);
  hosts[1].style.display = 'none';
  const root = createRoot(binding);
  const editors: Editor[] = [];
  const autoDetectTargets = new Map();
  function Configuration({ editor }: { editor: Editor }) {
    useEntityLinkConfiguration(editor, { autoDetectTargets, autoDetectEnabled: false });
    return null;
  }
  const publish = (value: Partial<typeof previous>) => flushSync(() => useDataStore.setState(value));
  try {
    publish({ ...fixture, workspaceProjectId: 'synthetic-link-state', workspaceProjectionGeneration: 'synthetic-generation-a' });
    for (const host of hosts) editors.push(new Editor({ element: host, extensions: [StarterKit, EntityLink.configure({ autoDetectEnabled: false })],
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '合成链接', marks: [{ type: 'entityLink', attrs: { targetKind: 'node', targetId: fixture.bookNodes[0].id } }] }] }] } }));
    const original = editors.map(editor => JSON.stringify(editor.getJSON()));
    flushSync(() => root.render(editors.map((editor, key) => createElement(Configuration, { key, editor }))));
    const decorated = (name: string, count: number) => editors.every(editor => editor.view.dom.querySelectorAll(name).length === count);
    check('mounted-visible-and-hidden-alive', decorated('.entity-link--trashed, .entity-link--dangling', 0));
    const id = fixture.bookNodes[0].id;
    publish({ bookNodes: fixture.bookNodes.slice(1), trashedEntityIds: new Set([trashedKey('node', id)]) });
    check('soft-delete-updates-both-editors', decorated('.entity-link--trashed', 1) && entityLinkConfig.resolveTargetState('node', id) === 'trashed');
    publish({ trashedEntityIds: new Set() });
    check('hard-delete-updates-both-editors', decorated('.entity-link--dangling', 1) && entityLinkConfig.resolveTargetState('node', id) === 'gone');
    publish({ bookNodes: fixture.bookNodes });
    check('restoration-updates-both-editors', decorated('.entity-link--trashed, .entity-link--dangling', 0) && entityLinkConfig.resolveTargetState('node', id) === 'alive');
    publish({ ...createSyntheticWorkspaceProjection('synthetic-other', 0, 0), workspaceProjectId: 'synthetic-other', workspaceProjectionGeneration: 'synthetic-generation-b' });
    check('replacement-project-drops-old-target', decorated('.entity-link--dangling', 1) && entityLinkConfig.resolveTargetState('node', id) === 'gone');
    publish({ ...fixture, workspaceProjectId: 'synthetic-link-state', workspaceProjectionGeneration: 'synthetic-generation-c' });
    check('return-to-project-restores-current-target', decorated('.entity-link--trashed, .entity-link--dangling', 0));
    check('configuration-preserves-editor-and-prose', editors.every((editor, n) => !editor.isDestroyed && JSON.stringify(editor.getJSON()) === original[n]));
    return { implementation: 'shared-snapshot-id-index', profiles, checks, mountedEditors: 2, hiddenEditors: 1,
      limitations: ['ID getter reads measure lookup work, not total document walks or user latency.', 'First access is linear per collection snapshot; retained indexes share weak keys with other consumers.', 'Headless Tiptap/React only; native focus, physical input and device budgets are not measured.'] };
  } finally {
    flushSync(() => root.unmount());
    for (const editor of editors) editor.destroy();
    useDataStore.setState(previous, true); Object.assign(entityLinkConfig, previousConfig);
    for (const host of [...hosts, binding]) host.remove();
  }
}
