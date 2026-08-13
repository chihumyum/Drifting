import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import { useDataStore } from '../../store/data-store';
import { buildEntityHoverCardContent } from './entity-hover-card-model';

const t = ((key: string, options?: { count?: string | number }) => {
  if (key === 'nodeEditor.meta.words') return `${options?.count} words`;
  if (key === 'storylineEditor.meta.chapters') return `${options?.count} chapters`;
  if (key === 'storylineEditor.meta.kWords') return `${options?.count}k words`;
  if (key === 'categoryEditor.meta.elements') return `${options?.count} elements`;
  if (key === 'leftSidebar.uncategorized') return 'Uncategorized';
  if (key === 'nodeEditor.empty.noStoryline') return 'No storyline';
  if (key === 'editorTopBar.status.draft') return 'Draft';
  return key;
}) as TFunction;

function store(overrides: Record<string, unknown> = {}) {
  return {
    bookNodes: [],
    bookElements: [],
    bookElementCategories: [],
    storylines: [],
    storylineNodeMapping: {},
    nodeStorylineMapping: {},
    primaryStorylineByNode: {},
    driftGroups: [],
    ...overrides,
  } as unknown as ReturnType<typeof useDataStore.getState>;
}

describe('buildEntityHoverCardContent', () => {
  it('shows the primary storyline followed by dimmed secondary storyline chips', () => {
    const content = buildEntityHoverCardContent(
      { kind: 'node', id: 'chapter-1' },
      store({
        bookNodes: [
          {
            id: 'chapter-1',
            kind: 'chapter',
            summary: 'A chapter summary',
            writingStatus: 'draft',
            wordCount: 1234,
            wordCountBasisKind: 'seed',
            wordCountBasisHash: `sha256:${'a'.repeat(64)}`,
          },
        ],
        storylines: [
          { id: 'story-1', name: 'Main Arc', color: '#5570A7' },
          { id: 'story-2', name: 'Quiet Arc', color: '#8C6F52' },
        ],
        nodeStorylineMapping: { 'chapter-1': ['story-1', 'story-2'] },
        primaryStorylineByNode: { 'chapter-1': 'story-1' },
      }),
      t,
    );

    expect(content).toEqual({
      summary: 'A chapter summary',
      meta: [
        { text: 'Draft' },
        { text: '1,234 words' },
        { text: 'Main Arc', color: '#5570A7' },
        { text: 'Quiet Arc', color: '#8C6F52', tone: 'secondary' },
      ],
    });
  });

  it('uses hydrated membership while the primary lookup is unavailable', () => {
    const content = buildEntityHoverCardContent(
      { kind: 'node', id: 'chapter-1' },
      store({
        bookNodes: [
          {
            id: 'chapter-1',
            kind: 'chapter',
            summary: '',
            writingStatus: 'draft',
            wordCount: 10,
          },
        ],
        storylines: [{ id: 'story-1', name: 'Main Arc', color: '#5570A7' }],
        nodeStorylineMapping: { 'chapter-1': ['story-1'] },
        primaryStorylineByNode: {},
      }),
      t,
    );

    expect(content?.meta[2]).toEqual({ text: 'Main Arc', color: '#5570A7' });
  });

  it('builds element metadata without reading its prose body', () => {
    const content = buildEntityHoverCardContent(
      { kind: 'element', id: 'element-1' },
      store({
        bookElements: [
          {
            id: 'element-1',
            name: 'Mira Vale',
            categoryId: 'category-1',
            groupName: 'Allies',
            aliases: ['Mira', 'Lady Mira', 'The Heir', 'M.'],
            summary: 'An element summary',
            contentJson: '{"ignored":true}',
            kvJson: JSON.stringify([
              { key: 'Faction', value: 'North' },
              { key: '', value: '' },
            ]),
          },
        ],
        bookElementCategories: [{ id: 'category-1', name: 'Characters', color: '#B84A62' }],
      }),
      t,
    );

    expect(content).toEqual({
      title: 'Mira Vale',
      summary: 'An element summary',
      meta: [
        { text: 'Characters', color: '#B84A62' },
        { text: 'Allies' },
        { text: 'AKA Mira · Lady Mira · The Heir +1' },
        { text: 'Faction：North' },
      ],
    });
  });

  it('derives storyline totals from the hydrated node mapping', () => {
    const content = buildEntityHoverCardContent(
      { kind: 'storyline', id: 'story-1' },
      store({
        storylines: [
          {
            id: 'story-1',
            summary: 'A storyline summary',
            kvJson: JSON.stringify([{ key: 'Tone', value: 'Suspenseful' }]),
          },
        ],
        storylineNodeMapping: { 'story-1': ['chapter-1', 'chapter-2'] },
        bookNodes: [
          {
            id: 'chapter-1',
            kind: 'chapter',
            wordCount: 1200,
            wordCountBasisKind: 'seed',
            wordCountBasisHash: `sha256:${'a'.repeat(64)}`,
          },
          {
            id: 'chapter-2',
            kind: 'chapter',
            wordCount: 800,
            wordCountBasisKind: 'seed',
            wordCountBasisHash: `sha256:${'b'.repeat(64)}`,
          },
          { id: 'chapter-3', wordCount: 9000 },
        ],
      }),
      t,
    );

    expect(content).toEqual({
      summary: 'A storyline summary',
      meta: [{ text: '2 chapters' }, { text: '2.0k words' }, { text: 'Tone：Suspenseful' }],
    });
  });

  it('shows a drift group path without fetching folder data', () => {
    const content = buildEntityHoverCardContent(
      { kind: 'node', id: 'drift-1' },
      store({
        bookNodes: [
          {
            id: 'drift-1',
            kind: 'drift',
            summary: 'A drift summary',
            writingStatus: 'drifting',
            wordCount: 21,
            driftGroupId: 'child',
          },
        ],
        driftGroups: [
          { id: 'parent', name: 'Ideas', parentGroupId: null },
          { id: 'child', name: 'Dreams', parentGroupId: 'parent', color: '#7A55A3' },
        ],
      }),
      t,
    );

    expect(content?.meta[content.meta.length - 1]).toEqual({
      text: 'Ideas / Dreams',
      color: '#7A55A3',
    });
  });

  it('does not query non-hydrated patch data', () => {
    expect(buildEntityHoverCardContent({ kind: 'patch', id: 'patch-1' }, store(), t)).toBeNull();
  });
});
