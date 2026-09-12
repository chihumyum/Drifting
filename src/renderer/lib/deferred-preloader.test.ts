import { describe, expect, it, vi } from 'vitest';
import { createDeferredModule } from './deferred-module';
import { createDeferredPreloader } from './deferred-preloader';

function setup() {
  const jobs: Array<{ run: () => void; canceled: boolean }> = [];
  let allowed = true;
  const queue = createDeferredPreloader({
    allowed: () => allowed,
    schedule(run) {
      const job = { run, canceled: false }; jobs.push(job);
      return () => { job.canceled = true; };
    },
  });
  return { queue, jobs, disallow() { allowed = false; }, flush() {
    for (const job of jobs.splice(0)) if (!job.canceled) job.run();
  } };
}
const settle = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };

describe('bounded deferred preloading', () => {
  it('waits for intent scheduling, keeps only the latest queued entry and cancels before start', async () => {
    const { queue, jobs, flush } = setup();
    const firstLoad = vi.fn(async () => 1); const latestLoad = vi.fn(async () => 2);
    const first = createDeferredModule(firstLoad); const latest = createDeferredModule(latestLoad);
    queue.request(first); const oldJob = jobs[0];
    const cancel = queue.request(latest);
    oldJob.run(); // An already-dispatched canceled idle callback must not touch its replacement.
    expect(firstLoad).not.toHaveBeenCalled(); expect(latestLoad).not.toHaveBeenCalled();
    cancel(); flush(); await settle();
    expect(firstLoad).not.toHaveBeenCalled(); expect(latestLoad).not.toHaveBeenCalled();
    queue.request(latest); flush(); await settle();
    expect(latestLoad).toHaveBeenCalledOnce();
  });

  it('allows one active speculative load and one queued successor, without blocking foreground demand', async () => {
    const { queue, flush } = setup();
    let finish!: () => void;
    const slow = createDeferredModule(() => new Promise<void>((resolve) => { finish = resolve; }));
    const droppedLoad = vi.fn(async () => 2); const nextLoad = vi.fn(async () => 3);
    const dropped = createDeferredModule(droppedLoad); const next = createDeferredModule(nextLoad);
    queue.request(slow); flush(); await settle();
    queue.request(dropped); queue.request(next); flush(); await settle();
    expect(droppedLoad).not.toHaveBeenCalled(); expect(nextLoad).not.toHaveBeenCalled();
    await next.load(); // A click is immediate even while an unrelated import remains in flight.
    expect(nextLoad).toHaveBeenCalledOnce();
    finish(); await settle(); flush(); await settle();
    expect(droppedLoad).not.toHaveBeenCalled(); expect(nextLoad).toHaveBeenCalledOnce();
  });

  it('starts the queued preload only after the active import settles', async () => {
    const { queue, flush } = setup(); let finish!: () => void;
    const slow = createDeferredModule(() => new Promise<void>((resolve) => { finish = resolve; }));
    const nextLoad = vi.fn(async () => 2); const next = createDeferredModule(nextLoad);
    queue.request(slow); flush(); await settle(); queue.request(next); flush(); await settle();
    expect(nextLoad).not.toHaveBeenCalled(); finish(); await settle();
    expect(nextLoad).not.toHaveBeenCalled(); flush(); await settle(); expect(nextLoad).toHaveBeenCalledOnce();
  });

  it('lets a canceled control release its queued successor without canceling another owner', async () => {
    const { queue, flush } = setup();
    const loader = vi.fn(async () => 1); const resource = createDeferredModule(loader);
    const oldCancel = queue.request(resource); const currentCancel = queue.request(resource);
    oldCancel(); flush(); await settle(); expect(loader).toHaveBeenCalledOnce(); currentCancel();
  });

  it('attempts each resource speculatively once, leaves failed demand alone and permits explicit retry', async () => {
    const { queue, flush } = setup();
    const loader = vi.fn().mockRejectedValueOnce(new Error('Synthetic prefetch failure')).mockRejectedValueOnce(new Error('Synthetic demand failure')).mockResolvedValue(42);
    const resource = createDeferredModule(loader);
    queue.request(resource); flush(); await settle();
    queue.request(resource); flush(); await settle(); expect(loader).toHaveBeenCalledOnce();
    await resource.load(); queue.request(resource); flush(); await settle();
    expect(resource.getSnapshot().status).toBe('error'); expect(loader).toHaveBeenCalledTimes(2);
    await resource.load(); expect(resource.getSnapshot()).toEqual({ status: 'ready', value: 42 });
  });

  it('rechecks eligibility after waiting, including a queued task behind an active import', async () => {
    const { queue, flush, disallow } = setup(); let finish!: () => void;
    const slow = createDeferredModule(() => new Promise<void>((resolve) => { finish = resolve; }));
    const loader = vi.fn(async () => 2); const resource = createDeferredModule(loader);
    queue.request(slow); flush(); await settle(); queue.request(resource);
    disallow(); finish(); await settle(); flush(); await settle();
    queue.request(resource); flush(); await settle(); expect(loader).not.toHaveBeenCalled();
  });
});
