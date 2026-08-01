import { describe, expect, it } from 'vitest';

import type { YjsProseBlock } from './yjs-prose-command';
import {
  parseWorkspaceTextReplacements,
  planWorkspaceProseFileEdit,
  renderWorkspaceProseFile,
} from './workspace-prose-file';

describe('workspace prose file editing', () => {
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
});

function block(type: string, id: string, text: string): YjsProseBlock {
  return {
    id,
    type,
    content: text ? [{ kind: 'text', text }] : [],
  };
}
