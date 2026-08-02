import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyEntityLinkTargetColors,
  entityLinkConfig,
  type EntityLinkTargetColorResolver,
} from './entity-link';

function colorRoot(targetId: string, targetKind = 'element') {
  const setProperty = vi.fn();
  const removeProperty = vi.fn();
  const link = {
    getAttribute: (name: string) => {
      if (name === 'data-target-id') return targetId;
      if (name === 'data-target-kind') return targetKind;
      return null;
    },
    style: { setProperty, removeProperty },
  };
  const root = {
    querySelectorAll: vi.fn(() => [link]),
  } as unknown as ParentNode;
  return { root, setProperty, removeProperty };
}

afterEach(() => {
  entityLinkConfig.resolveTargetColor = () => null;
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
    const { root, setProperty, removeProperty } = colorRoot('orphan-element');

    applyEntityLinkTargetColors(root, () => null);

    expect(removeProperty).toHaveBeenCalledWith('--entity-link-color');
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('rejects declaration delimiters in synced category colors', () => {
    const { root, setProperty, removeProperty } = colorRoot('element-1');

    applyEntityLinkTargetColors(root, () => '#4F8A8B; color: red');

    expect(removeProperty).toHaveBeenCalledWith('--entity-link-color');
    expect(setProperty).not.toHaveBeenCalled();
  });
});
