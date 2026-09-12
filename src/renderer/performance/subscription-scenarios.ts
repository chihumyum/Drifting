import { createElement, Fragment, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useDataStore } from '../store/data-store';
import { useDataStoreFields } from '../store/use-data-store-fields';

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
