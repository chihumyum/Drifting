import { describe, expect, it, vi } from 'vitest';
import { createDeferredModule } from './deferred-module';

describe('deferred module ownership', () => {
  it('stays idle until requested and shares concurrent and successful loads', async () => {
    const value = { component: 'synthetic' };
    const loader = vi.fn(async () => value);
    const resource = createDeferredModule(loader);
    const listener = vi.fn(); resource.subscribe(listener);
    expect(resource.getSnapshot()).toEqual({ status: 'idle' });
    expect(loader).not.toHaveBeenCalled();
    const first = resource.load(); expect(resource.load()).toBe(first);
    expect(resource.getSnapshot()).toEqual({ status: 'loading' });
    await first; await resource.load();
    expect(loader).toHaveBeenCalledOnce();
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('publishes a local error and retries a rejected loader only when requested', async () => {
    const error = new Error('Synthetic module unavailable');
    const loader = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ ready: true });
    const resource = createDeferredModule(loader);
    await resource.load();
    const failed = resource.getSnapshot();
    expect(failed).toEqual({ status: 'error', error });
    expect(resource.getSnapshot()).toBe(failed);
    expect(loader).toHaveBeenCalledOnce();
    await resource.load();
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: { ready: true } });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('handles synchronous loader failure without leaving a stuck loading state', async () => {
    const error = new Error('Synthetic synchronous failure');
    const resource = createDeferredModule(() => { throw error; });
    await resource.load();
    expect(resource.getSnapshot()).toEqual({ status: 'error', error });
  });

  it('does not notify closed consumers and retains code for a later owner', async () => {
    let resolve!: (value: number) => void;
    const resource = createDeferredModule(() => new Promise<number>((yes) => { resolve = yes; }));
    const listener = vi.fn(); const unsubscribe = resource.subscribe(listener);
    const load = resource.load(); await Promise.resolve();
    unsubscribe(); resolve(42); await load;
    expect(listener).toHaveBeenCalledOnce();
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 42 });
    const later = vi.fn(); resource.subscribe(later); await resource.load();
    expect(later).not.toHaveBeenCalled();
  });
});
