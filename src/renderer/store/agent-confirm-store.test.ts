import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestAgentConfirm,
  useAgentConfirmStore,
} from './agent-confirm-store';

afterEach(async () => {
  useAgentConfirmStore.getState().pending?.respond(false);
  await Promise.resolve();
  vi.useRealTimers();
});

describe('agent confirmation queue', () => {
  it('shows concurrent requests in FIFO order without stranding either promise', async () => {
    const first = requestAgentConfirm('first', { requestId: 'confirm:first' });
    const second = requestAgentConfirm('second', { requestId: 'confirm:second' });

    expect(useAgentConfirmStore.getState().pending?.requestId).toBe(
      'confirm:first',
    );
    useAgentConfirmStore.getState().pending?.respond(true);
    await expect(first).resolves.toBe(true);

    expect(useAgentConfirmStore.getState().pending?.requestId).toBe(
      'confirm:second',
    );
    useAgentConfirmStore.getState().pending?.respond(false);
    await expect(second).resolves.toBe(false);
    expect(useAgentConfirmStore.getState().pending).toBeNull();
  });

  it('cancels a queued request by signal without disturbing the active one', async () => {
    const active = requestAgentConfirm('active', { requestId: 'confirm:active' });
    const controller = new AbortController();
    const queued = requestAgentConfirm('queued', {
      requestId: 'confirm:queued',
      signal: controller.signal,
    });

    controller.abort();
    await expect(queued).resolves.toBe(false);
    expect(useAgentConfirmStore.getState().pending?.requestId).toBe(
      'confirm:active',
    );

    useAgentConfirmStore.getState().pending?.respond(true);
    await expect(active).resolves.toBe(true);
  });

  it('auto-declines on timeout and carries exact call provenance', async () => {
    vi.useFakeTimers();
    const pending = requestAgentConfirm('dangerous write', {
      requestId: 'confirm:provenance',
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'call-1',
      timeoutMs: 25,
    });

    expect(useAgentConfirmStore.getState().pending).toMatchObject({
      requestId: 'confirm:provenance',
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'call-1',
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBe(false);
    expect(useAgentConfirmStore.getState().pending).toBeNull();
  });
});
