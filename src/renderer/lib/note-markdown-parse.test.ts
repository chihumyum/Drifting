import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { noteBlockMarkdown, noteToMarkdown } from './note-markdown';
import { parseNoteMarkdown } from './note-markdown-parse';

function ids() {
  let next = 0;
  return () => `n${++next}`;
}

function parse(markdown: string, options: Partial<Parameters<typeof parseNoteMarkdown>[1]> = {}) {
  return parseNoteMarkdown(markdown, { nextId: ids(), ...options });
}

function render(nodes: JSONContent[], embedTitle?: (id: string) => string) {
  return noteToMarkdown(JSON.stringify({ type: 'doc', content: nodes }), {
    ...(embedTitle ? { embed: (id: string) => `［素材：${embedTitle(id)}］` } : {}),
  });
}

describe('parseNoteMarkdown', () => {
  it('round-trips the note dialect that note-markdown renders', () => {
    const markdown = [
      '## 调研',
      '- [x] 找潮汐表',
      '- [ ] 查年代 **重要**\n  - [ ] 子任务',
      '> [!note]\n> 灯塔 ==停用== 于 1937 年',
      '| 地点 | 年份 |\n| --- | --- |\n| 北岬 | 1937 |',
      '1. 第一\n2. 第二',
      '```ts\nconst tide = 3;\n```',
      '> 引用 *斜体* 与 ~~删除~~ 与 `代码`',
      '---',
      '[链接](https://example.com)',
    ].join('\n\n');
    const nodes = parse(markdown);
    expect(nodes.map((node) => node.type)).toEqual([
      'heading', 'taskList', 'callout', 'table', 'orderedList', 'codeBlock', 'blockquote', 'horizontalRule', 'paragraph',
    ]);
    expect(render(nodes)).toBe(markdown.replace('- [x] 找潮汐表\n\n- [ ]', '- [x] 找潮汐表\n- [ ]'));
  });

  it('gives every identified node an id and keeps checkbox state', () => {
    const [list] = parse('- [x] 完成\n- [ ] 待办');
    expect(list!.attrs?.id).toBe('n1');
    expect(list!.content?.map((item) => [item.type, item.attrs?.checked, typeof item.attrs?.id])).toEqual([
      ['taskItem', true, 'string'],
      ['taskItem', false, 'string'],
    ]);
  });

  it('resolves embeds by title and location links through the caller', () => {
    const nodes = parse('［素材：海图］\n\n见[第一章](drifting:chapters/第一章/prose.md#L3)', {
      embedId: (title) => (title === '海图' ? 'item-1' : null),
      location: (href) =>
        href.startsWith('drifting:')
          ? { targetKind: 'node', targetId: 'node-1', targetBlockId: 'b3', targetEndBlockId: null }
          : null,
    });
    expect(nodes[0]).toMatchObject({ type: 'materialEmbed', attrs: { libraryItemId: 'item-1' } });
    expect(nodes[1]!.content?.[1]).toMatchObject({
      text: '第一章',
      marks: [{ type: 'entityLink', attrs: { targetId: 'node-1', targetBlockId: 'b3' } }],
    });
  });

  it('keeps unresolved embeds and unsafe links as readable text', () => {
    const nodes = parse('［素材：不存在］\n\n[危险](javascript:alert(1))');
    expect(nodes[0]).toMatchObject({ type: 'paragraph', content: [{ text: '［素材：不存在］' }] });
    expect(nodes[1]!.content).toEqual([{ type: 'text', text: '危险' }]);
  });

  it('returns one empty paragraph for an empty body', () => {
    expect(parse('  \n')).toEqual([{ type: 'paragraph', attrs: { id: 'n1' } }]);
  });

  it('matches noteBlockMarkdown block for block', () => {
    const nodes = parse('# 标题\n\n段落\n\n- 一\n- 二');
    expect(noteBlockMarkdown(nodes)).toEqual(['# 标题', '段落', '- 一\n- 二']);
  });
});
