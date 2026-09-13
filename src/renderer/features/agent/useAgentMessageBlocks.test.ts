import { AgentChatTranscript } from '../../domain/agent-chat-transcript';
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
describe('tree display blocks', () => {
  it('reuses stable leaves, changed historical groups and boundary appends without flattening', () => {
    const project = createAgentMessageBlockProjection();
    let source = AgentChatTranscript.from(history(128)); const first = project(source);
    source = source.append({ kind: 'assistant', text: 'Tail' }); const second = project(source);
    expect(second[0]).toBe(first[0]); expect(second[1]).toBe(first[1]); expect(second[2].start).toBe(128);
    const changed = source.replace(63, { kind: 'tool', id: 'tool', name: 'read', status: 'ok' });
    const third = project(changed); expect(third[0]).not.toBe(second[0]); expect(third[1]).toBe(second[1]); expect(third[2]).toBe(second[2]);
    expect(third.flatMap(block => block.messages)).toEqual([...changed]);
    expect(project(source).flatMap(block => block.messages)).toEqual([...source]);
  });
  it('keeps identity reuse for rebuilt hydration trees and mixed legacy array reads', () => {
    const project = createAgentMessageBlockProjection(); const rows = history(130); const first = project(rows);
    expect(project(AgentChatTranscript.from(rows))).toBe(first);
    expect(project([...rows])).toBe(first);
    expect(project(AgentChatTranscript.from(rows))).toBe(first);
    expect(project(AgentChatTranscript.from(rows.slice(0, 64)))).toEqual([first[0]]);
    expect(project(AgentChatTranscript.from([]))).toEqual([]);
  });
  it('handles deep growth, arbitrary history edits and nonmonotonic snapshots', () => {
    const project = createAgentMessageBlockProjection(); const initial = AgentChatTranscript.from(history(32768));
    const before = project(initial); const grown = initial.append({ kind: 'user', text: 'Next' }); const after = project(grown);
    expect(after.slice(0, -1).every((block, i) => block === before[i])).toBe(true);
    expect(after[after.length - 1].start).toBe(32768);
    const changed = grown.replace(1023, { kind: 'assistant', text: 'Changed' }); const result = project(changed);
    expect(result.flatMap(block => block.messages)).toEqual([...changed]);
    expect(project(initial).flatMap(block => block.messages)).toEqual([...initial]);
  });
});
