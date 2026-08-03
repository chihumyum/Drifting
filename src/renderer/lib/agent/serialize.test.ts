import { describe, expect, it } from 'vitest';

import { blocksToCompactText, docToBlocks } from './serialize';

describe('Agent prose serialization', () => {
  it('advertises only editor-supported Markdown and keeps exact heading levels', () => {
    const blocks = docToBlocks(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { id: 'h2', level: 2 },
            content: [{ type: 'text', text: '二级标题' }],
          },
          {
            type: 'paragraph',
            attrs: { id: 'rich' },
            content: [
              { type: 'text', text: '粗', marks: [{ type: 'bold' }] },
              { type: 'text', text: '斜', marks: [{ type: 'italic' }] },
              { type: 'hardBreak' },
              {
                type: 'text',
                text: '链',
                marks: [{ type: 'link', attrs: { href: 'https://example.test' } }],
              },
            ],
          },
          {
            type: 'heading',
            attrs: { id: 'h4', level: 4 },
            content: [{ type: 'text', text: '旧四级标题' }],
          },
          {
            type: 'codeBlock',
            attrs: { id: 'legacy-code' },
            content: [{ type: 'text', text: 'const value = 1;' }],
          },
          {
            type: 'bulletList',
            attrs: { id: 'legacy-list' },
            content: [
              {
                type: 'listItem',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: '旧列表项' }] },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(blocks.map((block) => block.markdown)).toEqual([
      '## 二级标题',
      '**粗***斜*<br>[链](https://example.test)',
      '旧四级标题',
      'const value = 1;',
      '旧列表项',
    ]);
    expect(blocksToCompactText(blocks)).toBe(
      [
        '1\t## 二级标题',
        '2\t**粗***斜*<br>[链](https://example.test)',
        '3\t旧四级标题',
        '4\tconst value = 1;',
        '5\t旧列表项',
      ].join('\n'),
    );
  });

  it('does not expose unsafe links as executable marks', () => {
    const [block] = docToBlocks(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '危险',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      }),
    );

    expect(block?.markdown).toBe('危险');
  });
});
