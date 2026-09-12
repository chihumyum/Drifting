import type { JSONContent } from '@tiptap/core';

export interface RendererFixtureOptions {
  seed: number;
  characters: number;
  links: number;
  entities: number;
}

/** Synthetic, in-memory input. Never seeds a live workspace or author database. */
export function createRendererFixture(options: RendererFixtureOptions) {
  const { seed, characters, links, entities } = options;
  if (![seed, characters, links, entities].every(Number.isSafeInteger)
    || seed < 0 || characters < 1 || links < 0 || links > characters / 2 || entities < 1) {
    throw new Error('Invalid renderer fixture dimensions');
  }
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const elements = Array.from({ length: entities }, (_, index) => ({
    id: `synthetic-element-${index}`,
    name: `合成人物${index}`,
    categoryId: `synthetic-category-${index % 8}`,
  }));
  const categories = Array.from({ length: 8 }, (_, index) => ({
    id: `synthetic-category-${index}`,
    color: `#${(random() & 0xffffff).toString(16).padStart(6, '0')}`,
  }));
  const paragraphs = Math.max(1, links);
  const content: JSONContent[] = Array.from({ length: paragraphs }, (_, index) => {
    const length = Math.floor(characters / paragraphs) + (index < characters % paragraphs ? 1 : 0);
    const text = '合成段落潮声远山'.repeat(Math.ceil(length / 8)).slice(0, length);
    return {
      type: 'paragraph',
      content: index < links ? [
        { type: 'text', text: text.slice(0, -1) },
        {
          type: 'text', text: text.slice(-1),
          marks: [{ type: 'entityLink', attrs: {
            targetKind: 'element', targetId: elements[random() % entities].id, targetBlockId: null,
          } }],
        },
      ] : [{ type: 'text', text }],
    };
  });
  return { options, elements, categories, document: { type: 'doc', content } as JSONContent };
}

export const RENDERER_FIXTURE_PROFILES: RendererFixtureOptions[] = [
  { seed: 20260912, characters: 5_000, links: 0, entities: 100 },
  { seed: 20260912, characters: 20_000, links: 100, entities: 1_000 },
  { seed: 20260912, characters: 50_000, links: 500, entities: 5_000 },
];
