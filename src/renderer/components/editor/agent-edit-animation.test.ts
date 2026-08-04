import { describe, expect, it } from 'vitest';

import type { AgentBlockChange } from '../../lib/agent/block-diff';
import {
  agentEditAnimationKey,
  agentEditOpaqueBackground,
  agentEditRectInScrollHost,
  bulkAgentEditRevealChanges,
} from './agent-edit-animation';

function change(
  op: AgentBlockChange['op'],
  reviewId: string,
  oldText: string,
  newText: string,
): AgentBlockChange {
  return {
    op,
    blockId: 'same-block',
    afterPrevId: 'previous-block',
    oldText,
    newText,
    mode: 'approve',
    reviewId,
  };
}

describe('Agent edit commit animation planning', () => {
  it('keeps reveal coordinates stable inside the native scrolling content tree', () => {
    const before = agentEditRectInScrollHost(
      { top: 320, left: 220, width: 480, height: 56 },
      { top: 100, left: 20 },
    );
    const afterNativeScroll = agentEditRectInScrollHost(
      { top: 180, left: 220, width: 480, height: 56 },
      { top: -40, left: 20 },
    );

    expect(afterNativeScroll).toEqual(before);
  });

  it('keeps the scroll-container fallback in content coordinates', () => {
    const before = agentEditRectInScrollHost(
      { top: 320, left: 220, width: 480, height: 56 },
      { top: 100, left: 20 },
      0,
    );
    const afterNativeScroll = agentEditRectInScrollHost(
      { top: 180, left: 220, width: 480, height: 56 },
      { top: 100, left: 20 },
      140,
    );

    expect(afterNativeScroll).toEqual(before);
  });

  it('skips transparent editor surfaces and uses the first opaque reveal backdrop', () => {
    expect(
      agentEditOpaqueBackground([
        'rgba(0, 0, 0, 0)',
        'rgb(255 255 255 / 7%)',
        'rgb(248, 246, 241)',
      ]),
    ).toBe('rgb(248, 246, 241)');
  });

  it('keeps a deterministic opaque fallback when every ancestor is transparent', () => {
    expect(agentEditOpaqueBackground(['transparent', 'rgba(0, 0, 0, 0)'])).toBe(
      '#fff',
    );
  });

  it('keeps every bulk-accepted review even when two effects touch one block', () => {
    const changes = [
      change('changed', 'review-a', 'A', 'B'),
      change('changed', 'review-b', 'B', 'C'),
    ];
    const reveals = bulkAgentEditRevealChanges(changes, 'accepted');

    expect(reveals).toEqual(changes);
    expect(new Set(reveals.map(agentEditAnimationKey)).size).toBe(2);
  });

  it('turns every bulk rejection into the visible inverse animation', () => {
    const reveals = bulkAgentEditRevealChanges(
      [
        change('new', 'review-new', '', '新增'),
        change('deleted', 'review-delete', '删除', ''),
        change('changed', 'review-change', '旧', '新'),
      ],
      'reverted',
    );

    expect(reveals).toEqual([
      expect.objectContaining({ op: 'deleted', oldText: '新增', newText: '' }),
      expect.objectContaining({ op: 'new', oldText: '', newText: '删除' }),
      expect.objectContaining({ op: 'changed', oldText: '新', newText: '旧' }),
    ]);
  });
});
