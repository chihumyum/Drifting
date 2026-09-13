import { expect, it } from 'vitest';
import { replayAgentRuntimeJournal } from '../lib/agent/runtime/reducer';
import { applyAgentChatJournalEntry } from '../lib/agent/runtime/chat-journal-projection';
import type { AgentChatMessage } from '../domain/agent-conversation';
import { createAgentChatCrashFixture } from './agent-chat-crash-fixture';

it.each([1, 2])('strictly replays synthetic crash trace %i and agrees with the independent full display oracle', seed => {
  for (const mixed of [false, true]) {
    const fixture = createAgentChatCrashFixture(seed, mixed);
    expect(fixture.entries).toHaveLength(mixed ? 25 : 7);
    expect(replayAgentRuntimeJournal(fixture.entries)).toMatchObject({ status: 'completed', prompt: fixture.prompt,
      modelIterations: mixed ? 2 : 1, usage: { inputTokens: mixed ? 6 : 3, outputTokens: mixed ? 8 : 4 } });
    const live = fixture.entries.reduce<AgentChatMessage[]>((messages, entry) => applyAgentChatJournalEntry(messages, entry), [fixture.user]);
    expect(live).toEqual(fixture.expected(fixture.entries.length, true));
    if (mixed) for (const through of [6, 14, 15, 17, 21]) {
      expect(() => replayAgentRuntimeJournal(fixture.entries.slice(0, through))).not.toThrow();
    }
  }
});
