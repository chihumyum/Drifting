import { describe, expect, it } from 'vitest';
import { createSyntheticWorkspaceProjection } from '../../../performance/fixture';
import type { AnyTab, LeafTab } from '../../../store/ui-store';
import { createTopTabPresentationSelector, leafPresentationKey } from './top-tab-presentation';

const leaf = (entityType: LeafTab['entityType'], id: string): LeafTab => ({ kind: 'leaf', entityType, id, isPreview: false });
function fixture() {
  const data = createSyntheticWorkspaceProjection('synthetic-tabs', 100, 100);
  data.storylines = [{ id: 'story', projectId: 'synthetic-tabs', name: 'Story', color: '#112233', summary: '',
    contentJson: '{}', kvJson: '[]', nodeContentTemplateJson: '{}', orderKey: 0, createdAt: '', updatedAt: '' }];
  data.primaryStorylineByNode = { 'synthetic-node-99': 'story' };
  return { ...data, workspaceProjectId: 'synthetic-tabs', workspaceProjectionGeneration: 'generation-1' };
}
const nodeTab = leaf('node', 'synthetic-node-99');
const elementTab = leaf('element', 'synthetic-element-99');
const selector = (tabs: AnyTab[] = [nodeTab, elementTab]) => createTopTabPresentationSelector('synthetic-tabs', tabs);
describe('open-tab semantic presentation', () => {
  it('keeps the same projection for metrics, prose, positions and names outside open tabs', () => {
    const data = fixture(); const select = selector(); const initial = select(data);
    const next = { ...data, bookNodes: data.bookNodes.map(node => ({ ...node, wordCount: 10, summary: 'Changed', position: { x: 10, y: 20 } })),
      bookElements: data.bookElements.map(element => ({ ...element, contentJson: '{changed}', name: element.id === elementTab.id ? element.name : 'Other name' })) };
    expect(select(next)).toBe(initial);
    expect(select({ ...next, bookNodes: next.bookNodes.map((node, index) => index === 0 ? { ...node, title: 'Not open' } : node) })).toBe(initial);
  });
  it('renames an open node without invalidating appearances', () => {
    const data = fixture(); const select = selector(); const before = select(data);
    const after = select({ ...data, bookNodes: data.bookNodes.map(node => node.id === nodeTab.id ? { ...node, title: 'Renamed' } : node) });
    expect(after.labels).not.toBe(before.labels); expect(after.appearances).toBe(before.appearances);
    expect(after.labels.get(leafPresentationKey(nodeTab))?.title).toBe('Renamed');
  });
  it('changes primary storyline and category colors without invalidating labels', () => {
    const data = fixture(); const select = selector(); const before = select(data);
    const after = select({ ...data, storylines: data.storylines.map(line => ({ ...line, color: '#445566' })),
      bookElementCategories: data.bookElementCategories.map(category => ({ ...category, color: '#778899' })) });
    expect(after.labels).toBe(before.labels); expect(after.appearances).not.toBe(before.appearances);
    expect(after.appearances.get(leafPresentationKey(nodeTab))?.color).toBe('#445566');
    expect(after.appearances.get(leafPresentationKey(elementTab))?.color).toBe('#778899');
  });
  it('updates memberships and nullable categories while preserving labels', () => {
    const data = fixture(); const select = selector(); const before = select(data);
    const after = select({ ...data, primaryStorylineByNode: {}, bookElements: data.bookElements.map(element => ({ ...element, categoryId: null })) });
    expect(after.labels).toBe(before.labels);
    expect([...after.appearances.values()]).toEqual([{ color: undefined, isDrift: false }, { color: undefined, isDrift: false }]);
    // Preserve first-match string-id semantics; only null means no category.
    const emptyId = select({ ...data, bookElements: data.bookElements.map(element => ({ ...element, categoryId: '' })),
      bookElementCategories: data.bookElementCategories.map(category => ({ ...category, id: '' })) });
    expect(emptyId.appearances.get(leafPresentationKey(elementTab))?.color).toBe('#112233');
  });
  it('preserves chapter/drift fallback and glyph semantics when a title is empty', () => {
    const data = fixture(); data.bookNodes[99] = { ...data.bookNodes[99], title: '', kind: 'drift', bookOrder: null, writingStatus: 'drifting' };
    const select = selector(); const after = select(data);
    expect(after.labels.get(leafPresentationKey(nodeTab))).toEqual({ title: '', fallback: 'drift' });
    expect(after.appearances.get(leafPresentationKey(nodeTab))?.isDrift).toBe(true);
    const missing = select({ ...data, bookNodes: [] });
    expect(missing.labels.get(leafPresentationKey(nodeTab))).toEqual({ title: '', fallback: 'chapter' });
    expect(missing.appearances.get(leafPresentationKey(nodeTab))).toEqual({ color: undefined, isDrift: false });
  });
  it('includes both split leaves and singleton, storyline and category labels', () => {
    const tabs: AnyTab[] = [{ kind: 'split', id: 'split', left: nodeTab, right: elementTab, focused: 'left', splitRatio: 0.5 },
      leaf('storyline', 'story'), leaf('category', 'synthetic-category'), leaf('all-chapters', 'self')];
    const result = selector(tabs)(fixture()); expect(result.labels.size).toBe(5);
    expect(result.labels.get(leafPresentationKey(tabs[1] as LeafTab))).toEqual({ title: 'Story', fallback: 'storyline' });
    expect(result.labels.get(leafPresentationKey(tabs[3] as LeafTab))).toEqual({ title: '', fallback: 'all-chapters' });
  });
  it('deduplicates repeated split leaves and ignores the create draft contents', () => {
    const tabs: AnyTab[] = [nodeTab, { kind: 'split', id: 'split', left: nodeTab, right: elementTab, focused: 'left', splitRatio: 0.5 },
      { kind: 'create', id: 'universal-new', returnTabKey: null, draft: { step: 'kind', entityKind: null, storylineId: null,
        driftGroupId: null, categoryId: null, elementGroupName: null, status: 'idle', error: null } }];
    expect(selector(tabs)(fixture()).labels.size).toBe(2);
  });
  it('releases identical display projections across committed generations', () => {
    const data = fixture(); const select = selector(); const before = select(data);
    const after = select({ ...data, workspaceProjectionGeneration: 'generation-2' });
    expect(after).not.toBe(before); expect(after.labels).not.toBe(before.labels); expect(after.appearances).not.toBe(before.appearances);
  });
  it('never uses another project or an uncommitted projection for matching ids', () => {
    const data = fixture(); const select = selector(); const before = select(data);
    for (const unavailable of [{ ...data, workspaceProjectId: 'other' }, { ...data, workspaceProjectionGeneration: null as string | null }]) {
      const after = select(unavailable); expect(after.projectId).toBeNull();
      expect([...after.labels.values()].every(value => value.title === '')).toBe(true);
      expect([...after.appearances.values()].every(value => value.color === undefined)).toBe(true);
    }
    const returned = select(data); expect(returned).not.toBe(before); expect(returned.labels).toEqual(before.labels);
  });
  it('shares the first-match index across independent selectors of the same snapshot', () => {
    const data = fixture(); let visits = 0;
    data.bookNodes = data.bookNodes.map(node => ({ ...node, get id() { visits++; return node.id; } }));
    const a = selector([nodeTab]); const b = selector([nodeTab]);
    a(data); b(data); expect(visits).toBe(102); // One N-row index, one node id per selector's primary lookup.
    a(data); b(data); expect(visits).toBe(102);
  });
  it('invalidates deleted and restored targets and retains no missing title', () => {
    const data = fixture(); const select = selector(); const initial = select(data);
    const removed = select({ ...data, bookElements: [] });
    expect(removed.labels.get(leafPresentationKey(elementTab))?.title).toBe('');
    expect(select(data).labels).toEqual(initial.labels);
  });
});
