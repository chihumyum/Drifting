import { beforeEach, describe, expect, it } from 'vitest';

import { useAgentEditStore } from '../store/agent-edit-store';
import type { AgentBlockChange } from './agent/block-diff';
import { getAgentRecentMarks } from './agent-recent-changes';
import {
  EXTERNAL_REPLAY_QUIET_MS,
  externalRevealMask,
  noteExternalRevealed,
  planExternalEdits,
  presentExternalEdits,
  resetExternalEditPresentation,
} from './external-edit-presentation';

const change = (blockId: string, oldText: string, newText: string, op: AgentBlockChange['op'] = 'changed'): AgentBlockChange => ({
  blockId, op, oldText, newText, afterPrevId: null,
});

beforeEach(() => {
  resetExternalEditPresentation();
  useAgentEditStore.getState().clearAll();
});

describe('external edit presentation', () => {
  it('records changes in blue and remembers the file as the last source', () => {
    const plan = planExternalEdits('node', 'c1', [change('p1', '林岚推开门。', '林岚轻轻推开门。'), change('p2', '', '新段落。', 'new')]);
    expect(externalRevealMask(plan)).toEqual(['p1', 'p2']);
    presentExternalEdits('node', 'c1', plan);
    const pending = useAgentEditStore.getState().pending['node:c1']!;
    expect(pending.lastSource).toBe('file');
    expect(pending.changes.map((item) => [item.blockId, item.source, item.mode])).toEqual([
      ['p1', 'file', 'auto'],
      ['p2', 'file', 'auto'],
    ]);
  });

  it('only recolours a paragraph whose reveal the author just watched', () => {
    const now = 1_000_000;
    noteExternalRevealed('node', 'c1', { blockId: 'p1', oldText: '林岚推开门。' }, now);
    const plan = planExternalEdits('node', 'c1', [change('p1', '林岚轻轻推开门。', '林岚轻轻推开门，雨很大。')], now + 2_000);
    expect(plan.reveal).toEqual([]);
    // Every word added since the first reveal stays blue, not only this save's.
    expect(plan.recolor).toEqual([{ ...change('p1', '林岚推开门。', '林岚轻轻推开门，雨很大。'), source: 'file' }]);
    presentExternalEdits('node', 'c1', plan, now + 2_000);
    expect(useAgentEditStore.getState().pending['node:c1']).toBeUndefined();
    expect(getAgentRecentMarks().filter((mark) => mark.blockId === 'p1').map((mark) => [mark.kind, mark.text])).toEqual([
      ['ext', '轻轻'],
      ['ext', '，雨很大'],
    ]);

    // After the quiet window the paragraph plays again.
    const later = planExternalEdits('node', 'c1', [change('p1', '林岚轻轻推开门，雨很大。', '林岚推开门。')], now + 2_000 + EXTERNAL_REPLAY_QUIET_MS);
    expect(later.reveal.map((item) => item.blockId)).toEqual(['p1']);
  });

  it('leaves a paragraph with a pending Agent review to the Agent', () => {
    useAgentEditStore.getState().recordReview('node', 'c1', [change('p1', 'a', 'b')], 'auto', { effectId: 'effect-1', reviewId: 'review-1' });
    presentExternalEdits('node', 'c1', planExternalEdits('node', 'c1', [change('p1', 'b', 'c'), change('p2', 'x', 'y')]));
    const pending = useAgentEditStore.getState().pending['node:c1']!;
    expect(pending.changes.find((item) => item.blockId === 'p1')).toMatchObject({ reviewId: 'review-1', newText: 'b' });
    expect(pending.changes.find((item) => item.blockId === 'p2')).toMatchObject({ source: 'file' });
    expect(pending.lastSource).toBe('file');
  });
});
