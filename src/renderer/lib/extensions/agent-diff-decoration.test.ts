import { Schema } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import type { AgentBlockChange } from '../agent/block-diff';
import {
  buildAgentEditorDecorations,
  planAgentAutoRevealMask,
} from './agent-diff-decoration';

const proseSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'text*',
      group: 'block',
      attrs: { id: { default: null } },
    },
    text: { group: 'inline' },
  },
});

function change(
  blockId: string,
  op: AgentBlockChange['op'],
  mode: AgentBlockChange['mode'],
): AgentBlockChange {
  return {
    blockId,
    op,
    mode,
    oldText: op === 'new' ? '' : `old:${blockId}`,
    newText: op === 'deleted' ? '' : `new:${blockId}`,
    afterPrevId: null,
  };
}

function proseDoc(blocks: Array<{ id: string | null; text: string }>) {
  return proseSchema.node(
    'doc',
    null,
    blocks.map(({ id, text }) =>
      proseSchema.node(
        'paragraph',
        { id },
        text ? proseSchema.text(text) : undefined,
      ),
    ),
  );
}

function maskedBlockIds(
  blockIds: readonly string[] | null | undefined,
): Array<string | null> {
  const decorations = buildAgentEditorDecorations(
    proseDoc([
      { id: 'existing', text: '现存文件里已经写入的新正文' },
      { id: 'blank', text: '' },
      { id: 'added', text: '新文件里尚未进入视口的正文' },
      { id: 'approve', text: '等待人工审阅的正文' },
    ]),
    [],
    blockIds,
  );
  return decorations
    .find()
    .filter((decoration) => decoration.spec.agentAutoRevealMask)
    .map((decoration) => decoration.spec.blockId as string | null);
}

describe('Agent prose reveal masks', () => {
  it('selects changed/new auto edits in existing files but not deletes or approve mode', () => {
    const changes = [
      change('existing', 'changed', 'auto'),
      change('added', 'new', 'auto'),
      change('deleted', 'deleted', 'auto'),
      change('approve', 'changed', 'approve'),
    ];

    expect(planAgentAutoRevealMask(changes)).toEqual(['existing', 'added']);
    expect(maskedBlockIds(planAgentAutoRevealMask(changes))).toEqual([
      'existing',
      'added',
    ]);
  });

  it('masks every textual block before an Added file has stable ids', () => {
    expect(planAgentAutoRevealMask([], true)).toBeNull();
    expect(maskedBlockIds(null)).toEqual(['existing', 'added', 'approve']);
  });

  it('masks a pre-live guarded block before its canonical pending review exists', () => {
    expect(planAgentAutoRevealMask([], false, ['existing', 'existing'])).toEqual([
      'existing',
    ]);
    expect(maskedBlockIds(planAgentAutoRevealMask([], false, ['existing']))).toEqual([
      'existing',
    ]);
  });

  it('removes the mask projection once no auto changed/new block remains', () => {
    expect(planAgentAutoRevealMask([change('deleted', 'deleted', 'auto')])).toBeUndefined();
    expect(maskedBlockIds(undefined)).toEqual([]);
  });
});
