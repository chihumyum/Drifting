import { describe, expect, it } from 'vitest';
import { CopilotInvocationOwner } from './invocation-owner';

describe('Copilot invocation lifetime', () => {
  it('cancels work already preparing context and never revives a disposed owner', () => {
    const owner = new CopilotInvocationOwner(() => true); const pending = owner.begin('cap')!;
    owner.dispose(); owner.dispose();
    expect(pending.signal.aborted).toBe(true); expect(pending.isCurrent()).toBe(false);
    expect(owner.has('cap')).toBe(false); expect(owner.begin('cap')).toBeNull();
  });
  it('keeps independent capabilities and summaries while replacing only the same capability', () => {
    const owner = new CopilotInvocationOwner(() => true);
    const first = owner.begin('a')!; const other = owner.begin('b')!; const summary = owner.begin(Symbol('summary'))!;
    const next = owner.begin('a')!; first.finish();
    expect(first.signal.aborted).toBe(true); expect(next.isCurrent()).toBe(true);
    expect(other.isCurrent()).toBe(true); expect(summary.isCurrent()).toBe(true);
    next.finish(); owner.dispose(); expect(other.signal.aborted).toBe(true); expect(summary.signal.aborted).toBe(true);
  });
  it('refuses new work and current actions on an unavailable editor', () => {
    let available = true; const owner = new CopilotInvocationOwner(() => available); const run = owner.begin('cap')!;
    available = false; expect(run.isCurrent()).toBe(false); expect(owner.begin('other')).toBeNull(); owner.dispose();
  });
  it('keeps synchronous cancellation listeners from leaving a replacement orphaned', () => {
    const owner = new CopilotInvocationOwner(() => true); const first = owner.begin('cap')!;
    first.signal.addEventListener('abort', () => owner.dispose());
    const next = owner.begin('cap')!;
    expect(next.signal.aborted).toBe(true); expect(next.isCurrent()).toBe(false); expect(owner.has('cap')).toBe(false);
  });
});
