import { describe, expect, it } from 'vitest';
import { AgentChatTranscript } from './agent-chat-transcript';
import type { AgentChatMessage } from './agent-conversation';

const message = (index: number): AgentChatMessage => Object.freeze({ kind: 'assistant', text: `Synthetic ${index}` });
describe('immutable live transcript', () => {
  it.each([0, 1, 31, 32, 33, 1023, 1024, 1025, 32768, 32769])('preserves snapshots and array/index reads at tree boundary %i', length => {
    const source = Object.freeze(Array.from({ length }, (_, index) => message(index)));
    const initial = AgentChatTranscript.from(source); const array = initial.toArray();
    expect(array).toEqual(source); expect(initial.toArray()).toBe(array);
    expect(initial.at(-1)).toBeUndefined(); expect(initial.at(length)).toBeUndefined(); expect(initial.at(0.5)).toBeUndefined();
    const appended = initial.append(message(length), message(length + 1));
    expect(appended.toArray()).toEqual([...source, message(length), message(length + 1)]);
    expect(initial.toArray()).toBe(array); expect(initial.length).toBe(length);
    const updated = appended.replace(Math.floor(length / 2), message(-1));
    expect(updated.at(Math.floor(length / 2))).toEqual(message(-1));
    expect(appended.at(Math.floor(length / 2))).toEqual(message(Math.floor(length / 2)));
    expect(updated.replace(0, updated.at(0)!)).toBe(updated);
    expect(() => updated.replace(-1, message(0))).toThrow(RangeError);
    expect(() => updated.replace(updated.length, message(0))).toThrow(RangeError);
  });
  it('searches historical leaves backwards without materializing arrays or revisiting messages', () => {
    const source = Array.from({ length: 32769 }, (_, index) => message(index));
    const transcript = AgentChatTranscript.from(source); const visited: AgentChatMessage[] = [];
    expect(transcript.findLastIndex(value => { visited.push(value); return value === source[0]; })).toBe(0);
    expect(visited).toEqual([...source].reverse());
    expect(transcript.findLastIndex(value => value === source[32768])).toBe(32768);
    expect(transcript.findLastIndex(() => false)).toBe(-1);
    expect(AgentChatTranscript.from([]).findLastIndex(() => true)).toBe(-1);
  });
  it('matches an array through mixed growth and arbitrary historical replacements', () => {
    let transcript = AgentChatTranscript.from([]); const expected: AgentChatMessage[] = [];
    let seed = 17; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let operation = 0; operation < 10_000; operation++) {
      const value = message(operation);
      if (!expected.length || random() % 3 !== 0) { expected.push(value); transcript = transcript.append(value); }
      else { const index = random() % expected.length; expected[index] = value; transcript = transcript.replace(index, value); }
      expect(transcript.length).toBe(expected.length);
      const index = random() % expected.length; expect(transcript.at(index)).toBe(expected[index]);
      if (operation % 1000 === 0) expect(transcript.toArray()).toEqual(expected);
    }
    expect(transcript.toArray()).toEqual(expected);
  });
});
