import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDataProjection } from './data-store';
import { shareWorkspaceProjection } from './workspace-projection-sharing';
import { createWorkspaceSharingFixture } from '../performance/workspace-fixture';

const fixture = () => createWorkspaceSharingFixture('synthetic-project', 20);
const keys = (data: WorkspaceDataProjection) => Object.keys(data) as (keyof WorkspaceDataProjection)[];

describe('complete workspace capture sharing', () => {
  it('reuses every unchanged slice and row without parsing or stringifying body JSON', () => {
    const before = fixture(); const next = structuredClone(before);
    const stringify = vi.spyOn(JSON, 'stringify'); const parse = vi.spyOn(JSON, 'parse');
    let shared: WorkspaceDataProjection;
    try {
      shared = shareWorkspaceProjection(before, next);
      expect(stringify).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); parse.mockRestore(); }
    for (const key of keys(before)) expect(shared![key], key).toBe(before[key]);
    expect(shared!).toEqual(next);
  });

  const changes: { key: keyof WorkspaceDataProjection; change: (data: WorkspaceDataProjection) => void }[] = [
    { key: 'storylines', change: (data) => { data.storylines[0].contentJson = '{"changed":true}'; } },
    { key: 'storylineNodeMapping', change: (data) => { data.storylineNodeMapping.main.pop(); } },
    { key: 'primaryStorylineByNode', change: (data) => { data.primaryStorylineByNode['synthetic-node-0'] = 'support'; } },
    { key: 'bookNodes', change: (data) => { data.bookNodes[0].position.x = 0.125; } },
    { key: 'bookElementCategories', change: (data) => { data.bookElementCategories[0].elementTemplateKvJson = '[{"key":"a"}]'; } },
    { key: 'bookElements', change: (data) => { data.bookElements[0].aliases.reverse(); data.bookElements[0].aliases.push('合成新别名'); } },
    { key: 'projectAssets', change: (data) => { data.projectAssets[0].sourceSha256 = '1'.repeat(64); } },
    { key: 'trashedEntityIds', change: (data) => { data.trashedEntityIds.clear(); } },
    { key: 'libraryItems', change: (data) => { data.libraryItems[0].bodyJson = '{"changed":true}'; } },
    { key: 'comments', change: (data) => { data.comments[0].bodyJson = '{"changed":true}'; } },
    { key: 'commentActions', change: (data) => { data.commentActions[0].resultJson = '{"changed":true}'; } },
    { key: 'entityRelations', change: (data) => { data.entityRelations[0].toId = 'synthetic-node-1'; } },
    { key: 'entityRelationTypes', change: (data) => { data.entityRelationTypes[0].targetKinds.reverse(); } },
    { key: 'blockSections', change: (data) => { data.blockSections[0].blockHashes['synthetic-block'] = 'changed'; } },
    { key: 'bookActs', change: (data) => { data.bookActs[0].startOrder = 0.125; } },
    { key: 'driftGroups', change: (data) => { data.driftGroups[0].color = '#445566'; } },
    { key: 'timelineMarkers', change: (data) => { data.timelineMarkers[0].driftNodeId = 'synthetic-drift'; } },
  ];
  it.each(changes)('keeps the new $key value even when timestamps are unchanged', ({ key, change }) => {
    const before = fixture(); const next = structuredClone(before); change(next);
    const shared = shareWorkspaceProjection(before, next);
    expect(shared[key]).not.toBe(before[key]); expect(shared).toEqual(next);
    for (const other of keys(before).filter((candidate) => candidate !== key)) expect(shared[other], other).toBe(before[other]);
  });

  it('retains record identity through insertion/reordering/deletion without altering either input', () => {
    const before = fixture(); const expectedBefore = structuredClone(before);
    const next = structuredClone(before);
    next.bookNodes = [next.bookNodes[2], { ...next.bookNodes[0], id: 'inserted' }, next.bookNodes[0]];
    const expectedNext = structuredClone(next); const shared = shareWorkspaceProjection(before, next);
    expect(shared.bookNodes.map((node) => node.id)).toEqual(['synthetic-node-2', 'inserted', 'synthetic-node-0']);
    expect(shared.bookNodes[0]).toBe(before.bookNodes[2]); expect(shared.bookNodes[2]).toBe(before.bookNodes[0]);
    expect(before).toEqual(expectedBefore); expect(next).toEqual(expectedNext);
  });

  it('preserves observable map/set order and reuses unaffected membership arrays', () => {
    const before = fixture(); const next = structuredClone(before);
    next.storylineNodeMapping = { support: next.storylineNodeMapping.support, main: next.storylineNodeMapping.main };
    next.storylineNodeMapping.main = next.storylineNodeMapping.main.slice(1);
    const shared = shareWorkspaceProjection(before, next);
    expect(Object.keys(shared.storylineNodeMapping)).toEqual(['support', 'main']);
    expect(shared.storylineNodeMapping.support).toBe(before.storylineNodeMapping.support);
    before.trashedEntityIds = new Set(['a', 'b']); next.trashedEntityIds = new Set(['b', 'a']);
    expect([...shareWorkspaceProjection(before, next).trashedEntityIds]).toEqual(['b', 'a']);
  });

  it('does not hide optional/new fields or conflate unsupported object values', () => {
    const before = fixture(); const next = structuredClone(before);
    next.bookNodes[0].wordCountBasisHash = undefined;
    expect(shareWorkspaceProjection(before, next).bookNodes[0]).not.toBe(before.bookNodes[0]);
    Object.assign(before.bookNodes[1], { futureValue: new Date(0) });
    Object.assign(next.bookNodes[1], { futureValue: new Date(1) });
    const shared = shareWorkspaceProjection(before, next);
    expect(shared.bookNodes[1]).toBe(next.bookNodes[1]);
    before.bookElements[0].aliases = new Array<string>(1);
    next.bookElements[0].aliases = ['新别名'];
    expect(shareWorkspaceProjection(before, next).bookElements[0]).toBe(next.bookElements[0]);
  });

  it('keeps comparison work linear in record count', () => {
    const before = createWorkspaceSharingFixture('synthetic-large', 1_000); const next = structuredClone(before);
    let reads = 0;
    for (const data of [before, next]) for (const node of data.bookNodes) {
      const title = node.title; Object.defineProperty(node, 'title', { enumerable: true, get: () => { reads++; return title; } });
    }
    expect(shareWorkspaceProjection(before, next).bookNodes).toBe(before.bookNodes);
    expect(reads).toBe(2_000);
  });
});
