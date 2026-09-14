import { expect, it } from 'vitest';
import { AgentChatTranscript } from '../../domain/agent-chat-transcript';
import type { AgentChatMessage } from '../../domain/agent-conversation';
import { createAgentTranscriptSummary } from './agent-transcript-summary';
import { createAgentMessageBlockProjection } from './useAgentMessageBlocks';

const text = (value: number): AgentChatMessage => Object.freeze({ kind: 'assistant', text: `Synthetic ${value}`, streaming: true });
const usage = (value: number): AgentChatMessage => Object.freeze({ kind: 'usage', inputTokens: value, outputTokens: value + 1,
  cacheReadTokens: 2, cacheCreationTokens: 3, costUsd: value / 100, turns: 1 });
const tool = (value: number, status: 'ok' | 'error' | 'running' = 'ok'): AgentChatMessage =>
  Object.freeze({ kind: 'tool', id: `tool-${value}`, name: 'synthetic_inspect', status, result: `Result ${value}` });
function oracle(rows: readonly AgentChatMessage[]) {
  let inTok = 0; let outTok = 0; let cost = 0; let tools = 0;
  for (const row of rows) {
    if (row.kind === 'usage') { inTok += row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens; outTok += row.outputTokens; cost += row.costUsd; }
    else if (row.kind === 'tool') tools++;
  }
  return { inTok, outTok, cost, tools };
}
const successful = (rows: readonly AgentChatMessage[]) => rows.filter(row => row.kind === 'tool' && row.status === 'ok');
function setup() { const blocks = createAgentMessageBlockProjection(); const summary = createAgentTranscriptSummary(); return (value: AgentChatTranscript) => summary(blocks(value)); }

it('matches the original ordered usage fold and successful-tool filter across mixed history', () => {
  const rows = Array.from({ length: 1025 }, (_, i) => i % 13 === 0 ? usage(i) : i % 7 === 0 ? tool(i, i % 2 ? 'ok' : 'error') : text(i));
  const transcript = AgentChatTranscript.from(rows); const project = setup(); const result = project(transcript);
  expect(result.usage).toEqual(oracle(rows)); expect([...result.successfulTools]).toEqual(successful(rows));
  expect(project(transcript)).toBe(result); expect([...result.successfulTools]).toEqual([...result.successfulTools]);
});

it('does not classify unchanged historical messages and preserves totals during tail-only updates', () => {
  let historicalReads = 0;
  const historical = Array.from({ length: 128 }, (_, i) => ({ get kind() { historicalReads++; return 'assistant' as const; }, text: `History ${i}` }));
  let transcript = AgentChatTranscript.from([...historical, tool(1), usage(10), text(0)]); const project = setup();
  const first = project(transcript); historicalReads = 0;
  for (let i = 0; i < 20; i++) {
    transcript = transcript.replace(130, text(i)); const next = project(transcript);
    expect(next.usage).toBe(first.usage); expect([...next.successfulTools]).toEqual([tool(1)]);
  }
  expect(historicalReads).toBe(0);
});

it('preserves floating-point addition order across boundaries and preceding usage edits', () => {
  const rows = Array.from({ length: 129 }, (_, i) => text(i));
  const cost = (value: number): AgentChatMessage => ({ ...usage(0), kind: 'usage', inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, turns: 1, costUsd: value });
  rows[0] = cost(1e16); rows[64] = cost(-1e16); rows[65] = cost(1);
  const project = setup(); let transcript = AgentChatTranscript.from(rows);
  expect(project(transcript).usage.cost).toBe(1);
  for (const value of [0, 2, -0, Infinity, -Infinity, NaN, 1e16]) {
    transcript = transcript.replace(0, cost(value));
    expect(project(transcript).usage).toEqual(oracle(transcript.toArray()));
  }
});

it('keeps old results immutable through historical tool changes, growth, truncation and reset', () => {
  const project = setup(); const initial = AgentChatTranscript.from(Array.from({ length: 128 }, (_, i) => i === 63 ? tool(i) : i === 64 ? usage(i) : text(i)));
  const original = project(initial); const retainedTools = original.successfulTools[Symbol.iterator]();
  const grown = initial.append(tool(128, 'running'), usage(129)); const grownResult = project(grown);
  const changed = grown.replace(63, tool(63, 'error')).replace(128, tool(128));
  expect([...project(changed).successfulTools]).toEqual([tool(128)]);
  expect([...original.successfulTools]).toEqual([tool(63)]); expect(retainedTools.next().value).toEqual(tool(63));
  expect(grownResult.usage).toEqual(oracle(grown.toArray()));
  for (const value of [initial, AgentChatTranscript.from(initial.toArray().slice(0, 64)), AgentChatTranscript.from([]), grown]) {
    const result = project(value); expect(result.usage).toEqual(oracle(value.toArray())); expect([...result.successfulTools]).toEqual(successful(value.toArray()));
  }
});

it('does not share per-view state or keep a prior conversation after an empty projection', () => {
  const first = setup(); const second = setup(); const a = AgentChatTranscript.from([tool(1), usage(1)]); const b = AgentChatTranscript.from([tool(2), usage(2)]);
  expect(first(a).usage).toEqual(oracle(a.toArray())); expect(second(b).usage).toEqual(oracle(b.toArray()));
  expect(first(AgentChatTranscript.from([])).usage).toEqual(oracle([])); expect([...first(b).successfulTools]).toEqual([tool(2)]);
  expect([...second(a).successfulTools]).toEqual([tool(1)]);
});

it('matches independent folds through seeded replacements, appends, rehydration and earlier snapshots', () => {
  const project = setup(); let transcript = AgentChatTranscript.from(Array.from({ length: 1000 }, (_, i) => i % 20 === 0 ? usage(i) : i % 10 === 0 ? tool(i) : text(i)));
  let seed = 419; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const retained: AgentChatTranscript[] = [transcript];
  for (let i = 0; i < 800; i++) {
    const choice = random() % 7; const value = choice < 2 ? usage(i) : choice < 4 ? tool(i, i % 3 === 0 ? 'running' : 'ok') : text(i);
    if (choice === 0) transcript = retained[random() % retained.length];
    else if (choice === 1) transcript = AgentChatTranscript.from(transcript.toArray());
    else if (choice === 2) transcript = transcript.append(value);
    else transcript = transcript.replace(random() % transcript.length, value);
    const rows = transcript.toArray(); const result = project(transcript);
    expect(result.usage).toEqual(oracle(rows)); expect([...result.successfulTools]).toEqual(successful(rows));
    if (i % 100 === 0) retained.push(transcript);
  }
});
