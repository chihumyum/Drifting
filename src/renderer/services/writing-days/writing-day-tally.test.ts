import { describe, expect, it } from 'vitest';

import { tallyWritingDay, type WritingDayTallyState } from './writing-day-tally';

const day = '2026-11-03';

describe('the words a device adds to a book on a day', () => {
  it('counts from where the day began, and deleting more than was written reads zero', () => {
    let state: WritingDayTallyState | null = null;
    state = tallyWritingDay(state, { total: 1000, day, storedWords: 0, remote: false });
    expect(state.words).toBe(0);
    state = tallyWritingDay(state, { total: 1240, day, storedWords: 0, remote: false });
    expect(state.words).toBe(240);
    state = tallyWritingDay(state, { total: 900, day, storedWords: 0, remote: false });
    expect(state.words).toBe(0);
    state = tallyWritingDay(state, { total: 1100, day, storedWords: 0, remote: false });
    expect(state.words).toBe(100);
  });

  it('keeps the words already stored for the day when the book opens again', () => {
    const state = tallyWritingDay(null, { total: 5000, day, storedWords: 300, remote: false });
    expect(state.words).toBe(300);
    expect(tallyWritingDay(state, { total: 5050, day, storedWords: 0, remote: false }).words).toBe(350);
  });

  it('leaves words that arrived from another device to the device that wrote them', () => {
    let state = tallyWritingDay(null, { total: 1000, day, storedWords: 0, remote: false });
    state = tallyWritingDay(state, { total: 1200, day, storedWords: 0, remote: false });
    state = tallyWritingDay(state, { total: 1700, day, storedWords: 0, remote: true });
    expect(state.words).toBe(200);
    state = tallyWritingDay(state, { total: 1750, day, storedWords: 0, remote: false });
    expect(state.words).toBe(250);
  });

  it('starts a new day from its own stored words', () => {
    const yesterday = tallyWritingDay(null, { total: 1000, day: '2026-11-02', storedWords: 400, remote: false });
    const today = tallyWritingDay(yesterday, { total: 1100, day, storedWords: 0, remote: false });
    expect(today).toEqual({ day, baseline: 1100, lastTotal: 1100, words: 0 });
  });
});
