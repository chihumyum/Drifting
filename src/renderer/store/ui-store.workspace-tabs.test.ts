import { beforeEach, describe, expect, it } from 'vitest';

import { tabKey, useUiStore } from './ui-store';

describe('project-local workspace tabs', () => {
  beforeEach(() => {
    useUiStore.setState({ tabsByProject: {} });
  });

  it('removes local tabs whose restored workspace entity does not exist', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'valid-node' }, { preview: false });
    store.openEntityTab('project-a', { entityType: 'node', id: 'stale-node' }, { preview: false });

    useUiStore.getState().pruneProjectTabs('project-a', {
      nodeIds: new Set(['valid-node']),
      storylineIds: new Set(),
      elementIds: new Set(),
      categoryIds: new Set(),
    });

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project?.openTabs.map(tabKey)).toEqual(['node:valid-node']);
    expect(project?.activeTabKey).toBe('node:valid-node');
  });

  it('does not alter another project tab collection', () => {
    useUiStore
      .getState()
      .openEntityTab('project-b', { entityType: 'node', id: 'node-b' }, { preview: false });
    useUiStore.getState().pruneProjectTabs('project-a', {
      nodeIds: new Set(),
      storylineIds: new Set(),
      elementIds: new Set(),
      categoryIds: new Set(),
    });
    expect(useUiStore.getState().tabsByProject['project-b']?.openTabs.map(tabKey)).toEqual([
      'node:node-b',
    ]);
  });
});
