import { describe, expect, it } from 'vitest';
import { createSyntheticWorkspaceProjection } from '../performance/fixture';
import { buildEntityAutoDetectTargets, releaseEntityLinkNames, selectEntityLinkNames, selectProseAutoDetectConfig } from './entity-link-names';

function input(projectId = 'synthetic-project') {
  return { ...createSyntheticWorkspaceProjection(projectId, 2, 2), workspaceProjectId: projectId, workspaceProjectionEpoch: 1 };
}

describe('shared entity-link name projection', () => {
  it('selects closed prose sources explicitly and rejects a different project snapshot', () => {
    const state = input();
    const [first, second] = state.bookNodes;
    const config = selectProseAutoDetectConfig(state, true, state.workspaceProjectId, 'node', first.id);
    expect(config.autoDetectTargets.has(first.title)).toBe(false);
    expect(config.autoDetectTargets.get(second.title)?.id).toBe(second.id);
    expect(selectProseAutoDetectConfig(state, false, state.workspaceProjectId, 'node', first.id).autoDetectEnabled).toBe(false);
    const wrong = selectProseAutoDetectConfig(state, true, 'different-project', 'node', first.id);
    expect(wrong.autoDetectEnabled).toBe(false);
    expect(wrong.autoDetectTargets.size).toBe(0);
  });
  it('keeps semantic identity across metrics, summary and body updates', () => {
    const before = input();
    const names = selectEntityLinkNames(before);
    const after = {
      ...before,
      bookNodes: before.bookNodes.map((node) => ({ ...node, wordCount: 100, summary: '合成摘要' })),
      bookElements: before.bookElements.map((element) => ({ ...element, contentJson: '{"type":"doc"}' })),
    };
    expect(selectEntityLinkNames(after)).toBe(names);
    expect(selectEntityLinkNames(before)).toBe(names);
  });

  it('invalidates names, aliases, deletions and project generations independently', () => {
    const before = input();
    const names = selectEntityLinkNames(before);
    for (const after of [
      { ...before, bookNodes: before.bookNodes.map((node) => ({ ...node, title: '更名' })) },
      { ...before, bookElements: before.bookElements.map((element) => ({ ...element, aliases: ['新别名'] })) },
      { ...before, bookElements: [] },
      { ...before, workspaceProjectId: 'another-project' },
      { ...before, workspaceProjectionEpoch: 2 },
    ]) expect(selectEntityLinkNames(after)).not.toBe(names);
    // Going back to an older generation may rebuild identity, never its data.
    const restored = selectEntityLinkNames(before);
    expect(restored).toEqual(names);
    releaseEntityLinkNames('another-project');
    expect(selectEntityLinkNames(before)).toBe(restored);
    // Release the current projection explicitly, even if callers retain arrays.
    const current = input('release-project');
    const held = selectEntityLinkNames(current);
    releaseEntityLinkNames('release-project');
    expect(selectEntityLinkNames(current)).not.toBe(held);
  });

  it('excludes self and parent before resolving aliases and chapter-name collisions', () => {
    const data = input();
    data.bookNodes[0] = { ...data.bookNodes[0], title: data.bookElements[0].name };
    const names = selectEntityLinkNames(data);
    const regular = buildEntityAutoDetectTargets(names, 'node', 'outside');
    expect(regular.get(data.bookElements[0].name)).toEqual({ kind: 'node', id: data.bookNodes[0].id });
    const chapterSelf = buildEntityAutoDetectTargets(names, 'node', data.bookNodes[0].id);
    expect(chapterSelf.get(data.bookElements[0].name)).toEqual({ kind: 'element', id: data.bookElements[0].id });
    const elementSelf = buildEntityAutoDetectTargets(names, 'element', data.bookElements[1].id);
    expect(elementSelf.has(data.bookElements[1].aliases[0])).toBe(false);
    const patch = buildEntityAutoDetectTargets(names, 'patch', 'synthetic-patch', data.bookElements[1].id);
    expect(patch.has(data.bookElements[1].name)).toBe(false);
    expect(patch.has(data.bookElements[1].aliases[0])).toBe(false);
  });

  it('reads unchanged name collections once across metric updates and multiple consumers', () => {
    const before = input();
    let nameReads = 0;
    before.bookElements = before.bookElements.map((element) => ({
      ...element, get name() { nameReads++; return element.name; },
    }));
    const names = selectEntityLinkNames(before);
    const initialReads = nameReads;
    for (let iteration = 0; iteration < 10; iteration++) {
      const after = { ...before, bookNodes: before.bookNodes.map((node) => ({ ...node, wordCount: iteration })) };
      for (let consumer = 0; consumer < 20; consumer++) expect(selectEntityLinkNames(after)).toBe(names);
    }
    expect(nameReads).toBe(initialReads);
  });
});
