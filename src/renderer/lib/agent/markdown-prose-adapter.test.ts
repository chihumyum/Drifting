import { describe, expect, it } from 'vitest';

import {
  agentMarkdownInlineText,
  parseAgentProseMarkdown,
  renderAgentProseMarkdownBlock,
  type AgentMarkdownBlock,
} from './markdown-prose-adapter';

describe('Agent Markdown prose adapter', () => {
  it('keeps only the three heading levels enabled by the editor schema', () => {
    const blocks = parseAgentProseMarkdown(
      '# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n###### 六级',
    );

    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'heading',
      'heading',
      'paragraph',
      'paragraph',
    ]);
    expect(blocks.slice(0, 3).map((block) => ('level' in block ? block.level : null))).toEqual([
      1, 2, 3,
    ]);
    expect(blocks.map(renderAgentProseMarkdownBlock)).toEqual([
      '# 一级',
      '## 二级',
      '### 三级',
      '四级',
      '六级',
    ]);
  });

  it('maps all allowed inline marks and hard breaks without leaking raw HTML', () => {
    const [block] = parseAgentProseMarkdown(
      '**粗体***斜体*~~删除~~<u>下划线</u>[链接](https://example.test/a)<br>下一行',
    );

    expect(block).toEqual({
      type: 'paragraph',
      inline: [
        { kind: 'text', text: '粗体', marks: { bold: true } },
        { kind: 'text', text: '斜体', marks: { italic: true } },
        { kind: 'text', text: '删除', marks: { strike: true } },
        { kind: 'text', text: '下划线', marks: { underline: true } },
        { kind: 'text', text: '链接', marks: { link: 'https://example.test/a' } },
        { kind: 'hardBreak' },
        { kind: 'text', text: '下一行' },
      ],
    });
    expect(renderAgentProseMarkdownBlock(block!)).toBe(
      '**粗体***斜体*~~删除~~<u>下划线</u>[链接](https://example.test/a)<br>下一行',
    );
  });

  it('unwraps list, task, code, table, image, and arbitrary HTML styles into plain prose', () => {
    const blocks = parseAgentProseMarkdown(
      [
        '- [x] 第一项',
        '- 第二项',
        '',
        '1. 第三项',
        '',
        '`行内代码`',
        '',
        '```ts',
        'const answer = 42;',
        '第二行',
        '```',
        '',
        '| A | B |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '![插图](https://example.test/image.png)',
        '',
        '<div><h4>HTML 标题</h4><b>普通文字</b></div>',
      ].join('\n'),
    );

    expect(blocks.every((block) => block.type === 'paragraph')).toBe(true);
    expect(blocks.map((block) => agentMarkdownInlineText(block.inline))).toEqual([
      '第一项',
      '第二项',
      '第三项',
      '行内代码',
      'const answer = 42;\n第二行',
      'A | B',
      '1 | 2',
      '插图',
      'HTML 标题\n普通文字',
    ]);
    const rendered = blocks.map(renderAgentProseMarkdownBlock).join('\n\n');
    expect(rendered).not.toMatch(/```|^- |^1\. |<div|<h4|<b>/mu);
  });

  it('drops unsafe link behavior while retaining the visible label', () => {
    const [block] = parseAgentProseMarkdown(
      '[安全](https://example.test) 与 [危险](javascript:alert%281%29)',
    );

    expect(block?.type).toBe('paragraph');
    if (!block || block.type === 'horizontalRule') throw new Error('expected text block');
    expect(agentMarkdownInlineText(block.inline)).toBe('安全 与 危险');
    expect(block.inline).toEqual([
      { kind: 'text', text: '安全', marks: { link: 'https://example.test' } },
      { kind: 'text', text: ' 与 危险' },
    ]);
  });

  it('round-trips every allowed block and mark through canonical Markdown', () => {
    const source: AgentMarkdownBlock[] = [
      {
        type: 'heading',
        level: 2,
        inline: [{ kind: 'text', text: '章名', marks: { bold: true } }],
      },
      {
        type: 'paragraph',
        inline: [
          {
            kind: 'text',
            text: '组合',
            marks: {
              bold: true,
              italic: true,
              strike: true,
              underline: true,
              link: 'https://example.test/path',
            },
          },
          { kind: 'hardBreak' },
          { kind: 'text', text: '# 只是正文 **不是标记**' },
        ],
      },
      {
        type: 'blockquote',
        inline: [{ kind: 'text', text: '引用' }],
      },
      { type: 'horizontalRule', inline: [] },
    ];
    const markdown = source.map(renderAgentProseMarkdownBlock).join('\n\n');

    expect(parseAgentProseMarkdown(markdown)).toEqual(source);
  });

  it.each(['# 正文', '> 正文', '- 正文', '1. 正文', '---', '```正文'])(
    'escapes a literal block prefix instead of changing paragraph type: %s',
    (text) => {
      const source: AgentMarkdownBlock = {
        type: 'paragraph',
        inline: [{ kind: 'text', text }],
      };
      const rendered = renderAgentProseMarkdownBlock(source);

      expect(parseAgentProseMarkdown(rendered)).toEqual([source]);
    },
  );
});
