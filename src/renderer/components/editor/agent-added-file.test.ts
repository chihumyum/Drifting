import { describe, expect, it } from 'vitest';

import { planAgentAddedProseReveal } from './agent-added-file';

describe('General Agent added-file prose reveal', () => {
  it('plans every textual top-level block as a new reveal in document order', () => {
    expect(
      planAgentAddedProseReveal([
        { blockId: 'heading', text: '第一章' },
        { blockId: 'blank', text: '   ' },
        { blockId: 'paragraph', text: '雨落在旧码头。' },
      ]),
    ).toEqual([
      {
        blockId: 'heading',
        op: 'new',
        oldText: '',
        newText: '第一章',
        afterPrevId: null,
      },
      {
        blockId: 'paragraph',
        op: 'new',
        oldText: '',
        newText: '雨落在旧码头。',
        afterPrevId: 'blank',
      },
    ]);
  });

  it('deduplicates malformed repeated block ids instead of double-playing a reveal', () => {
    expect(
      planAgentAddedProseReveal([
        { blockId: 'same', text: 'A' },
        { blockId: 'same', text: 'B' },
      ]).map((change) => change.newText),
    ).toEqual(['A']);
  });
});
