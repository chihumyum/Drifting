import { beforeEach, describe, expect, it } from 'vitest';

import {
  CREATE_TAB_ID,
  focusedLeafOf,
  planWorkspaceTabClose,
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
      isPreview: true,
      draft: { entityKind: 'chapter', storylineId: 'story-a' },
    });
  });

  it.each(['node', 'element', 'storyline', 'category', 'all-chapters'] as const)(
    'replaces an idle create preview in place when opening a new %s preview',
    (entityType) => {
      const store = useUiStore.getState();
      store.openEntityTab('project-a', { entityType: 'node', id: 'pinned' }, { preview: false });
      store.openCreateTab('project-a');
      store.updateCreateTabDraft('project-a', { step: 'context', entityKind: 'element', categoryId: 'category-a' });
      store.openEntityTab('project-a', { entityType, id: 'self' });

      const project = useUiStore.getState().tabsByProject['project-a'];
      expect(project.openTabs.map(tabKey)).toEqual(['node:pinned', `${entityType}:self`]);
      expect(project.activeTabKey).toBe(`${entityType}:self`);
      expect(project.openTabs[1]).toMatchObject({ kind: 'leaf', isPreview: true });
    },
  );

  it('shares one preview slot when entering create from an entity preview', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'pinned-a' }, { preview: false });
    store.openEntityTab('project-a', { entityType: 'node', id: 'preview' });
    store.openEntityTab('project-a', { entityType: 'node', id: 'pinned-b' }, { preview: false });
    store.setActiveTab('project-a', { entityType: 'node', id: 'preview' });
    store.openCreateTab('project-a');

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map(tabKey)).toEqual(['node:pinned-a', 'node:pinned-b', `create:${CREATE_TAB_ID}`]);
    expect(project.openTabs[2]).toMatchObject({ isPreview: true });
    expect(project.activeTabKey).toBe(`create:${CREATE_TAB_ID}`);
    expect(project.lastActiveContentTabKey).toBe('node:pinned-b');
    // The replaced preview no longer owns a tab; closing falls back to a survivor.
    expect(store.closeTab('project-a', { createId: CREATE_TAB_ID }).nextActive).toMatchObject({ id: 'pinned-b' });
  });

  it('replaces a background create preview after switching to Home or an existing tab', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'pinned' }, { preview: false });
    store.openCreateTab('project-a');
    store.activateExistingTarget('project-a', { entityType: 'node', id: 'pinned' });
    store.setActiveTab('project-a', null);
    expect(useUiStore.getState().tabsByProject['project-a'].openTabs[1]).toMatchObject({ kind: 'create', isPreview: true });
    store.openEntityTab('project-a', { entityType: 'element', id: 'element-a' });
    expect(useUiStore.getState().tabsByProject['project-a'].openTabs.map(tabKey)).toEqual(['node:pinned', 'element:element-a']);
  });

  it.each(['explicit', 'active'] as const)('preserves the create choices after %s promotion and later previews', (promotion) => {
    const store = useUiStore.getState();
    store.openCreateTab('project-a');
    store.updateCreateTabDraft('project-a', { step: 'context', entityKind: 'chapter', storylineId: 'story-a' });
    store.promoteTab('project-a', promotion === 'explicit' ? { createId: CREATE_TAB_ID } : undefined);
    store.openEntityTab('project-a', { entityType: 'node', id: 'preview-a' });
    store.openEntityTab('project-a', { entityType: 'node', id: 'preview-b' });
    store.openCreateTab('project-a');

    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.openTabs.map(tabKey)).toEqual(['node:preview-b', `create:${CREATE_TAB_ID}`]);
    expect(project.openTabs[1]).toMatchObject({
      kind: 'create', isPreview: false,
      draft: { entityKind: 'chapter', storylineId: 'story-a' },
    });
    expect(project.activeTabKey).toBe(`create:${CREATE_TAB_ID}`);
  });

  it.each(['success', 'failure'] as const)('pins a submitting create draft before navigation and retains its %s', (outcome) => {
    const store = useUiStore.getState();
    store.openCreateTab('project-a');
    store.updateCreateTabDraft('project-a', { status: 'creating' });
    store.openEntityTab('project-a', { entityType: 'node', id: 'preview-a' });
    expect(useUiStore.getState().tabsByProject['project-a'].openTabs[1]).toMatchObject({
      kind: 'create', isPreview: false, draft: { status: 'creating' },
    });

    if (outcome === 'success') {
      expect(store.replaceCreateTabWithEntity('project-a', { entityType: 'element', id: 'created' })).toEqual({ replaced: true, wasActive: false });
    } else {
      store.updateCreateTabDraft('project-a', { status: 'idle', error: 'Synthetic failure' });
    }
    store.openEntityTab('project-a', { entityType: 'node', id: 'preview-b' });
    const project = useUiStore.getState().tabsByProject['project-a'];
    expect(project.activeTabKey).toBe('node:preview-b');
    expect(project.openTabs[1]).toMatchObject(outcome === 'success'
      ? { kind: 'leaf', id: 'created', isPreview: false }
      : { kind: 'create', isPreview: false, draft: { status: 'idle', error: 'Synthetic failure' } });
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

  it('returns an active create draft to the content tab that opened it', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-b' }, { preview: false });
    store.setActiveTab('project-a', { entityType: 'node', id: 'chapter-a' });
    store.openCreateTab('project-a');

    const result = useUiStore
      .getState()
      .closeTab('project-a', { createId: CREATE_TAB_ID });

    expect(result).toMatchObject({ wasActive: true });
    expect(result.nextActive).toMatchObject({ entityType: 'node', id: 'chapter-a' });
    expect(useUiStore.getState().tabsByProject['project-a'].openTabs.map(tabKey)).toEqual([
      'node:chapter-a',
      'node:chapter-b',
    ]);
    expect(useUiStore.getState().tabsByProject['project-a'].activeTabKey).toBe('node:chapter-a');
  });

  it('returns an active create draft to Project Home even when background tabs remain', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.setActiveTab('project-a', null);
    store.openCreateTab('project-a');

    const createTab = useUiStore
      .getState()
      .tabsByProject['project-a'].openTabs.find((tab) => tab.kind === 'create');
    expect(createTab).toMatchObject({ returnTabKey: null });

    const result = useUiStore
      .getState()
      .closeTab('project-a', { createId: CREATE_TAB_ID });
    const project = useUiStore.getState().tabsByProject['project-a'];

    expect(result).toEqual({ nextActive: null, wasActive: true });
    expect(project.openTabs.map(tabKey)).toEqual(['node:chapter-a']);
    expect(project.activeTabKey).toBeNull();
  });

  it('plans the create return route without unmounting the active draft', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.setActiveTab('project-a', null);
    store.openCreateTab('project-a');

    const before = useUiStore.getState().tabsByProject['project-a'];
    const plan = planWorkspaceTabClose(before, `create:${CREATE_TAB_ID}`);
    const after = useUiStore.getState().tabsByProject['project-a'];

    expect(plan).toMatchObject({
      nextActiveTabKey: null,
      nextActive: null,
      wasActive: true,
    });
    expect(after.activeTabKey).toBe(`create:${CREATE_TAB_ID}`);
    expect(after.openTabs.map(tabKey)).toEqual(['node:chapter-a', `create:${CREATE_TAB_ID}`]);
  });

  it('refreshes the create return target when an existing draft is reopened', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.openCreateTab('project-a');
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-b' }, { preview: false });
    store.openCreateTab('project-a');

    const createTab = useUiStore
      .getState()
      .tabsByProject['project-a'].openTabs.find((tab) => tab.kind === 'create');
    expect(createTab).toMatchObject({ returnTabKey: 'node:chapter-b' });

    const result = useUiStore
      .getState()
      .closeTab('project-a', { createId: CREATE_TAB_ID });
    expect(result.nextActive).toMatchObject({ entityType: 'node', id: 'chapter-b' });
    expect(useUiStore.getState().tabsByProject['project-a'].activeTabKey).toBe('node:chapter-b');
  });

  it('restores the exact split and focused leaf that opened the create draft', () => {
    const store = useUiStore.getState();
    store.openEntityTab('project-a', { entityType: 'node', id: 'chapter-a' }, { preview: false });
    store.splitActiveWith('project-a', { entityType: 'node', id: 'chapter-b' }, 'right');
    const before = useUiStore.getState().tabsByProject['project-a'];
    const returnTabKey = before.activeTabKey;
    const returnTab = before.openTabs.find((tab) => tabKey(tab) === returnTabKey);
    const returnLeaf = returnTab ? focusedLeafOf(returnTab) : null;
    expect(returnTabKey).toMatch(/^split:/);
    expect(returnLeaf).not.toBeNull();

    useUiStore.getState().openCreateTab('project-a');
    const result = useUiStore
      .getState()
      .closeTab('project-a', { createId: CREATE_TAB_ID });
    const after = useUiStore.getState().tabsByProject['project-a'];

    expect(after.activeTabKey).toBe(returnTabKey);
    expect(result.nextActive).toMatchObject({
      entityType: returnLeaf?.entityType,
      id: returnLeaf?.id,
    });
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
    expect(persisted['project-a'].activeTabKey).toBeNull();
    expect(persisted['project-a'].lastActiveContentTabKey).toBe('node:chapter-a');
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
