import { describe, expect, it, vi } from 'vitest';

import { SyncGenerationProvisionSupervisor } from './supervisor';

describe('SyncGenerationProvisionSupervisor', () => {
  it('drains cancelled work and prevents foreground wakeups until the deletion hold is released', async () => {
    let aborted = false;
    const runOnce = vi.fn(async (signal: AbortSignal) => {
      if (runOnce.mock.calls.length === 1) await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
    });
    const supervisor = new SyncGenerationProvisionSupervisor({ canUseProvider: () => true, runOnce, onError: vi.fn() });
    supervisor.requestRun();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledOnce());
    const resume = await supervisor.hold();
    expect(aborted).toBe(true);
    supervisor.requestRun();
    await supervisor.drain();
    expect(runOnce).toHaveBeenCalledOnce();
    resume(); resume();
    await supervisor.drain();
    expect(runOnce).toHaveBeenCalledTimes(2);
    supervisor.stop();
  });
  it('coalesces wakeups into one strictly serialized lane', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const supervisor = new SyncGenerationProvisionSupervisor({
      canUseProvider: () => true,
      onError: vi.fn(),
      async runOnce() {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) await gate;
        active -= 1;
      },
    });

    supervisor.requestRun();
    await vi.waitFor(() => expect(calls).toBe(1));
    supervisor.requestRun();
    supervisor.requestRun();
    release();
    await supervisor.drain();

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    supervisor.stop();
  });

  it('uses bounded full-jitter retry without losing the durable request', async () => {
    let calls = 0;
    let retry: (() => void) | null = null;
    const onError = vi.fn();
    const schedule = vi.fn((callback: () => void, delayMs: number) => {
      retry = callback;
      expect(delayMs).toBe(500);
      return () => {
        retry = null;
      };
    });
    const supervisor = new SyncGenerationProvisionSupervisor({
      canUseProvider: () => true,
      onError,
      random: () => 0.5,
      schedule,
      async runOnce() {
        calls += 1;
        if (calls === 1) throw new Error('temporary provider failure');
      },
    });

    supervisor.requestRun();
    await supervisor.drain();
    expect(onError).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledOnce();
    expect(retry).not.toBeNull();
    retry!();
    await supervisor.drain();

    expect(calls).toBe(2);
    supervisor.stop();
  });
});
