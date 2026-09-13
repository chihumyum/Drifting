import { describe, expect, it } from 'vitest';
import { createAgentConversationRemovalOwner } from './chat-conversation-removal';
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

describe('conversation removal lifetimes', () => {
  it('waits for all overlapping operations while unrelated projects and conversations proceed', async () => {
    const owner = createAgentConversationRemovalOwner(); const first = owner.begin({ projectId: 'p' })!; const second = owner.begin({ conversationId: 'c' })!;
    let ready = false; const waiting = owner.wait('p', 'c').then(value => { ready = value; });
    expect(await owner.wait('other', 'sibling')).toBe(true);
    first(); await settle(); expect(ready).toBe(false); second(); await waiting; expect(ready).toBe(true);
  });
  it('invalidates only affected reads permanently and rejects reads begun during deletion', () => {
    const owner = createAgentConversationRemovalOwner(); const affected = owner.read('p', 'c'); const sibling = owner.read('p', 'sibling');
    const finish = owner.begin({ conversationId: 'c' })!;
    expect(affected.isCurrent()).toBe(false); expect(sibling.isCurrent()).toBe(true);
    const blocked = owner.read('p', 'c'); expect(blocked.isCurrent()).toBe(false); finish(); expect(affected.isCurrent()).toBe(false);
    affected.finish(); sibling.finish(); blocked.finish();
  });
  it('disposes waiting commands without waiting for storage and refuses new operations', async () => {
    const owner = createAgentConversationRemovalOwner(); const finish = owner.begin({ projectId: 'p' })!;
    const waiting = owner.wait('p', null); const read = owner.read('other', 'c'); owner.dispose();
    expect(await waiting).toBe(false); expect(read.isCurrent()).toBe(false); expect(owner.begin({ projectId: 'p' })).toBeNull(); finish();
  });
});
