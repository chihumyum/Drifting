import { describe, expect, it, vi } from 'vitest';
import { createDeferredModule } from './deferred-module';

describe('deferred module ownership', () => {
  it('does not expose a speculative failure and retries automatically on first demand', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('Synthetic offline preload')).mockResolvedValue(42);
    const resource = createDeferredModule(loader);
    const idle = resource.getSnapshot();
    const listener = vi.fn(); resource.subscribe(listener);
    await resource.preload();
    expect(resource.getSnapshot()).toBe(idle);
    expect(listener).not.toHaveBeenCalled();
    await resource.load();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 42 });
  });

  it('promotes an in-flight preload to demand without a second fetch and exposes its failure', async () => {
    let reject!: (error: Error) => void;
    const loader = vi.fn(() => new Promise<number>((_yes, no) => { reject = no; }));
    const resource = createDeferredModule(loader);
    const preload = resource.preload();
    expect(resource.getSnapshot()).toEqual({ status: 'idle' });
    expect(resource.load()).toBe(preload);
    expect(resource.getSnapshot()).toEqual({ status: 'loading' });
    await Promise.resolve();
    reject(new Error('Synthetic interrupted foreground load')); await preload;
    expect(resource.getSnapshot().status).toBe('error');
    await resource.preload();
    expect(loader).toHaveBeenCalledOnce();
  });

  it('shares successful preloaded code and coalesces reentrant demand notifications', async () => {
    const loader = vi.fn(async () => 42);
    const resource = createDeferredModule(loader);
    resource.subscribe(() => { if (resource.getSnapshot().status === 'loading') void resource.load(); });
    await resource.preload(); await resource.load();
    expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 42 });
    expect(loader).toHaveBeenCalledOnce();
    const demand = createDeferredModule(loader);
    demand.subscribe(() => { if (demand.getSnapshot().status === 'loading') void demand.load(); });
    await demand.load();
    expect(loader).toHaveBeenCalledTimes(2);
  });

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
