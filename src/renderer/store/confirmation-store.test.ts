import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestAgentConfirm,
  requestConfirmation,
  useConfirmationStore,
} from './confirmation-store';

afterEach(async () => {
  useConfirmationStore.getState().pending?.respond(false);
  await Promise.resolve();
  vi.useRealTimers();
});

describe('application confirmation queue', () => {
  it('keeps synchronous browser confirmation APIs out of renderer call sites', () => {
    const rendererRoot = fileURLToPath(new URL('../', import.meta.url));
    const offenders = globSync('**/*.{ts,tsx}', { cwd: rendererRoot })
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .filter((path) => /\b(?:window\.|globalThis\.)?confirm\s*\(/u.test(
        readFileSync(`${rendererRoot}/${path}`, 'utf8'),
      ));

    expect(offenders).toEqual([]);
  });

  it('keeps product UI requests open until the user responds', async () => {
    vi.useFakeTimers();
    const pending = requestConfirmation('confirm product action', {
      requestId: 'confirm:app',
    });

    expect(useConfirmationStore.getState().pending).toMatchObject({
      requestId: 'confirm:app',
      source: 'app',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(useConfirmationStore.getState().pending?.requestId).toBe('confirm:app');

    useConfirmationStore.getState().pending?.respond(true);
    await expect(pending).resolves.toBe(true);
  });

  it('shows concurrent requests in FIFO order without stranding either promise', async () => {
    const first = requestAgentConfirm('first', { requestId: 'confirm:first' });
    const second = requestAgentConfirm('second', { requestId: 'confirm:second' });

    expect(useConfirmationStore.getState().pending?.requestId).toBe(
      'confirm:first',
    );
    useConfirmationStore.getState().pending?.respond(true);
    await expect(first).resolves.toBe(true);

    expect(useConfirmationStore.getState().pending?.requestId).toBe(
      'confirm:second',
    );
    useConfirmationStore.getState().pending?.respond(false);
    await expect(second).resolves.toBe(false);
    expect(useConfirmationStore.getState().pending).toBeNull();
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
    expect(useConfirmationStore.getState().pending?.requestId).toBe(
      'confirm:active',
    );

    useConfirmationStore.getState().pending?.respond(true);
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

    expect(useConfirmationStore.getState().pending).toMatchObject({
      requestId: 'confirm:provenance',
      source: 'agent',
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      callId: 'call-1',
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBe(false);
    expect(useConfirmationStore.getState().pending).toBeNull();
  });
});
