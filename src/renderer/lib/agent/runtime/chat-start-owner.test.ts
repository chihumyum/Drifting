import { describe, expect, it } from 'vitest';
import { createAgentChatStartOwner } from './chat-start-owner';

describe('chat startup intent lifetime', () => {
  it('rejects overlapping starts and only releases the lease that owns preparation', () => {
    const busy: boolean[] = []; const owner = createAgentChatStartOwner(value => busy.push(value));
    const first = owner.begin('project', 'first')!; let discarded = 0;
    expect(owner.begin('project', 'other')).toBeNull();
    first.prepareTurn('first', () => { discarded++; });
    expect(first.isCurrent('other-project')).toBe(false);
    owner.cancelConversation('other'); expect(first.isCurrent('project')).toBe(true);
    owner.invalidate(); expect(discarded).toBe(1); expect(first.submit()).toBe(false);
    const second = owner.begin('project', 'second')!;
    first.finish(); first.finish(); expect(discarded).toBe(1);
    expect(second.isCurrent('project')).toBe(true); expect(busy).toEqual([true, false, true]);
    second.finish(); expect(busy).toEqual([true, false, true, false]);
  });

  it('keeps submitted background turns independent, but retains a later explicit cancellation', () => {
    const owner = createAgentChatStartOwner(() => undefined); let discarded = 0;
    const first = owner.begin('project', 'first')!; first.prepareTurn('fork', () => { discarded++; });
    expect(first.submit()).toBe(true); owner.invalidate(); expect(discarded).toBe(0);
    const next = owner.begin('project', 'next')!;
    owner.cancelConversation('first'); expect(first.shouldAbort()).toBe(false);
    owner.cancelConversation('fork'); expect(first.shouldAbort()).toBe(true);
    expect(next.isCurrent('project')).toBe(true);
    first.finish(); expect(next.isCurrent('project')).toBe(true);
    next.finish(); owner.dispose();
  });

  it('disposes pending and submitted ownership once, including a late preparation registration', () => {
    const busy: boolean[] = []; const owner = createAgentChatStartOwner(value => busy.push(value));
    const submitted = owner.begin('project', 'submitted')!; submitted.submit(); owner.invalidate();
    const pending = owner.begin('project', null)!; let discarded = 0;
    owner.dispose(); owner.dispose();
    pending.prepareTurn('late', () => { discarded++; });
    pending.finish(); submitted.finish();
    expect(discarded).toBe(1); expect(submitted.shouldAbort()).toBe(true);
    expect(pending.submit()).toBe(false); expect(owner.begin('project', 'after-dispose')).toBeNull();
    expect(busy).toEqual([true, false, true, false]);
  });
});
