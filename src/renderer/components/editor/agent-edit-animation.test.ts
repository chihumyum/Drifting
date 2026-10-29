import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBlockChange } from '../../lib/agent/block-diff';
import {
  agentEditAnimationKey,
  agentEditOpaqueBackground,
  agentEditRectInScrollHost,
  agentEditRevealCount,
  agentEditRevealTiming,
  agentRevealFrame,
  agentRevealPieces,
  agentRevealSteps,
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

describe('in-place reveal (desktop)', () => {
  const seg = (kind: 'equal' | 'del' | 'ins', text: string) => ({ kind, text });
  const text = (frame: ReturnType<typeof agentRevealFrame>) => frame.runs.map((run) => run.text).join('');
  const caretAt = (frame: ReturnType<typeof agentRevealFrame>) =>
    frame.runs.slice(0, frame.caret).map((run) => run.text).join('').length;

  it('groups each changed place and marks added and rewritten words', () => {
    const pieces = agentRevealPieces([seg('equal', '雾'), seg('del', '散了'), seg('ins', '还没有散'), seg('ins', '，灯熄了'),
      seg('equal', '。'), seg('ins', '新'), seg('equal', '句'), seg('del', '删')]);
    expect(pieces).toEqual([
      { kind: 'equal', text: '雾' },
      { kind: 'place', old: '散了', next: '还没有散，灯熄了', mark: 'chg' },
      { kind: 'equal', text: '。' },
      { kind: 'place', old: '', next: '新', mark: 'new' },
      { kind: 'equal', text: '句' },
      { kind: 'place', old: '删', next: '', mark: 'chg' },
    ]);
    // Each place takes as many steps as its longer side.
    expect(agentRevealSteps(pieces)).toBe(8 + 1 + 1);
  });

  it('deletes longer old words from the front until both sides match, then overwrites', () => {
    const pieces = agentRevealPieces([seg('equal', 'A'), seg('del', '一二三四五'), seg('ins', '甲乙'), seg('equal', 'Z')]);
    expect(agentRevealSteps(pieces)).toBe(5);
    expect(text(agentRevealFrame(pieces, 0))).toBe('A一二三四五Z');
    expect(text(agentRevealFrame(pieces, 1))).toBe('A二三四五Z');
    expect(text(agentRevealFrame(pieces, 3))).toBe('A四五Z');
    expect(caretAt(agentRevealFrame(pieces, 3))).toBe(1);
    // Now as long as the new words: overwrite one character a step.
    expect(text(agentRevealFrame(pieces, 4))).toBe('A甲五Z');
    expect(caretAt(agentRevealFrame(pieces, 4))).toBe(2);
    const done = agentRevealFrame(pieces, 5);
    expect(text(done)).toBe('A甲乙Z');
    expect(done.caret).toBe(-1);
    expect(done.runs.find((run) => run.text === '甲乙')?.mark).toBe('chg');
  });

  it('overwrites shorter old words first, then inserts the rest, pushing the text on', () => {
    const pieces = agentRevealPieces([seg('del', '一二'), seg('ins', '甲乙丙丁'), seg('equal', '尾')]);
    expect(text(agentRevealFrame(pieces, 1))).toBe('甲二尾');
    expect(text(agentRevealFrame(pieces, 2))).toBe('甲乙尾');
    expect(text(agentRevealFrame(pieces, 3))).toBe('甲乙丙尾');
    expect(caretAt(agentRevealFrame(pieces, 3))).toBe(3);
    expect(text(agentRevealFrame(pieces, 4))).toBe('甲乙丙丁尾');
  });

  it('plays the places one after another and keeps the paragraph length steady while overwriting', () => {
    const pieces = agentRevealPieces([seg('del', '一'), seg('ins', '甲'), seg('equal', '，'), seg('ins', '新增')]);
    expect(text(agentRevealFrame(pieces, 1))).toBe('甲，');
    // The second place holds the caret at its start until it begins.
    expect(caretAt(agentRevealFrame(pieces, 1))).toBe(2);
    expect(text(agentRevealFrame(pieces, 2))).toBe('甲，新');
    const runs = agentRevealFrame(pieces, 2).runs;
    expect(runs[runs.length - 1]).toEqual({ text: '新', mark: 'new' });
  });
});
