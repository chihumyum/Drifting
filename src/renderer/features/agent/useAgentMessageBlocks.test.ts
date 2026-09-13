import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../domain/agent-conversation';
import { createAgentMessageBlockProjection } from './useAgentMessageBlocks';

const history = (length: number): readonly AgentChatMessage[] => Object.freeze(Array.from({ length }, (_, index) => Object.freeze({ kind: 'assistant' as const, text: `Synthetic ${index}` })));
describe('display message blocks', () => {
  it('retains historical blocks while updating the current stream without mutating snapshots', () => {
    const project = createAgentMessageBlockProjection(); const initial = history(130); const first = project(initial);
    const next = [...initial]; next[129] = { kind: 'assistant', text: 'New tail', streaming: true };
    const second = project(next);
    expect(second[0]).toBe(first[0]); expect(second[1]).toBe(first[1]); expect(second[2]).not.toBe(first[2]);
    expect(second.flatMap(block => block.messages)).toEqual(next);
    expect(first.flatMap(block => block.messages)).toEqual(initial);
    expect(project([...next])).toBe(second);
  });
  it('handles tool updates, boundary appends and truncation using current global indices', () => {
    const project = createAgentMessageBlockProjection(); const initial = history(128); const first = project(initial);
    const appended = [...initial, { kind: 'user' as const, text: 'Next turn' }]; const second = project(appended);
    expect(second[0]).toBe(first[0]); expect(second[1]).toBe(first[1]); expect(second[2].start).toBe(128);
    const updated = [...appended]; updated[63] = { kind: 'tool', id: 'synthetic-tool', name: 'inspect', status: 'ok', result: 'Updated result' };
    const third = project(updated); expect(third[0]).not.toBe(second[0]); expect(third[1]).toBe(second[1]); expect(third[2]).toBe(second[2]);
    const truncated = project(updated.slice(0, 64)); expect(truncated).toEqual([third[0]]); expect(project([])).toEqual([]);
  });
  it('keeps arbitrary replacement and abandoned-render snapshots correct without a monotonic assumption', () => {
    const project = createAgentMessageBlockProjection(); const a = history(65); const b = history(65);
    const first = project(a); const second = project(b); expect(second[0]).not.toBe(first[0]);
    expect(project(a).flatMap(block => block.messages)).toEqual(a);
    const inserted: AgentChatMessage[] = [{ kind: 'user', text: 'Prepended context' }, ...b];
    const result = project(inserted); expect(result.flatMap(block => block.messages)).toEqual(inserted);
    expect(result.map(block => block.start)).toEqual([0, 64]);
    expect(createAgentMessageBlockProjection()(b)[0]).not.toBe(second[0]);
  });
});
