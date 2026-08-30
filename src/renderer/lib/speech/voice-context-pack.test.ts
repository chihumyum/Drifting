import { describe, expect, it } from 'vitest';
import type { BookElement, BookElementCategory } from '../../domain/book-element';
import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';
import { buildVoiceContextPack } from './voice-context-pack';

const PROJECT = 'p1';

function element(input: {
  name: string;
  aliases?: string[];
  categoryId?: string | null;
  projectId?: string;
}): BookElement {
  return {
    projectId: input.projectId ?? PROJECT,
    name: input.name,
    aliases: input.aliases ?? [],
    categoryId: input.categoryId ?? null,
  } as unknown as BookElement;
}

function category(id: string, name: string): BookElementCategory {
  return { id, projectId: PROJECT, name } as unknown as BookElementCategory;
}

function storyline(name: string, projectId = PROJECT): Storyline {
  return { projectId, name } as unknown as Storyline;
}

function node(kind: 'chapter' | 'drift', title: string, projectId = PROJECT): BookNode {
  return { projectId, kind, title } as unknown as BookNode;
}

const BASE = {
  projectId: PROJECT,
  projectName: '雾港纪事',
  elements: [
    element({ name: '林雾生', aliases: ['老林', '雾生'], categoryId: 'c1' }),
    element({ name: '雾港', categoryId: 'c2' }),
    element({ name: '别的项目角色', projectId: 'other' }),
  ],
  categories: [category('c1', '角色'), category('c2', '地点')],
  storylines: [storyline('灯塔线'), storyline('别项目线', 'other')],
  bookNodes: [
    node('chapter', '第一章 潮雾'),
    node('drift', '深夜灵感：无面人'),
    node('chapter', '别项目章节', 'other'),
  ],
};

describe('voice context pack', () => {
  it('carries names, aliases, and category labels for the active project only', () => {
    const pack = buildVoiceContextPack(BASE);
    expect(pack).toContain('雾港纪事');
    expect(pack).toContain('[角色] 林雾生（又称：老林、雾生）');
    expect(pack).toContain('[地点] 雾港');
    expect(pack).toContain('灯塔线');
    expect(pack).toContain('第一章 潮雾');
    expect(pack).toContain('深夜灵感：无面人');
    expect(pack).not.toContain('别的项目角色');
    expect(pack).not.toContain('别项目线');
    expect(pack).not.toContain('别项目章节');
  });

  it('clips low-priority sections first when the budget runs out', () => {
    const pack = buildVoiceContextPack(BASE, { maxChars: 95 });
    expect(pack).toContain('林雾生');
    expect(pack).toContain('灯塔线');
    expect(pack).not.toContain('第一章 潮雾');
    expect(pack).not.toContain('深夜灵感：无面人');
  });

  it('stays coherent for an empty project', () => {
    const pack = buildVoiceContextPack({
      projectId: PROJECT,
      projectName: '新项目',
      elements: [],
      categories: [],
      storylines: [],
      bookNodes: [],
    });
    expect(pack).toContain('新项目');
    expect(pack).not.toContain('项目元素');
  });
});
