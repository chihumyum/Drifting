import { expect, it } from 'vitest';
import { createNativeAgentTranscriptJournal } from './native-agent-transcript-scenario';
import { replayAgentRuntimeJournal } from '../lib/agent/runtime/reducer';

it('uses a complete, strictly replayable native persistence fixture', () => {
  const entries = createNativeAgentTranscriptJournal('synthetic-project', '2026-01-01T00:00:00.000Z');
  expect(entries).toHaveLength(9);
  expect(entries.every((entry, index) => entry.seq === index + 1 && entry.eventId === `${entry.turnId}:${String(index + 1).padStart(8, '0')}`)).toBe(true);
  expect(replayAgentRuntimeJournal(entries)).toMatchObject({ status: 'completed', prompt: 'Synthetic durable transcript request', assistantText: 'Native canonical tail.', modelIterations: 1,
    usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
});
