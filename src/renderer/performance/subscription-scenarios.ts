import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useDataStore } from '../store/data-store';
import { useDataStoreFields } from '../store/use-data-store-fields';
import { buildEntityLinkColorSignature, DEFAULT_ENTITY_LINK_KIND_COLORS } from '../lib/entity-link-appearance';
import { selectEntityLinkNames, releaseEntityLinkNames } from '../lib/entity-link-names';
import { createSyntheticWorkspaceProjection } from './fixture';

/** Counts committed React renders, with real Zustand hooks in a disposable DOM. */
export function runSubscriptionScenarios() {
  const previous = useDataStore.getState();
  const scenarios = [];
  for (const consumers of [1, 5, 20]) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const commits = { wholeStore: 0, fields: 0 };
    const snapshots: string[] = [];
    function WholeStore() {
      const data = useDataStore();
      useLayoutEffect(() => { commits.wholeStore++; });
      return createElement('span', null, data.bookNodes.length);
    }
    function Fields() {
      const data = useDataStoreFields('bookNodes', 'workspaceProjectId');
      useLayoutEffect(() => {
        commits.fields++;
        snapshots.push(`${data.workspaceProjectId}:${data.bookNodes.length}`);
      });
      return createElement('span', null, `${data.workspaceProjectId}:${data.bookNodes.length}`);
    }
    function DynamicFields({ field }: { field: 'comments' | 'bookNodes' }) {
      const data = useDataStoreFields(field);
      return createElement('span', { id: 'dynamic-field' }, Object.keys(data).join(','));
    }
    try {
      flushSync(() => root.render(createElement(Fragment, null,
        ...Array.from({ length: consumers }, (_, id) => [
          createElement(WholeStore, { key: `whole-${id}` }), createElement(Fields, { key: `fields-${id}` }),
        ]).flat(),
      )));
      commits.wholeStore = 0;
      commits.fields = 0;
      for (let index = 0; index < 100; index++) flushSync(() => useDataStore.getState().setComments([]));
      const unrelated = { ...commits };
      if (unrelated.wholeStore !== consumers * 100 || unrelated.fields !== 0) throw new Error('Unrelated updates escaped field subscription');
      commits.wholeStore = 0;
      commits.fields = 0;
      snapshots.length = 0;
      // One atomic published snapshot: subscribers must never see half of it.
      flushSync(() => useDataStore.setState({ workspaceProjectId: 'synthetic-project', bookNodes: [] }));
      const related = { ...commits };
      if (related.fields !== consumers || snapshots.some((value) => value !== 'synthetic-project:0')) throw new Error('Selected snapshot update was missed or torn');
      flushSync(() => root.render(createElement(DynamicFields, { field: 'comments' })));
      const renderedKeys = () => container.textContent;
      if (renderedKeys() !== 'comments') throw new Error('Initial field keys missing');
      flushSync(() => root.render(createElement(DynamicFields, { field: 'bookNodes' })));
      if (renderedKeys() !== 'bookNodes') throw new Error('Changed field keys retained stale data');
      scenarios.push({ consumers, operations: 100, unrelated, related, atomicSnapshot: true, dynamicFieldKeys: true });
    } finally {
      flushSync(() => root.unmount());
      container.remove();
      useDataStore.setState(previous, true);
    }
  }
  return scenarios;
}

export function runSemanticSubscriptionScenario() {
  const previous = useDataStore.getState();
  const projectId = 'synthetic-semantic-project';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const commits = { collection: 0, names: 0, colors: 0 };
  const consumers = 20;
  const projection = createSyntheticWorkspaceProjection(projectId);
  const epoch = useDataStore.getState().requestWorkspaceProjection(projectId, 'loading');
  useDataStore.getState().commitWorkspaceProjection(projectId, epoch, projection);
  function Collections() {
    const { bookNodes } = useDataStoreFields('bookNodes', 'bookElements');
    useLayoutEffect(() => { commits.collection++; });
    return createElement('span', null, bookNodes[0]?.title);
  }
  function Names() {
    const names = useDataStore(selectEntityLinkNames);
    useLayoutEffect(() => { commits.names++; });
    return createElement('span', null, names.nodes[0]?.title);
  }
  function Colors() {
    const signature = useDataStore((state) => buildEntityLinkColorSignature(state, 'contextual', DEFAULT_ENTITY_LINK_KIND_COLORS));
    useLayoutEffect(() => { commits.colors++; });
    return createElement('span', null, signature.length);
  }
  const resetCounts = () => { commits.collection = 0; commits.names = 0; commits.colors = 0; };
  try {
    flushSync(() => root.render(createElement(Fragment, null,
      ...Array.from({ length: consumers }, (_, id) => [
        createElement(Collections, { key: `collection-${id}` }), createElement(Names, { key: `name-${id}` }), createElement(Colors, { key: `color-${id}` }),
      ]).flat(),
    )));
    resetCounts();
    for (let index = 0; index < 100; index++) {
      flushSync(() => useDataStore.getState().updateBookNode('synthetic-node-0', { wordCount: index }));
    }
    const metrics = { ...commits };
    if (metrics.collection !== 2_000 || metrics.names !== 0 || metrics.colors !== 0) throw new Error('Metrics invalidated semantic subscriptions');
    resetCounts();
    flushSync(() => useDataStore.getState().updateBookNode('synthetic-node-0', { title: '合成更名' }));
    const rename = { ...commits };
    if (rename.names !== consumers || rename.colors !== 0) throw new Error('Rename invalidation is incorrect');
    resetCounts();
    flushSync(() => useDataStore.getState().setBookElementCategories(projection.bookElementCategories.map((category) => ({ ...category, color: '#445566' }))));
    const appearance = { ...commits };
    if (appearance.names !== 0 || appearance.colors !== consumers) throw new Error('Appearance invalidation is incorrect');
    return { consumers, nodes: projection.bookNodes.length, elements: projection.bookElements.length, metricUpdates: 100, metrics, rename, appearance };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    releaseEntityLinkNames(projectId);
    useDataStore.setState(previous, true);
  }
}
