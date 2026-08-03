import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import { getStaticChapterSchema } from '../../../components/editor/chapter-static-html';
import type { YjsProseBlock } from './yjs-prose-command';
import { replaceYjsProseBlocks } from './yjs-prose-command';
import {
  applyWorkspaceTextReplacements,
  parseWorkspaceTextReplacements,
  planWorkspaceProseFileEdit,
  planWorkspaceProseFileWrite,
  renderWorkspaceProseFile,
} from './workspace-prose-file';

describe('workspace prose file editing', () => {
  it('accepts a unique straight-versus-typographic quote mismatch without weakening wording', () => {
    const original = '"她不在那儿了。"维勒说。\n\n奥伦愣住了。';

    expect(
      applyWorkspaceTextReplacements(
        original,
        parseWorkspaceTextReplacements([
          {
            oldText: '“她不在那儿了。”维勒说。\n\n奥伦愣住了。',
            newText: '“我把她拖出来了。”维勒说。\n\n奥伦愣住了。',
          },
        ]),
      ),
    ).toBe('“我把她拖出来了。”维勒说。\n\n奥伦愣住了。');
  });

  it('still rejects stale wording after quote normalization', () => {
    expect(() =>
      applyWorkspaceTextReplacements(
        '"她不在那儿了。"维勒说。',
        parseWorkspaceTextReplacements([
          {
            oldText: '“她已经不在那儿了。”维勒说。',
            newText: '“我把她拖出来了。”维勒说。',
          },
        ]),
      ),
    ).toThrow(/STALE_EDIT_TARGET/);
  });

  it('ignores only invisible line-end whitespace when the match stays unique', () => {
    expect(
      applyWorkspaceTextReplacements(
        '维图·史扬\n\n旧简介。\n\n旧摘要。 \n',
        parseWorkspaceTextReplacements([
          {
            oldText: '维图·史扬\n\n旧简介。\n\n旧摘要。',
            newText: '维图·史扬\n\n新简介。\n\n新摘要。',
          },
        ]),
      ),
    ).toBe('维图·史扬\n\n新简介。\n\n新摘要。\n');
  });

  it('does not normalize meaningful interior whitespace', () => {
    expect(() =>
      applyWorkspaceTextReplacements(
        '奥伦走进船棚。',
        parseWorkspaceTextReplacements([{ oldText: '奥伦 走进船棚。', newText: '奥伦停在门口。' }]),
      ),
    ).toThrow(/STALE_EDIT_TARGET/);
  });

  it('does not duplicate a structural prefix when stale plain text is replaced with Markdown', () => {
    expect(
      applyWorkspaceTextReplacements(
        '# 露比·艾伍德\n\n南园平民。',
        parseWorkspaceTextReplacements([
          {
            oldText: '露比·艾伍德\n\n南园平民。',
            newText: '# 露比·艾伍德\n\n南园平民。正文尚未登场。',
          },
        ]),
      ),
    ).toBe('# 露比·艾伍德\n\n南园平民。正文尚未登场。');
  });

  it('inserts paragraphs with one atomic range edit and preserves unchanged inline marks', async () => {
    const blocks: YjsProseBlock[] = [
      block('heading', 'heading-1', '雨夜'),
      {
        id: 'paragraph-1',
        type: 'paragraph',
        content: [
          {
            kind: 'text',
            text: '她',
            marks: { entityLink: { targetKind: 'element', targetId: 'heroine' } },
          },
          { kind: 'text', text: '没有回头。' },
        ],
      },
      block('paragraph', 'paragraph-2', '雨更大了。'),
    ];

    expect(renderWorkspaceProseFile(blocks)).toBe('# 雨夜\n\n她没有回头。\n\n雨更大了。');
    const operation = await planWorkspaceProseFileEdit({
      blocks,
      replacements: parseWorkspaceTextReplacements([
        {
          oldText: '她没有回头。\n\n雨更大了。',
          newText: '她停在门前。\n\n门从里面开了。\n\n雨更大了。',
        },
      ]),
      idempotencyKey: 'insert-paragraph',
    });

    expect(operation).toMatchObject({
      kind: 'replace',
      fromBlockId: 'paragraph-1',
      toBlockId: 'paragraph-1',
    });
    if (operation.kind !== 'replace') throw new Error('expected replace operation');
    expect(operation.blocks).toHaveLength(2);
    expect(operation.blocks[0]?.id).toBe('paragraph-1');
    expect(operation.blocks[1]?.id).not.toBe('paragraph-2');
    expect(operation.blocks[0]?.content?.[0]).toMatchObject({
      kind: 'text',
      text: '她',
      marks: { entityLink: { targetId: 'heroine' } },
    });
  });

  it('keeps separated same-shape replacements as non-structural block edits', async () => {
    const blocks = [
      block('paragraph', 'a', '甲。'),
      block('paragraph', 'b', '乙。'),
      block('paragraph', 'c', '丙。'),
    ];
    const operation = await planWorkspaceProseFileEdit({
      blocks,
      replacements: parseWorkspaceTextReplacements([
        { oldText: '甲。', newText: '甲改。' },
        { oldText: '丙。', newText: '丙改。' },
      ]),
      idempotencyKey: 'two-edits',
    });

    expect(operation).toEqual({
      kind: 'edit_many',
      edits: [
        { blockId: 'a', block: block('paragraph', 'a', '甲改。') },
        { blockId: 'c', block: block('paragraph', 'c', '丙改。') },
      ],
    });
  });

  it('can merge multiple paragraphs without exposing structural commands', async () => {
    const blocks = [
      block('paragraph', 'a', '第一段。'),
      block('paragraph', 'b', '第二段。'),
      block('paragraph', 'c', '第三段。'),
    ];
    const operation = await planWorkspaceProseFileEdit({
      blocks,
      replacements: parseWorkspaceTextReplacements([
        {
          oldText: '第一段。\n\n第二段。',
          newText: '合并后的第一段。',
        },
      ]),
      idempotencyKey: 'merge-paragraphs',
    });

    expect(operation).toEqual({
      kind: 'replace',
      fromBlockId: 'a',
      toBlockId: 'b',
      blocks: [block('paragraph', 'a', '合并后的第一段。')],
    });
  });

  it('initializes a blank virtual manuscript without inventing an oldText match', async () => {
    const operation = await planWorkspaceProseFileWrite({
      blocks: [block('paragraph', 'blank', '')],
      content: '# 起点\n\n第一段。',
      idempotencyKey: 'blank-whole-file',
    });

    expect(operation).toMatchObject({
      kind: 'replace',
      fromBlockId: 'blank',
      toBlockId: 'blank',
      blocks: [{ id: 'blank', type: 'heading' }, { type: 'paragraph' }],
    });
  });

  it('changes heading level through Markdown while preserving block identity and editor attrs', async () => {
    const blocks: YjsProseBlock[] = [
      {
        id: 'heading',
        type: 'heading',
        attrs: { level: 1, textAlign: 'center', indent: 2 },
        content: [{ kind: 'text', text: '旧标题' }],
      },
    ];

    const operation = await planWorkspaceProseFileWrite({
      blocks,
      content: '## 新标题',
      idempotencyKey: 'heading-level',
    });

    expect(operation).toEqual({
      kind: 'edit_many',
      edits: [
        {
          blockId: 'heading',
          block: {
            id: 'heading',
            type: 'heading',
            attrs: { level: 2, textAlign: 'center', indent: 2 },
            content: [{ kind: 'text', text: '新标题' }],
          },
        },
      ],
    });
  });

  it('converts allowed Markdown blocks and marks directly into Yjs prose nodes', async () => {
    const operation = await planWorkspaceProseFileWrite({
      blocks: [],
      content:
        '### 小标题\n\n> **粗体***斜体*~~删除~~<u>下划线</u><br>[链接](https://example.test)\n\n---',
      idempotencyKey: 'allowed-markdown',
    });

    expect(operation.kind).toBe('insert');
    if (operation.kind !== 'insert') throw new Error('expected insert operation');
    expect(operation.blocks.map((candidate) => candidate.type)).toEqual([
      'heading',
      'blockquote',
      'horizontalRule',
    ]);
    expect(operation.blocks[0]).toMatchObject({ attrs: { level: 3 } });
    expect(operation.blocks[1]?.content?.[0]).toMatchObject({
      kind: 'element',
      type: 'paragraph',
      content: [
        { kind: 'text', text: '粗体', marks: { bold: {} } },
        { kind: 'text', text: '斜体', marks: { italic: {} } },
        { kind: 'text', text: '删除', marks: { strike: {} } },
        { kind: 'text', text: '下划线', marks: { underline: {} } },
        { kind: 'element', type: 'hardBreak' },
        { kind: 'text', text: '链接', marks: { link: { href: 'https://example.test' } } },
      ],
    });

    const ydoc = new Y.Doc();
    replaceYjsProseBlocks(ydoc, operation.blocks);
    const schema = getStaticChapterSchema();
    expect(schema).not.toBeNull();
    expect(() => ProseMirrorNode.fromJSON(schema!, yDocToProsemirrorJSON(ydoc, 'default'))).not.toThrow();
    ydoc.destroy();
  });

  it('strips unsupported Markdown styles instead of creating disabled TipTap nodes or marks', async () => {
    const operation = await planWorkspaceProseFileWrite({
      blocks: [],
      content: [
        '#### 不支持的标题',
        '',
        '- [x] 任务项',
        '- 列表项',
        '',
        '`行内代码`',
        '',
        '```ts',
        'const value = 1;',
        '第二行',
        '```',
      ].join('\n'),
      idempotencyKey: 'unsupported-markdown',
    });

    expect(operation.kind).toBe('insert');
    if (operation.kind !== 'insert') throw new Error('expected insert operation');
    expect(operation.blocks).toHaveLength(5);
    expect(operation.blocks.every((candidate) => candidate.type === 'paragraph')).toBe(true);
    expect(operation.blocks.map((candidate) => candidate.content)).toEqual([
      [{ kind: 'text', text: '不支持的标题' }],
      [{ kind: 'text', text: '任务项' }],
      [{ kind: 'text', text: '列表项' }],
      [{ kind: 'text', text: '行内代码' }],
      [
        { kind: 'text', text: 'const value = 1;' },
        { kind: 'element', type: 'hardBreak' },
        { kind: 'text', text: '第二行' },
      ],
    ]);
  });

  it('renders exact heading levels and only schema-supported marks to the virtual file', () => {
    const blocks: YjsProseBlock[] = [
      {
        id: 'heading-2',
        type: 'heading',
        attrs: { level: 2 },
        content: [{ kind: 'text', text: '标题' }],
      },
      {
        id: 'paragraph',
        type: 'paragraph',
        content: [
          { kind: 'text', text: '粗体', marks: { bold: {} } },
          {
            kind: 'text',
            text: '实体',
            marks: { entityLink: { targetKind: 'element', targetId: 'entity' } },
          },
          { kind: 'element', type: 'hardBreak' },
          { kind: 'text', text: '下一行', marks: { code: {} } },
        ],
      },
      {
        id: 'legacy-list',
        type: 'bulletList',
        content: [
          {
            kind: 'element',
            type: 'listItem',
            content: [
              {
                kind: 'element',
                type: 'paragraph',
                content: [{ kind: 'text', text: '旧列表' }],
              },
            ],
          },
        ],
      },
    ];

    expect(renderWorkspaceProseFile(blocks)).toBe(
      '## 标题\n\n**粗体**实体<br>下一行\n\n旧列表',
    );
  });

  it('preserves invisible entity-link marks when a visible Markdown mark is edited', async () => {
    const blocks: YjsProseBlock[] = [
      {
        id: 'rich-paragraph',
        type: 'paragraph',
        content: [
          { kind: 'text', text: '粗体', marks: { bold: {} } },
          {
            kind: 'text',
            text: '实体',
            marks: { entityLink: { targetKind: 'element', targetId: 'entity' } },
          },
        ],
      },
    ];

    const operation = await planWorkspaceProseFileWrite({
      blocks,
      content: '**新粗体**实体',
      idempotencyKey: 'preserve-opaque-mark',
    });

    expect(operation).toMatchObject({
      kind: 'edit_many',
      edits: [
        {
          blockId: 'rich-paragraph',
          block: {
            content: [
              { kind: 'text', text: '新粗体', marks: { bold: {} } },
              {
                kind: 'text',
                text: '实体',
                marks: { entityLink: { targetKind: 'element', targetId: 'entity' } },
              },
            ],
          },
        },
      ],
    });
  });
});

function block(type: string, id: string, text: string): YjsProseBlock {
  return {
    id,
    type,
    content: text ? [{ kind: 'text', text }] : [],
  };
}
