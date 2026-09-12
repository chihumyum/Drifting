import { describe, expect, it } from 'vitest';
import { createRendererFixture, RENDERER_FIXTURE_PROFILES } from './fixture';

describe('synthetic renderer fixture', () => {
  it('reproduces exact prose/link counts and valid target references for every profile', () => {
    for (const options of RENDERER_FIXTURE_PROFILES) {
      const fixture = createRendererFixture(options);
      expect(fixture).toEqual(createRendererFixture(options));
      const textNodes = fixture.document.content!.flatMap((node) => node.content ?? []);
      expect(textNodes.reduce((count, node) => count + (node.text?.length ?? 0), 0)).toBe(options.characters);
      const marks = textNodes.flatMap((node) => node.marks ?? []);
      expect(marks).toHaveLength(options.links);
      const ids = new Set(fixture.elements.map((element) => element.id));
      expect(marks.every((mark) => ids.has(mark.attrs!.targetId))).toBe(true);
      expect(textNodes.every((node) => Boolean(node.text))).toBe(true);
    }
  });

  it('rejects invalid dimensions and changes generated data with the seed', () => {
    const options = RENDERER_FIXTURE_PROFILES[1];
    expect(createRendererFixture(options)).not.toEqual(createRendererFixture({ ...options, seed: 1 }));
    for (const override of [{ entities: 0 }, { links: -1 }, { links: 50_000 }, { characters: 0 }, { seed: NaN }]) {
      expect(() => createRendererFixture({ ...options, ...override })).toThrow();
    }
  });
});
