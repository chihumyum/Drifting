import { beforeEach, describe, expect, it } from 'vitest';
import {
  persistableTabsByProject, sanitizePersistedTabsByProject, tabKey, useUiStore,
  type SplitTab, type TabRef,
} from './ui-store';

const projectId = 'synthetic-split-preview';
const node = (id: string): TabRef => ({ entityType: 'node', id });
const state = () => useUiStore.getState();
const project = () => state().tabsByProject[projectId];
const split = () => project().openTabs.find((tab): tab is SplitTab => tab.kind === 'split')!;

function createSplit(leftPreview = true, rightPreview = true) {
  state().openEntityTab(projectId, node('left'), { preview: leftPreview });
  state().splitActiveWith(projectId, node('right'), 'right');
  if (!rightPreview) state().promoteTab(projectId);
  return split();
}

beforeEach(() => useUiStore.setState({ tabsByProject: {} }));

describe('independent preview lifecycle in split tabs', () => {
  it.each([true, false])('preserves an existing leaf preview=%s when dragged into a split', (isPreview) => {
    state().openEntityTab(projectId, node('left'), { preview: false });
    state().openEntityTab(projectId, node('right'), { preview: isPreview });
    state().setActiveTab(projectId, node('left'));
    state().splitActiveWith(projectId, { fromKey: 'node:right' }, 'right');
    expect(project().openTabs).toHaveLength(1);
    expect(split()).toMatchObject({ left: { isPreview: false }, right: { isPreview } });
  });

  it('preserves existing states when opening an existing entity to one side', () => {
    state().openEntityTab(projectId, node('right'), { preview: false });
    state().openEntityTab(projectId, node('left'));
    state().splitActiveWith(projectId, node('right'), 'right');
    expect(split()).toMatchObject({ left: { isPreview: true }, right: { isPreview: false } });
  });

  it.each(['left', 'right'] as const)('reuses only the focused %s preview for successive entities', (side) => {
    const original = createSplit();
    state().setSplitRatio(projectId, original.id, 0.35);
    state().setSplitFocus(projectId, original.id, side);
    const other = side === 'left' ? 'right' : 'left';
    for (const id of ['new-a', 'new-b']) {
      state().openEntityTab(projectId, { entityType: 'element', id });
      expect(project().openTabs).toHaveLength(1);
      expect(project().activeTabKey).toBe(tabKey(original));
      expect(split()).toMatchObject({ id: original.id, focused: side, splitRatio: 0.35 });
      expect(split()[side]).toMatchObject({ entityType: 'element', id, isPreview: true });
      expect(split()[other]).toBe(original[other]);
    }
  });

  it.each(['left', 'right'] as const)('keeps a dedicated %s side and the opposite preview when opening elsewhere', (side) => {
    const original = createSplit();
    state().setSplitFocus(projectId, original.id, side);
    state().promoteTab(projectId);
    const pinned = split();
    state().openEntityTab(projectId, node('outside-a'));
    expect(split()).toBe(pinned);
    expect(project().activeTabKey).toBe('node:outside-a');
    expect(project().openTabs).toHaveLength(2);
    // Returning to the dedicated side reuses the ordinary preview slot.
    state().setActiveTab(projectId, { splitId: original.id });
    state().openEntityTab(projectId, node('outside-b'));
    expect(split()).toBe(pinned);
    expect(project().openTabs.map(tabKey)).toEqual([tabKey(original), 'node:outside-b']);
  });

  it('keeps two dedicated split sides intact', () => {
    const original = createSplit(false, false);
    state().openEntityTab(projectId, node('outside'));
    expect(split()).toBe(original);
    expect(project().openTabs.map(tabKey)).toEqual([tabKey(original), 'node:outside']);
  });

  it.each(['focused', 'entity-ref', 'split-side'] as const)('promotes only one side via %s', (method) => {
    const original = createSplit();
    const side = method === 'focused' ? 'right' : 'left';
    state().promoteTab(projectId, method === 'focused' ? undefined
      : method === 'entity-ref' ? node(side) : { splitId: original.id, side });
    expect(split()[side].isPreview).toBe(false);
    expect(split()[side === 'left' ? 'right' : 'left'].isPreview).toBe(true);
    expect(split().focused).toBe('right');
    const pinned = split();
    state().promoteTab(projectId, { splitId: original.id, side });
    expect(split()).toBe(pinned);
  });

  it('does not overwrite a preview on an explicit dedicated open', () => {
    const original = createSplit();
    state().openEntityTab(projectId, node('dedicated'), { preview: false });
    expect(split()).toBe(original);
    expect(project().openTabs[1]).toMatchObject({ id: 'dedicated', isPreview: false });
  });

  it.each(['left', 'right', 'outside'] as const)('activates existing %s without replacing or duplicating a split side', (id) => {
    state().openEntityTab(projectId, node('outside'), { preview: false });
    const original = createSplit();
    state().openEntityTab(projectId, node(id));
    expect(project().openTabs).toHaveLength(2);
    expect(split().left).toBe(original.left);
    expect(split().right).toBe(original.right);
    expect(project().activeTabKey).toBe(id === 'outside' ? 'node:outside' : tabKey(original));
    if (id !== 'outside') expect(split().focused).toBe(id);
  });

  it('reuses a side in an inactive split without taking another preview slot', () => {
    const original = createSplit();
    state().openEntityTab(projectId, node('outside'), { preview: false });
    state().openEntityTab(projectId, node('left'));
    expect(project().openTabs).toHaveLength(2);
    expect(project().activeTabKey).toBe(tabKey(original));
    expect(split()).toMatchObject({ focused: 'left', left: { isPreview: true } });
  });

  it('opens All Chapters at top level even when a split preview has focus', () => {
    const original = createSplit();
    state().openEntityTab(projectId, { entityType: 'all-chapters', id: 'self' });
    expect(split()).toBe(original);
    expect(project().activeTabKey).toBe('all-chapters:self');
  });

  it('preserves flags, focus, and ratio across persisted session restoration', () => {
    const original = createSplit(false, true);
    state().setSplitRatio(projectId, original.id, 0.4);
    const restored = sanitizePersistedTabsByProject(JSON.parse(JSON.stringify(
      persistableTabsByProject(state().tabsByProject),
    )));
    useUiStore.setState({ tabsByProject: restored });
    expect(split()).toMatchObject({ focused: 'right', splitRatio: 0.4,
      left: { isPreview: false }, right: { isPreview: true } });
    state().openEntityTab(projectId, node('after-restore'));
    expect(project().openTabs).toHaveLength(1);
    expect(split().right).toMatchObject({ id: 'after-restore', isPreview: true });
  });

  it('moves preview state with the entity when panes are swapped', () => {
    const original = createSplit(false, true);
    state().swapSplitPanes(projectId, original.id);
    expect(split()).toMatchObject({ focused: 'left', left: { id: 'right', isPreview: true },
      right: { id: 'left', isPreview: false } });
    state().openEntityTab(projectId, node('replacement'));
    expect(split().left.id).toBe('replacement');
    expect(split().right.id).toBe('left');
  });
});
