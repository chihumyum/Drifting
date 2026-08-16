import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  flushOpenYjsDocument,
  flushAllYjsDocumentsLocally,
  registerLocalYjsDocument,
  waitForYjsDocumentTeardown,
} from './yjs-local-durability.service';

const unregisters: Array<() => void> = [];

describe('app-wide Yjs lifecycle flush', () => {
  afterEach(async () => {
    for (const unregister of unregisters.splice(0)) unregister();
    await waitForYjsDocumentTeardown();
  });

  it('persists an open document without a provider transport', async () => {
    const flushLocal = vi.fn(async () => undefined);
    unregisters.push(registerLocalYjsDocument('project-a', 'node-content:local', flushLocal));

    await flushAllYjsDocumentsLocally();

    expect(flushLocal).toHaveBeenCalledOnce();
  });

  it('flushes only the requested live document before an Agent result', async () => {
    const targetFlush = vi.fn(async () => undefined);
    const otherFlush = vi.fn(async () => undefined);
    unregisters.push(
      registerLocalYjsDocument(
        'project-a',
        'node-content:target',
        targetFlush,
      ),
    );
    unregisters.push(
      registerLocalYjsDocument(
        'project-a',
        'node-content:other',
        otherFlush,
      ),
    );

    await flushOpenYjsDocument('node-content:target');

    expect(targetFlush).toHaveBeenCalledOnce();
    expect(otherFlush).not.toHaveBeenCalled();
  });

  it('fails closed when a live doc has no registered durability queue', async () => {
    await expect(
      flushOpenYjsDocument('node-content:unregistered'),
    ).rejects.toThrow('No active Yjs persistence session');
  });

  it('does not resolve the app-wide barrier before every local queue is durable', async () => {
    const order: string[] = [];
    let releaseLocal!: () => void;
    const localBarrier = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const flushLocal = vi.fn(async () => {
      order.push('local:start');
      await localBarrier;
      order.push('local:done');
    });
    unregisters.push(registerLocalYjsDocument('project-a', 'node-content:synced', flushLocal));

    const flushing = flushAllYjsDocumentsLocally();
    await vi.waitFor(() => expect(flushLocal).toHaveBeenCalledOnce());
    releaseLocal();
    await flushing;

    expect(order).toEqual(['local:start', 'local:done']);
  });

  it('keeps teardown pending through the deferred final local flush', async () => {
    let releaseClose!: () => void;
    const closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const unregister = registerLocalYjsDocument(
      'project-a',
      'node-content:closing',
      () => closeBarrier,
    );
    unregister();

    let settled = false;
    const teardown = waitForYjsDocumentTeardown().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseClose();
    await teardown;
    expect(settled).toBe(true);
  });

  it('waits for every registration when the same doc is mounted twice', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const unregisterFirst = registerLocalYjsDocument(
      'project-a',
      'node-content:split',
      () => firstBarrier,
    );
    const unregisterSecond = registerLocalYjsDocument(
      'project-a',
      'node-content:split',
      () => secondBarrier,
    );
    unregisterFirst();
    unregisterSecond();

    let settled = false;
    const teardown = waitForYjsDocumentTeardown().then(() => {
      settled = true;
    });
    releaseSecond();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseFirst();
    await teardown;
    expect(settled).toBe(true);
  });

  it('rejects database-switch teardown when a final local write fails', async () => {
    const unregister = registerLocalYjsDocument(
      'project-a',
      'node-content:failed-close',
      async () => {
        throw new Error('snapshot write failed');
      },
    );
    unregister();

    await expect(waitForYjsDocumentTeardown()).rejects.toThrow(
      '1 Yjs document(s) failed final teardown',
    );
  });
});
