import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBlockChange } from './agent/block-diff';
import {
  agentRecentMarkSpans,
  dismissAgentRecentMark,
  forgetAgentRecentMarks,
  getAgentRecentMarks,
  recordAgentRecentChange,
} from './agent-recent-changes';
import { agentRecentHighlightName } from './agent-recent-highlight';
import { RECENT_CHANGE_FADE_MS } from './motion';

function change(blockId: string, oldText: string, newText: string, op: AgentBlockChange['op'] = 'changed'): AgentBlockChange {
  return { op, blockId, afterPrevId: null, oldText, newText, mode: 'auto', reviewId: 'r' };
}

afterEach(() => {
  forgetAgentRecentMarks(getAgentRecentMarks().map((mark) => mark.id));
  vi.useRealTimers();
});

describe('marks of what the Agent just wrote', () => {
  it('marks added words green and rewritten words purple, by their offsets in the new text', () => {
    expect(agentRecentMarkSpans(change('b', '他走了。远处是海。', '他慢慢走了。远处是山。'))).toEqual([
      { start: 1, end: 3, kind: 'new' },
      { start: 9, end: 10, kind: 'chg' },
    ]);
    expect(agentRecentMarkSpans(change('b', '', '整段新写', 'new'))).toEqual([{ start: 0, end: 4, kind: 'new' }]);
    expect(agentRecentMarkSpans(change('b', '整段删掉', '', 'deleted'))).toEqual([]);
  });

  it('keeps one set of marks per block, the latest change winning', () => {
    recordAgentRecentChange('node', 'c1', change('b1', '甲', '乙'));
    recordAgentRecentChange('node', 'c1', change('b2', '', '丙', 'new'));
    recordAgentRecentChange('node', 'c1', change('b1', '乙', '丁丁'));
    const marks = getAgentRecentMarks();
    expect(marks.map((mark) => [mark.blockId, mark.text, mark.kind])).toEqual([['b2', '丙', 'new'], ['b1', '丁丁', 'chg']]);
    expect(marks.every((mark) => mark.entity === 'node:c1')).toBe(true);
  });

  it('eases a dismissed mark back to ink in two steps, then lets it go', () => {
    vi.useFakeTimers();
    recordAgentRecentChange('node', 'c1', change('b1', '', '新', 'new'));
    const [mark] = getAgentRecentMarks();
    expect(agentRecentHighlightName(mark)).toBe('agent-recent-new');
    dismissAgentRecentMark(mark.id);
    expect(agentRecentHighlightName(getAgentRecentMarks()[0])).toBe('agent-recent-new-1');
    vi.advanceTimersByTime(RECENT_CHANGE_FADE_MS / 3);
    expect(agentRecentHighlightName(getAgentRecentMarks()[0])).toBe('agent-recent-new-2');
    vi.advanceTimersByTime(RECENT_CHANGE_FADE_MS / 3);
    expect(getAgentRecentMarks()).toEqual([]);
  });
});
