import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENTITY_LINK_KIND_COLORS,
  buildEntityLinkColorSignature,
  normalizeEntityLinkColorMode,
  normalizeEntityLinkKindColors,
  resolveEntityLinkTargetColor,
  type EntityLinkColorState,
} from './entity-link-appearance';

function state(overrides: Record<string, unknown> = {}): EntityLinkColorState {
  return {
    bookElements: [],
    bookElementCategories: [],
    bookNodes: [],
    storylines: [],
    primaryStorylineByNode: {},
    driftGroups: [],
    ...overrides,
  } as unknown as EntityLinkColorState;
}

describe('entity link appearance', () => {
  it('normalizes synced modes and custom colors', () => {
    expect(normalizeEntityLinkColorMode('kind')).toBe('kind');
    expect(normalizeEntityLinkColorMode('hover')).toBe('hover');
    expect(normalizeEntityLinkColorMode('legacy')).toBe('contextual');
    expect(
      normalizeEntityLinkKindColors({
        element: '#AABBCC',
        chapter: 'red',
      }),
    ).toMatchObject({
      element: '#aabbcc',
      chapter: DEFAULT_ENTITY_LINK_KIND_COLORS.chapter,
    });
  });

  it('derives colors from each entity owner in contextual mode', () => {
    const data = state({
      bookElements: [{ id: 'element-1', categoryId: 'category-1' }],
      bookElementCategories: [{ id: 'category-1', color: '#AA5577' }],
      bookNodes: [
        { id: 'chapter-1', kind: 'chapter', driftGroupId: null },
        { id: 'drift-1', kind: 'drift', driftGroupId: 'group-1' },
      ],
      storylines: [{ id: 'storyline-1', color: '#5577AA' }],
      primaryStorylineByNode: { 'chapter-1': 'storyline-1' },
      driftGroups: [{ id: 'group-1', color: '#7755AA' }],
    });

    expect(
      resolveEntityLinkTargetColor(
        'element',
        'element-1',
        data,
        'contextual',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBe('#AA5577');
    expect(
      resolveEntityLinkTargetColor(
        'node',
        'chapter-1',
        data,
        'contextual',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBe('#5577AA');
    expect(
      resolveEntityLinkTargetColor(
        'node',
        'drift-1',
        data,
        'contextual',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBe('#7755AA');
    expect(
      resolveEntityLinkTargetColor(
        'category',
        'category-1',
        data,
        'contextual',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBe('#AA5577');
    expect(
      resolveEntityLinkTargetColor(
        'storyline',
        'storyline-1',
        data,
        'contextual',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBe('#5577AA');
  });

  it('distinguishes chapter and drift colors in type mode', () => {
    const data = state({
      bookNodes: [
        { id: 'chapter-1', kind: 'chapter' },
        { id: 'drift-1', kind: 'drift' },
      ],
    });

    expect(
      resolveEntityLinkTargetColor(
        'node',
        'chapter-1',
        data,
        'kind',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBe(DEFAULT_ENTITY_LINK_KIND_COLORS.chapter);
    expect(
      resolveEntityLinkTargetColor(
        'node',
        'drift-1',
        data,
        'kind',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBe(DEFAULT_ENTITY_LINK_KIND_COLORS.drift);
  });

  it('removes inline colors in prose mode and ignores ordinary metadata changes', () => {
    const before = state({
      bookElements: [{ id: 'element-1', categoryId: 'category-1', summary: 'before' }],
      bookElementCategories: [{ id: 'category-1', color: '#AA5577' }],
    });
    const after = state({
      bookElements: [{ id: 'element-1', categoryId: 'category-1', summary: 'after' }],
      bookElementCategories: [{ id: 'category-1', color: '#AA5577' }],
    });

    expect(
      resolveEntityLinkTargetColor(
        'element',
        'element-1',
        before,
        'prose',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBeNull();
    expect(
      buildEntityLinkColorSignature(before, 'contextual', DEFAULT_ENTITY_LINK_KIND_COLORS),
    ).toBe(buildEntityLinkColorSignature(after, 'contextual', DEFAULT_ENTITY_LINK_KIND_COLORS));
  });

  it('keeps contextual owner colors available for hover-only styling', () => {
    const data = state({
      bookElements: [{ id: 'element-1', categoryId: 'category-1' }],
      bookElementCategories: [{ id: 'category-1', color: '#AA5577' }],
    });

    expect(
      resolveEntityLinkTargetColor(
        'element',
        'element-1',
        data,
        'hover',
        DEFAULT_ENTITY_LINK_KIND_COLORS,
      ),
    ).toBe('#AA5577');
  });
});
