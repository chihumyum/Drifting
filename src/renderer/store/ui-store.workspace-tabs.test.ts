import { beforeEach, describe, expect, it } from 'vitest';

import {
  CREATE_TAB_ID,
  focusedLeafOf,
  persistableTabsByProject,
  tabKey,
  useUiStore,
} from './ui-store';

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

  it('opens one create draft per project at the end and preserves its choices', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.openCreateTab('project-a');
    useUiStore.getState().updateCreateTabDraft('project-a', {
      step: 'context',
      entityKind: 'chapter',
      storylineId: 'story-a',
    });
    useUiStore.getState().openCreateTab('project-a');

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map(tabKey)).toEqual([
      'node:chapter-a',
      `create:${CREATE_TAB_ID}`,
    ]);
    expect(project.activeTabKey).toBe(`create:${CREATE_TAB_ID}`);
    expect(project.openTabs[1]).toMatchObject({
      kind: 'create',
      draft: { entityKind: 'chapter', storylineId: 'story-a' },
    });
  });

  it('keeps the create draft last when normal entity navigation adds a tab', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.openCreateTab('project-a');
    useUiStore
      .getState()
      .openEntityTab('project-a', { entityType: 'storyline', id: 'story-a' }, { preview: false });

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map(tabKey)).toEqual([
      'node:chapter-a',
      'storyline:story-a',
      `create:${CREATE_TAB_ID}`,
    ]);
    expect(project.activeTabKey).toBe('storyline:story-a');
  });

  it('closes an active create draft using the existing right-then-left successor rule', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.openCreateTab('project-a');

    const result = useUiStore
      .getState()
      .closeTab('project-a', { createId: CREATE_TAB_ID });

    expect(result).toMatchObject({ wasActive: true });
    expect(result.nextActive).toMatchObject({ entityType: 'node', id: 'chapter-a' });
    expect(useUiStore.getState().tabsByProject['project-a'].openTabs.map(tabKey)).toEqual([
      'node:chapter-a',
    ]);
  });

  it('keeps an in-flight create draft safe from direct and bulk close actions', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.openCreateTab('project-a');
    useUiStore.getState().updateCreateTabDraft('project-a', { status: 'creating' });

    useUiStore.getState().closeTab('project-a', { createId: CREATE_TAB_ID });
    useUiStore.getState().closeOtherTabs('project-a', 'node:chapter-a');
    useUiStore.getState().closeTabsToRight('project-a', 'node:chapter-a');
    useUiStore.getState().closeAllTabs('project-a');

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map(tabKey)).toEqual([`create:${CREATE_TAB_ID}`]);
    expect(project.activeTabKey).toBe(`create:${CREATE_TAB_ID}`);
    expect(project.openTabs[0]).toMatchObject({
      kind: 'create',
      draft: { status: 'creating' },
    });
  });

  it('replaces an active create draft in place with a dedicated entity leaf', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.openCreateTab('project-a');

    const result = useUiStore
      .getState()
      .replaceCreateTabWithEntity('project-a', { entityType: 'element', id: 'element-a' });
    const project = useUiStore.getState().tabsByProject['project-a'];

    expect(result).toEqual({ replaced: true, wasActive: true });
    expect(project.openTabs.map(tabKey)).toEqual(['node:chapter-a', 'element:element-a']);
    expect(project.activeTabKey).toBe('element:element-a');
    expect(project.openTabs[1]).toMatchObject({ kind: 'leaf', isPreview: false });
  });

  it('does not steal focus when a background create draft completes', () => {
    const store = useUiStore.getState();
    store.openCreateTab('project-a');
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });

    const result = useUiStore
      .getState()
      .replaceCreateTabWithEntity('project-a', { entityType: 'storyline', id: 'story-a' });
    const project = useUiStore.getState().tabsByProject['project-a'];

    expect(result).toEqual({ replaced: true, wasActive: false });
    expect(project.openTabs.map(tabKey)).toEqual(['node:chapter-a', 'storyline:story-a']);
    expect(project.activeTabKey).toBe('node:chapter-a');
  });

  it('preserves the live create draft while pruning stale workspace entities', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'stale-node' }, { preview: false });
    store.openCreateTab('project-a');
    useUiStore.getState().pruneProjectTabs('project-a', {
      nodeIds: new Set(),
      storylineIds: new Set(),
      elementIds: new Set(),
      categoryIds: new Set(),
    });

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map(tabKey)).toEqual([`create:${CREATE_TAB_ID}`]);
    expect(project.activeTabKey).toBe(`create:${CREATE_TAB_ID}`);
    expect(focusedLeafOf(project.openTabs[0])).toBeNull();
  });

  it('filters create drafts and their active key from persisted ui state', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.openCreateTab('project-a');

    const persisted = persistableTabsByProject(useUiStore.getState().tabsByProject);

    expect(persisted['project-a'].openTabs.map(tabKey)).toEqual(['node:chapter-a']);
    expect(persisted['project-a'].activeTabKey).toBe('node:chapter-a');
  });

  it('never folds the transient draft into a split', () => {
    const store = useUiStore.getState();
    store.openCreateTab('project-a');
    store.splitActiveWith(
      'project-a',
      { entityType: 'node', id: 'chapter-a' },
      'right',
    );

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map((tab) => tab.kind)).toEqual(['leaf', 'create']);
    expect(project.openTabs.map(tabKey)).toEqual([
      'node:chapter-a',
      `create:${CREATE_TAB_ID}`,
    ]);
  });
});
