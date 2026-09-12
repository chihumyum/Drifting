import { describe, expect, it } from 'vitest';
import { createAgentChatJournalScope, hasAgentChatJournalEvent, rememberAgentChatJournalEvent } from './chat-journal-dedup';

describe('private chat journal membership', () => {
  it('seeds recovery IDs and retains durable and transient identity independently', () => {
    const scope = createAgentChatJournalScope(['turn:1', 'turn:2']);
    expect(hasAgentChatJournalEvent(scope, 'turn:1')).toBe(true);
    expect(hasAgentChatJournalEvent(scope, 'turn:transient:1')).toBe(false);
    rememberAgentChatJournalEvent(scope, 'turn:transient:1');
    expect(hasAgentChatJournalEvent(scope, 'turn:transient:1')).toBe(true);
    expect(hasAgentChatJournalEvent(scope, 'turn:2')).toBe(true);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Reflect.ownKeys(scope)).toEqual([]);
  });

  it('does not truncate unacknowledged IDs or share membership across generations', () => {
    const scope = createAgentChatJournalScope();
    for (let index = 0; index < 20_000; index++) rememberAgentChatJournalEvent(scope, String(index));
    expect(hasAgentChatJournalEvent(scope, '0')).toBe(true);
    expect(hasAgentChatJournalEvent(scope, '19999')).toBe(true);
    expect(hasAgentChatJournalEvent(createAgentChatJournalScope(), '0')).toBe(false);
    rememberAgentChatJournalEvent(scope, '__proto__');
    expect(hasAgentChatJournalEvent(scope, '__proto__')).toBe(true);
    expect(hasAgentChatJournalEvent(scope, 'constructor')).toBe(false);
  });
});
