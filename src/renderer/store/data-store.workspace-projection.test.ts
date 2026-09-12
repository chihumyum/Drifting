import { beforeEach, describe, expect, it } from 'vitest';

import type { BookNode } from '../domain/book-node';
import { useDataStore, type WorkspaceDataProjection } from './data-store';
import { createWorkspaceSharingFixture } from '../performance/workspace-fixture';

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

  it('shares unchanged records while publishing a changed relation and primary membership atomically', () => {
    const initial = createWorkspaceSharingFixture('project-a', 20);
    const epoch = useDataStore.getState().requestWorkspaceProjection('project-a', 'loading');
    useDataStore.getState().commitWorkspaceProjection('project-a', epoch, initial);
    const before = useDataStore.getState(); const next = structuredClone(initial);
    next.storylineNodeMapping.main = next.storylineNodeMapping.main.slice(1);
    next.primaryStorylineByNode['synthetic-node-0'] = 'support';
    next.entityRelations[0].toId = 'synthetic-node-1';
    const refresh = before.requestWorkspaceProjection('project-a', 'refreshing');
    const observed: unknown[] = [];
    const off = useDataStore.subscribe((state) => observed.push({
      primary: state.primaryStorylineByNode['synthetic-node-0'],
      reverse: state.nodeStorylineMapping['synthetic-node-0'], target: state.entityRelations[0]?.toId,
    }));
    useDataStore.getState().commitWorkspaceProjection('project-a', refresh, next); off();
    const after = useDataStore.getState();
    expect(observed).toEqual([{ primary: 'support', reverse: ['support'], target: 'synthetic-node-1' }]);
    expect(after.bookNodes).toBe(before.bookNodes);
    expect(after.nodeStorylineMapping['synthetic-node-1']).toBe(before.nodeStorylineMapping['synthetic-node-1']);
  });

  it('sorts markers before sharing and does not reuse a changed record solely by ID or timestamp', () => {
    const initial = createWorkspaceSharingFixture('project-a', 20);
    initial.timelineMarkers.push({ ...initial.timelineMarkers[0], id: 'earlier', narrativeOrder: -0.25 });
    const epoch = useDataStore.getState().requestWorkspaceProjection('project-a', 'loading');
    useDataStore.getState().commitWorkspaceProjection('project-a', epoch, initial);
    const before = useDataStore.getState(); const next = structuredClone(initial);
    next.bookNodes[1].wordCount = 77;
    const refresh = before.requestWorkspaceProjection('project-a', 'refreshing');
    useDataStore.getState().commitWorkspaceProjection('project-a', refresh, next);
    const after = useDataStore.getState();
    expect(after.timelineMarkers).toBe(before.timelineMarkers);
    expect(after.timelineMarkers[0].id).toBe('earlier');
    expect(after.bookNodes[0]).toBe(before.bookNodes[0]); expect(after.bookNodes[1].wordCount).toBe(77);
  });

  it('rejects stale epochs without notifying and clears reverse memberships at project/reset boundaries', () => {
    const initial = createWorkspaceSharingFixture('project-a', 20);
    const epoch = useDataStore.getState().requestWorkspaceProjection('project-a', 'loading');
    useDataStore.getState().commitWorkspaceProjection('project-a', epoch, initial);
    const before = useDataStore.getState();
    const newer = before.requestWorkspaceProjection('project-a', 'refreshing');
    let notifications = 0; const off = useDataStore.subscribe(() => { notifications++; });
    expect(useDataStore.getState().commitWorkspaceProjection('project-a', epoch, structuredClone(initial))).toBe(false);
    expect(useDataStore.getState().clearWorkspaceProjection('project-a', epoch)).toBe(false);
    expect(useDataStore.getState().failWorkspaceProjection('project-a', epoch, 'stale')).toBe(false);
    off(); expect(notifications).toBe(0);
    const otherEpoch = useDataStore.getState().requestWorkspaceProjection('project-b', 'loading');
    expect(useDataStore.getState().nodeStorylineMapping).toEqual({});
    expect(useDataStore.getState().commitWorkspaceProjection('project-a', newer, initial)).toBe(false);
    const other = createWorkspaceSharingFixture('project-b', 20);
    useDataStore.getState().commitWorkspaceProjection('project-b', otherEpoch, other);
    expect(useDataStore.getState().bookNodes[0]).not.toBe(before.bookNodes[0]);
    useDataStore.getState().clearWorkspaceProjection('project-b', otherEpoch);
    expect(useDataStore.getState().nodeStorylineMapping).toEqual({});
  });
});
