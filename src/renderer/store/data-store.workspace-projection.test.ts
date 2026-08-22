import { beforeEach, describe, expect, it } from 'vitest';

import type { BookNode } from '../domain/book-node';
import { useDataStore, type WorkspaceDataProjection } from './data-store';

function node(projectId: string, id: string): BookNode {
  return {
    id,
    projectId,
    title: id,
    summary: '',
    kind: 'chapter',
    bookOrder: 1,
    narrativeOrder: 1,
    driftGroupId: null,
    position: { x: 0, y: 0 },
    wordCount: 0,
    writingStatus: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function projection(projectId: string, nodeId: string): WorkspaceDataProjection {
  return {
    storylines: [],
    storylineNodeMapping: {},
    primaryStorylineByNode: {},
    bookNodes: [node(projectId, nodeId)],
    bookElementCategories: [],
    bookElements: [],
    projectAssets: [],
    trashedEntityIds: new Set(),
    libraryItems: [],
    comments: [],
    commentActions: [],
    entityRelations: [],
    entityRelationTypes: [],
    blockSections: [],
    bookActs: [],
    driftGroups: [],
    timelineMarkers: [],
  };
}

describe('workspace projection authority', () => {
  beforeEach(() => {
    const epoch = useDataStore.getState().requestWorkspaceProjection('reset', 'loading');
    useDataStore.getState().commitWorkspaceProjection('reset', epoch, projection('reset', 'reset'));
  });

  it('rejects a slow project capture after a newer project route owns the epoch', () => {
    const projectAEpoch = useDataStore
      .getState()
      .requestWorkspaceProjection('project-a', 'loading');
    const projectBEpoch = useDataStore
      .getState()
      .requestWorkspaceProjection('project-b', 'loading');

    expect(
      useDataStore
        .getState()
        .commitWorkspaceProjection('project-a', projectAEpoch, projection('project-a', 'node-a')),
    ).toBe(false);
    expect(
      useDataStore
        .getState()
        .commitWorkspaceProjection('project-b', projectBEpoch, projection('project-b', 'node-b')),
    ).toBe(true);

    const state = useDataStore.getState();
    expect(state.workspaceProjectId).toBe('project-b');
    expect(state.bookNodes.map((item) => item.id)).toEqual(['node-b']);
  });

  it('keeps the last complete project visible until one atomic refresh commit', () => {
    const initialEpoch = useDataStore
      .getState()
      .requestWorkspaceProjection('project-a', 'loading');
    useDataStore
      .getState()
      .commitWorkspaceProjection('project-a', initialEpoch, projection('project-a', 'old-node'));

    const refreshEpoch = useDataStore
      .getState()
      .requestWorkspaceProjection('project-a', 'refreshing');
    expect(useDataStore.getState().bookNodes[0]?.id).toBe('old-node');
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('refreshing');

    const observed: string[][] = [];
    const unsubscribe = useDataStore.subscribe((state) => {
      observed.push(state.bookNodes.map((item) => item.id));
    });
    useDataStore
      .getState()
      .commitWorkspaceProjection('project-a', refreshEpoch, projection('project-a', 'new-node'));
    unsubscribe();

    expect(observed).toEqual([['new-node']]);
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('ready');
  });

  it('clears only the authoritative missing-project projection', () => {
    const projectAEpoch = useDataStore
      .getState()
      .requestWorkspaceProjection('project-a', 'loading');
    useDataStore
      .getState()
      .commitWorkspaceProjection('project-a', projectAEpoch, projection('project-a', 'node-a'));

    const missingEpoch = useDataStore
      .getState()
      .requestWorkspaceProjection('project-a', 'refreshing');
    expect(useDataStore.getState().clearWorkspaceProjection('project-a', missingEpoch)).toBe(true);

    const cleared = useDataStore.getState();
    expect(cleared.workspaceProjectId).toBeNull();
    expect(cleared.workspaceRequestedProjectId).toBeNull();
    expect(cleared.workspaceProjectionStatus).toBe('idle');
    expect(cleared.bookNodes).toEqual([]);

    const staleProjectEpoch = useDataStore
      .getState()
      .requestWorkspaceProjection('project-a', 'loading');
    useDataStore.getState().requestWorkspaceProjection('project-b', 'loading');
    expect(
      useDataStore.getState().clearWorkspaceProjection('project-a', staleProjectEpoch),
    ).toBe(false);
    expect(useDataStore.getState().workspaceRequestedProjectId).toBe('project-b');
  });
});
