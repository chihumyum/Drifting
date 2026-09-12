import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyEntityLinkTargetColors,
  entityLinkConfig,
  detectEntityLinkSpans,
  type AutoDetectTarget,
  type EntityLinkTargetColorResolver,
} from './entity-link';

function colorRoot(targetId: string, targetKind = 'element', initialColor = '') {
  let color = initialColor;
  const setProperty = vi.fn((_property: string, value: string) => { color = value; });
  const removeProperty = vi.fn(() => { color = ''; });
  const link = {
    getAttribute: (name: string) => {
      if (name === 'data-target-id') return targetId;
      if (name === 'data-target-kind') return targetKind;
      return null;
    },
    style: { getPropertyValue: () => color, setProperty, removeProperty },
  };
  const root = {
    querySelectorAll: vi.fn(() => [link]),
  } as unknown as ParentNode;
  return { root, setProperty, removeProperty };
}

afterEach(() => {
  entityLinkConfig.resolveTargetColor = () => null;
});

describe('explicit entity-link detection context', () => {
  it('keeps longest-first verbatim matches and explicit enabled state', () => {
    const autoDetectTargets = new Map<string, AutoDetectTarget>([
      ['山', { kind: 'element', id: 'short' }],
      ['远山', { kind: 'element', id: 'long' }],
      ['A+B', { kind: 'node', id: 'literal' }],
    ]);
    expect(detectEntityLinkSpans('远山 A+B 山', { autoDetectTargets, autoDetectEnabled: true }).map((span) => [span.from, span.to, span.attrs.targetId]))
      .toEqual([[0, 2, 'long'], [3, 6, 'literal'], [7, 8, 'short']]);
    expect(detectEntityLinkSpans('远山', { autoDetectTargets, autoDetectEnabled: false })).toEqual([]);
  });

  it('compiles each immutable target map once when alternating editor contexts', () => {
    const maps = Array.from({ length: 20 }, (_, index) => new Map<string, AutoDetectTarget>([['合成', { kind: 'node', id: String(index) }]]));
    const keys = maps.map((map) => vi.spyOn(map, 'keys'));
    for (let iteration = 0; iteration < 100; iteration++) {
      maps.forEach((autoDetectTargets, index) => {
        expect(detectEntityLinkSpans('合成', { autoDetectTargets, autoDetectEnabled: true })[0].attrs.targetId).toBe(String(index));
      });
    }
    for (const spy of keys) expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('applyEntityLinkTargetColors', () => {
  it('applies the element category color as a presentation-only CSS variable', () => {
    const { root, setProperty, removeProperty } = colorRoot('element-1');
    const resolver: EntityLinkTargetColorResolver = (kind, id) =>
      kind === 'element' && id === 'element-1' ? '#4F8A8B' : null;

    applyEntityLinkTargetColors(root, resolver);

    expect(setProperty).toHaveBeenCalledWith('--entity-link-color', '#4F8A8B');
    expect(removeProperty).not.toHaveBeenCalled();
  });

  it('rebinds non-element targets through the same presentation resolver', () => {
    const { root, setProperty } = colorRoot('chapter-1', 'node');
    const resolver: EntityLinkTargetColorResolver = vi.fn(() => '#5B93C7');

    applyEntityLinkTargetColors(root, resolver);

    expect(resolver).toHaveBeenCalledWith('node', 'chapter-1');
    expect(setProperty).toHaveBeenCalledWith('--entity-link-color', '#5B93C7');
  });

  it('removes a stale category color when the element or category is missing', () => {
    const { root, setProperty, removeProperty } = colorRoot('orphan-element', 'element', '#4F8A8B');

    applyEntityLinkTargetColors(root, () => null);

    expect(removeProperty).toHaveBeenCalledWith('--entity-link-color');
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('rejects declaration delimiters in synced category colors', () => {
    const { root, setProperty, removeProperty } = colorRoot('element-1', 'element', '#4F8A8B');

    applyEntityLinkTargetColors(root, () => '#4F8A8B; color: red');

    expect(removeProperty).toHaveBeenCalledWith('--entity-link-color');
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('does not write unchanged colors or repeatedly remove an absent property', () => {
    const { root, setProperty, removeProperty } = colorRoot('element-1');
    applyEntityLinkTargetColors(root, () => null);
    expect(removeProperty).not.toHaveBeenCalled();
    applyEntityLinkTargetColors(root, () => '#4F8A8B');
    applyEntityLinkTargetColors(root, () => '#4F8A8B');
    expect(setProperty).toHaveBeenCalledTimes(1);
    applyEntityLinkTargetColors(root, () => null);
    applyEntityLinkTargetColors(root, () => null);
    expect(removeProperty).toHaveBeenCalledTimes(1);
  });
});
