import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBlockChange } from '../../lib/agent/block-diff';
import {
  agentEditAnimationKey,
  agentEditOpaqueBackground,
  agentEditRectInScrollHost,
  agentEditRevealCount,
  agentEditRevealTiming,
  bulkAgentEditRevealChanges,
  createAgentEditSeenTracker,
} from './agent-edit-animation';
import { createAgentMarkerSelector } from './scroll-marker-model';

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
  afterEach(() => vi.useRealTimers());

  it.each([
    [0, 1250, 400],
    [1, 1250, 400],
    [3, 1250, 400],
    [4, 1000, 320],
    [8, 1000, 320],
    [9, 667, 213],
    [16, 667, 213],
    [17, 500, 160],
    [24, 500, 160],
    [25, 400, 128],
    [48, 400, 128],
    [49, 333, 107],
    [100, 333, 107],
  ])('paces a 40-character reveal for %i outstanding paragraphs', (count, durationMs, exitMs) => {
    expect(agentEditRevealTiming(40, count)).toEqual({ durationMs, exitMs });
  });

  it('keeps short edits perceptible and long edits bounded as the queue grows', () => {
    for (const characters of [1, 40, 1000]) {
      const durations = [0, 1, 3, 4, 8, 9, 16, 17, 24, 25, 48, 49, 100].map((count) => agentEditRevealTiming(characters, count).durationMs);
      expect(durations.every((duration) => duration >= 167 && duration <= 3125)).toBe(true);
      expect(durations.every((duration, index) => index === 0 || duration <= durations[index - 1])).toBe(true);
    }
    expect(agentEditRevealTiming(1, 1).durationMs).toBe(625);
    expect(agentEditRevealTiming(1, 25).durationMs).toBe(200);
    expect(agentEditRevealTiming(1, 49).durationMs).toBe(167);
    expect(agentEditRevealTiming(1000, 1).durationMs).toBe(3125);
    expect(agentEditRevealTiming(1000, 16).durationMs).toBe(1667);
    expect(agentEditRevealTiming(1000, 25).durationMs).toBe(1000);
    expect(agentEditRevealTiming(1000, 49).durationMs).toBe(833);
  });

  it('counts pending and active prose once, including inverse commits and overlapping reviews', () => {
    const pending = change('new', 'review-a', '', 'New');
    const overlapping = change('changed', 'review-b', 'New', 'Newer');
    const field = { ...pending, blockId: 'field:summary', field: { kind: 'summary' as const, label: 'Summary' } };
    expect(agentEditRevealCount(
      [pending, overlapping, field],
      new Map([['active', pending]]).values(),
      bulkAgentEditRevealChanges([pending], 'reverted'),
    )).toBe(2);
  });

  it('uses offscreen pending work and returns to slower pacing as the editor queue drains', () => {
    const edits = Array.from({ length: 16 }, (_, i) => ({
      ...change('new', 'review', '', 'Synthetic prose'), blockId: `block-${i}`,
    }));
    const busy = agentEditRevealCount(edits, [edits[0]]);
    const remaining = agentEditRevealCount([edits[15]]);
    expect(busy).toBe(16);
    expect(remaining).toBe(1);
    expect(agentEditRevealTiming(40, busy).durationMs).toBeLessThan(agentEditRevealTiming(40, remaining).durationMs);
    expect(agentEditRevealCount()).toBe(0);
  });

  it('keeps unread gutter markers without animation until each result has stayed in view', () => {
    vi.useFakeTimers();
    const visible = { ...change('changed', 'visible', 'Old', 'New'), blockId: 'visible', mode: 'auto' as const };
    const offscreen = { ...visible, blockId: 'offscreen' };
    let pending = [visible, offscreen];
    const markers = createAgentMarkerSelector();
    const tracker = createAgentEditSeenTracker((seen) => {
      pending = pending.filter((item) => item !== seen);
    });
    tracker.update([visible]);
    vi.advanceTimersByTime(499);
    expect(markers(pending).map((marker) => marker.blockIds)).toEqual([['visible'], ['offscreen']]);
    vi.advanceTimersByTime(1);
    expect(markers(pending).map((marker) => marker.blockIds)).toEqual([['offscreen']]);
    vi.advanceTimersByTime(10_000);
    expect(pending).toEqual([offscreen]);
    tracker.update([offscreen]);
    vi.advanceTimersByTime(500);
    expect(markers(pending)).toEqual([]);
    tracker.dispose();
  });

  it('does not count a brief scroll past or a retired editor as having read a result', () => {
    vi.useFakeTimers();
    const onSeen = vi.fn();
    const tracker = createAgentEditSeenTracker(onSeen);
    const edit = change('changed', 'review', 'Old', 'New');
    tracker.update([edit]);
    vi.advanceTimersByTime(300);
    tracker.update([]);
    vi.advanceTimersByTime(500);
    expect(onSeen).not.toHaveBeenCalled();
    tracker.update([edit]);
    vi.advanceTimersByTime(300);
    tracker.update([edit]); // repeated viewport checks do not restart the dwell
    vi.advanceTimersByTime(200);
    expect(onSeen).toHaveBeenCalledExactlyOnceWith(edit);
    tracker.update([change('changed', 'next-review', 'New', 'Next')]);
    tracker.dispose();
    vi.advanceTimersByTime(1000);
    expect(onSeen).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

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
