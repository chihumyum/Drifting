import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../../domain/agent-conversation';
import { AgentChatTranscript } from '../../../domain/agent-chat-transcript';
import { applyAgentChatJournalEntry, applyAgentChatTranscriptEntry } from './chat-journal-projection';
import type { AgentRuntimeEvent, AgentRuntimeJournalEntry } from './types';
import { AGENT_RUNTIME_SCHEMA_VERSION } from './types';

const ROUTE = { kind: 'chat', projectId: 'project-1' } as const;

function entry(
  seq: number,
  event: AgentRuntimeEvent,
  transient = false,
): AgentRuntimeJournalEntry {
  return {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    sessionId: 'session-1',
    turnId: 'turn-1',
    route: ROUTE,
    seq,
    eventId: transient
      ? `turn-1:transient:${String(seq).padStart(8, '0')}`
      : `turn-1:${String(seq).padStart(8, '0')}`,
    wallTimeMs: 1_800_000_000_000 + seq,
    event,
    ...(transient ? { transient: true as const } : {}),
  };
}

function foldArray(entries: readonly AgentRuntimeJournalEntry[]): AgentChatMessage[] {
  let messages: AgentChatMessage[] = [];
  for (const item of entries) messages = applyAgentChatJournalEntry(messages, item);
  return messages;
}

function foldTranscript(entries: readonly AgentRuntimeJournalEntry[]): AgentChatMessage[] {
  let transcript = AgentChatTranscript.from([]);
  for (const item of entries) transcript = applyAgentChatTranscriptEntry(transcript, item);
  return transcript.toArray();
}

describe.each([['array', foldArray], ['live transcript', foldTranscript]] as const)('canonical thinking runs: %s', (_, fold) => {
  it('appends historical per-chunk thinking rows into one streaming message', () => {
    const messages = fold([
      entry(1, { type: 'thinking_delta', iteration: 1, text: '先想' }),
      entry(2, { type: 'thinking_delta', iteration: 1, text: '一想。' }),
    ]);

    expect(messages).toEqual([{ kind: 'thinking', text: '先想一想。', streaming: true }]);
  });

  it('replaces a transient-built streaming run with its consolidated row without duplicating', () => {
    const messages = fold([
      entry(1, { type: 'thinking_delta', iteration: 1, text: '先想' }, true),
      entry(2, { type: 'thinking_delta', iteration: 1, text: '一想。' }, true),
      entry(3, { type: 'thinking_delta', iteration: 1, text: '先想一想。', consolidated: true }),
    ]);

    expect(messages).toEqual([{ kind: 'thinking', text: '先想一想。', streaming: false }]);
  });

  it('materializes a lone consolidated row on replay as a finished thinking message', () => {
    const messages = fold([
      entry(1, { type: 'thinking_delta', iteration: 1, text: '先想一想。', consolidated: true }),
    ]);

    expect(messages).toEqual([{ kind: 'thinking', text: '先想一想。', streaming: false }]);
  });

  it('keeps adjacent consolidated runs as separate messages instead of clobbering the first', () => {
    const messages = fold([
      entry(1, { type: 'thinking_delta', iteration: 1, text: '第一段推理。', consolidated: true }),
      entry(2, { type: 'thinking_delta', iteration: 1, text: '第二段推理。', consolidated: true }),
    ]);

    expect(messages).toEqual([
      { kind: 'thinking', text: '第一段推理。', streaming: false },
      { kind: 'thinking', text: '第二段推理。', streaming: false },
    ]);
  });

  it('starts a fresh streaming run after a consolidated run finished the previous one', () => {
    const messages = fold([
      entry(1, { type: 'thinking_delta', iteration: 1, text: '第一段。' }, true),
      entry(2, { type: 'thinking_delta', iteration: 1, text: '第一段。', consolidated: true }),
      entry(3, { type: 'thinking_delta', iteration: 1, text: '第二段' }, true),
    ]);

    expect(messages).toEqual([
      { kind: 'thinking', text: '第一段。', streaming: false },
      { kind: 'thinking', text: '第二段', streaming: true },
    ]);
  });
});
