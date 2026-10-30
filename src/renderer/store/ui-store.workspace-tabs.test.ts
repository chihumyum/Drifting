import { beforeEach, describe, expect, it } from 'vitest';

import {
  persistableTabsByProject,
  sanitizePersistedTabsByProject,
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
      libraryItemIds: new Set(),
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
      libraryItemIds: new Set(),
    });
    expect(useUiStore.getState().tabsByProject['project-b']?.openTabs.map(tabKey)).toEqual([
      'node:node-b',
    ]);
  });

  it('drops a retired 新建… tab left in old storage', () => {
    const migrated = sanitizePersistedTabsByProject({
      project: {
        openTabs: [
          { kind: 'leaf', entityType: 'node', id: 'chapter-a', isPreview: false },
          { kind: 'create', id: 'universal-new', isPreview: true, returnTabKey: null },
        ],
        activeTabKey: 'create:universal-new',
        lastActiveContentTabKey: 'node:chapter-a',
      },
    }).project;

    expect(migrated.openTabs.map(tabKey)).toEqual(['node:chapter-a']);
    expect(migrated.activeTabKey).toBeNull();
    expect(migrated.lastActiveContentTabKey).toBe('node:chapter-a');
  });

  it('appends a dedicated tab at the end of the strip', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: true });
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-b' }, { preview: false });
    store.openEntityTab('project-a', { entityType: 'element', id: 'created' }, { preview: false });

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map(tabKey)).toEqual(['node:chapter-a', 'node:chapter-b', 'element:created']);
    expect(project.activeTabKey).toBe('element:created');
    const persisted = persistableTabsByProject(useUiStore.getState().tabsByProject);
    expect(persisted['project-a'].openTabs.map(tabKey)).toEqual(project.openTabs.map(tabKey));
  });

  it('counts every arrival at Project Home and remembers how the author came', () => {
    const before = useUiStore.getState().projectHomeEntry.seq;
    useUiStore.getState().markProjectHomeEntry('new');
    expect(useUiStore.getState().projectHomeEntry).toEqual({ intent: 'new', seq: before + 1 });
    useUiStore.getState().markProjectHomeEntry('home');
    expect(useUiStore.getState().projectHomeEntry).toEqual({ intent: 'home', seq: before + 2 });
  });

  it('keeps Project Home outside the tab collection while preserving background tabs', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.setActiveTab('project-a', null);

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map(tabKey)).toEqual(['node:chapter-a']);
    expect(project.activeTabKey).toBeNull();
    expect(project.lastActiveContentTabKey).toBe('node:chapter-a');
  });

  it('activates an existing split side without creating a duplicate preview', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'a' }, { preview: false });
    store.splitActiveWith('project-a', { entityType: 'node', id: 'b' }, 'right');
    expect(store.activateExistingTarget('project-a', { entityType: 'node', id: 'a' })).toBe(true);
    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs).toHaveLength(1);
    expect(project.openTabs[0]).toMatchObject({ kind: 'split', focused: 'left' });
  });

  it('migrates legacy dashboard leaves and mixed splits into Project Home state', () => {
    const migrated = sanitizePersistedTabsByProject({
      project: {
        openTabs: [
          { kind: 'leaf', entityType: 'node', id: 'left', isPreview: false },
          { kind: 'leaf', entityType: 'dashboard', id: 'self', isPreview: false },
          {
            kind: 'split',
            id: 'legacy',
            left: { kind: 'leaf', entityType: 'dashboard', id: 'self', isPreview: false },
            right: { kind: 'leaf', entityType: 'storyline', id: 'story', isPreview: true },
            focused: 'left',
            splitRatio: 0.5,
          },
        ],
        activeTabKey: 'split:legacy',
      },
    }).project;

    expect(migrated.openTabs.map(tabKey)).toEqual(['node:left', 'storyline:story']);
    expect(migrated.openTabs[1]).toMatchObject({ kind: 'leaf', isPreview: false });
    expect(migrated.activeTabKey).toBeNull();
    expect(migrated.lastActiveContentTabKey).toBe('storyline:story');
  });
});
