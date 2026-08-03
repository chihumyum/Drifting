import { describe, expect, it } from 'vitest';

import { resolveAgentProseReviewMode } from './agent-prose-review-policy';

function prose(blocks: Array<{ id: string; text: string }>): string {
  return JSON.stringify({
    type: 'doc',
    content: blocks.map((block) => ({
      type: 'paragraph',
      attrs: { id: block.id },
      content: block.text ? [{ type: 'text', text: block.text }] : [],
    })),
  });
}

describe('resolveAgentProseReviewMode', () => {
  it('keeps ordinary prose editing automatic', () => {
    const before = prose([
      { id: 'a', text: '她推开门。' },
      { id: 'b', text: '雨还在下。' },
    ]);
    const after = prose([
      { id: 'a', text: '她轻轻推开门。' },
      { id: 'b', text: '雨还在下。' },
    ]);

    expect(resolveAgentProseReviewMode('auto', before, after)).toBe('auto');
  });

  it('escalates a deletion of most of a shorter draft', () => {
    const retained = '保留'.repeat(30);
    const removed = '删除'.repeat(300);
    const before = prose([
      { id: 'keep', text: retained },
      { id: 'remove', text: removed },
    ]);
    const after = prose([{ id: 'keep', text: retained }]);

    expect(resolveAgentProseReviewMode('auto', before, after)).toBe('approve');
  });

  it('escalates a multi-thousand-character partial chapter deletion', () => {
    const before = prose([
      { id: 'keep', text: '保留'.repeat(800) },
      { id: 'remove', text: '重复'.repeat(1_100) },
    ]);
    const after = prose([{ id: 'keep', text: '保留'.repeat(800) }]);

    expect(resolveAgentProseReviewMode('auto', before, after)).toBe('approve');
  });

  it('never downgrades an author-selected approval mode', () => {
    const content = prose([{ id: 'a', text: '原文' }]);
    expect(resolveAgentProseReviewMode('approve', content, content)).toBe('approve');
  });
});
