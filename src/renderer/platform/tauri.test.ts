import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: tauriMocks.convertFileSrc,
  invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen,
}));

import { tauriPlatform } from './tauri';
import { createPendingNativeOAuthState, NATIVE_OAUTH_STATE_TTL_MS } from './native-oauth-state';

type DeepLinkEventHandler = (event: { payload: { urls: string[] } }) => void;

describe('tauri OAuth callback delivery', () => {
  let eventHandler: DeepLinkEventHandler | undefined;
  let pendingUrls: string[];
  let storage: Storage;

  const callbackUrl = (token: string, nativeState: string) => {
    const url = new URL('drifting://auth/callback');
    url.searchParams.set('token', token);
    url.searchParams.set('nativeState', nativeState);
    return url.toString();
  };

  const newPendingState = () => createPendingNativeOAuthState();

  beforeEach(() => {
    eventHandler = undefined;
    pendingUrls = [];
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    tauriMocks.unlisten.mockReset();
    const values = new Map<string, string>();
    storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => {
        values.delete(key);
      },
      setItem: (key, value) => {
        values.set(key, value);
      },
    };
    vi.stubGlobal('localStorage', storage);

    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    tauriMocks.listen.mockImplementation(
      async (_eventName: string, handler: DeepLinkEventHandler) => {
        eventHandler = handler;
        return tauriMocks.unlisten;
      },
    );
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'opener_open_external') return undefined;
      if (command !== 'deep_link_take_pending') {
        throw new Error(`unexpected command: ${command}`);
      }
      return pendingUrls.splice(0);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens OAuth with a persisted 256-bit state that expires after ten minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));

    await tauriPlatform.auth.openOAuthBrowser('google');

    const openerCall = tauriMocks.invoke.mock.calls.find(
      ([command]) => command === 'opener_open_external',
    );
    expect(openerCall).toBeDefined();
    const openedUrl = new URL((openerCall?.[1] as { url: string }).url);
    const nativeState = openedUrl.searchParams.get('nativeState');
    expect(nativeState).toMatch(/^[0-9a-f]{64}$/);

    const pending = JSON.parse(storage.getItem('drifting.native_oauth_state') ?? '{}') as {
      value?: string;
      expiresAt?: number;
    };
    expect(pending).toEqual({
      value: nativeState,
      expiresAt: Date.now() + NATIVE_OAUTH_STATE_TTL_MS,
    });
  });

  it('drains URLs queued before the listener becomes ready', async () => {
    const nativeState = newPendingState();
    pendingUrls.push(callbackUrl('startup-token', nativeState));
    const callback = vi.fn();

    const stop = tauriPlatform.auth.onOAuthCallback(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

    expect(callback).toHaveBeenCalledWith({ token: 'startup-token', error: null });
    expect(pendingUrls).toEqual([]);
    stop();
    expect(tauriMocks.unlisten).toHaveBeenCalledOnce();
  });

  it('consumes a live URL from the native queue so it cannot replay on remount', async () => {
    const nativeState = newPendingState();
    const liveUrl = callbackUrl('live-token', nativeState);
    const firstCallback = vi.fn();
    const stopFirst = tauriPlatform.auth.onOAuthCallback(firstCallback);
    await vi.waitFor(() => expect(eventHandler).toBeTypeOf('function'));

    pendingUrls.push(liveUrl);
    eventHandler?.({ payload: { urls: [liveUrl] } });
    await vi.waitFor(() => expect(firstCallback).toHaveBeenCalledOnce());

    expect(firstCallback).toHaveBeenCalledOnce();
    expect(pendingUrls).toEqual([]);
    stopFirst();

    const secondCallback = vi.fn();
    const stopSecond = tauriPlatform.auth.onOAuthCallback(secondCallback);
    await vi.waitFor(() => expect(tauriMocks.listen).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(secondCallback).not.toHaveBeenCalled();
    stopSecond();
  });

  it('rejects missing and mismatched state without consuming the valid pending state', async () => {
    const nativeState = newPendingState();
    const callback = vi.fn();
    const stop = tauriPlatform.auth.onOAuthCallback(callback);
    await vi.waitFor(() => expect(eventHandler).toBeTypeOf('function'));

    pendingUrls.push('drifting://auth/callback?token=missing-state');
    eventHandler?.({ payload: { urls: ['drifting://auth/callback?token=missing-state'] } });
    pendingUrls.push(callbackUrl('wrong-state', 'cd'.repeat(32)));
    eventHandler?.({ payload: { urls: [callbackUrl('wrong-state', 'cd'.repeat(32))] } });
    await vi.waitFor(() => expect(pendingUrls).toEqual([]));
    expect(callback).not.toHaveBeenCalled();

    const validUrl = callbackUrl('valid-token', nativeState);
    pendingUrls.push(validUrl);
    eventHandler?.({ payload: { urls: [validUrl] } });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith({ token: 'valid-token', error: null });
    stop();
  });

  it('rejects an expired pending state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const nativeState = newPendingState();
    vi.advanceTimersByTime(NATIVE_OAUTH_STATE_TTL_MS + 1);
    const expiredUrl = callbackUrl('expired-token', nativeState);
    pendingUrls.push(expiredUrl);
    const callback = vi.fn();

    const stop = tauriPlatform.auth.onOAuthCallback(callback);
    await vi.runAllTimersAsync();

    expect(callback).not.toHaveBeenCalled();
    expect(storage.getItem('drifting.native_oauth_state')).toBeNull();
    stop();
  });
});

type LifecycleEventHandler = (event: {
  payload: {
    event: 'ready' | 'resumed' | 'flush-requested';
    requestId: number | null;
    deadlineMs: number | null;
    reason: 'shutdown' | 'suspended' | null;
    confirmationRequired: boolean;
  };
}) => void;

describe('tauri lifecycle flush protocol', () => {
  let eventHandler: LifecycleEventHandler | undefined;

  beforeEach(() => {
    eventHandler = undefined;
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    tauriMocks.unlisten.mockReset();

    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    tauriMocks.listen.mockImplementation(
      async (_eventName: string, handler: LifecycleEventHandler) => {
        eventHandler = handler;
        return tauriMocks.unlisten;
      },
    );
    tauriMocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'lifecycle_get_status') return { pendingFlushRequestId: null };
      if (command === 'lifecycle_complete_flush') {
        return (args as { requestId: number }).requestId === 17;
      }
      throw new Error(`unexpected command: ${command}`);
    });
  });

  it('keeps suspend unconfirmed and completes shutdown only with its explicit request id', async () => {
    const callback = vi.fn();
    const stop = tauriPlatform.lifecycle.onFlushBeforeQuit(callback);
    await vi.waitFor(() => expect(eventHandler).toBeTypeOf('function'));

    eventHandler?.({
      payload: {
        event: 'flush-requested',
        requestId: null,
        deadlineMs: null,
        reason: 'suspended',
        confirmationRequired: false,
      },
    });
    eventHandler?.({
      payload: {
        event: 'flush-requested',
        requestId: 17,
        deadlineMs: 5_000,
        reason: 'shutdown',
        confirmationRequired: true,
      },
    });

    expect(callback).toHaveBeenNthCalledWith(1, {
      requestId: null,
      reason: 'suspended',
      deadlineMs: null,
      confirmationRequired: false,
    });
    expect(callback).toHaveBeenNthCalledWith(2, {
      requestId: 17,
      reason: 'shutdown',
      deadlineMs: 5_000,
      confirmationRequired: true,
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      'lifecycle_complete_flush',
      expect.anything(),
    );

    await expect(tauriPlatform.lifecycle.confirmFlushBeforeQuit(17)).resolves.toBe(true);
    expect(tauriMocks.invoke).toHaveBeenCalledWith('lifecycle_complete_flush', { requestId: 17 });

    // The same shutdown event can be replayed by status recovery; it must not
    // trigger a second renderer flush. Suspend remains independently usable.
    eventHandler?.({
      payload: {
        event: 'flush-requested',
        requestId: 17,
        deadlineMs: 5_000,
        reason: 'shutdown',
        confirmationRequired: true,
      },
    });
    expect(callback).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('tauri material import contract', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  });

  it('preserves the native-owned material size limit in a stable failure result', async () => {
    tauriMocks.invoke.mockResolvedValue({
      ok: false,
      canceled: false,
      code: 'MATERIAL_FILE_TOO_LARGE',
      error: 'Selected file is larger than the 64 MiB material limit',
      maxSizeBytes: 64 * 1024 * 1024,
    });

    await expect(tauriPlatform.material.pickFile('pdf')).resolves.toEqual({
      ok: false,
      canceled: false,
      code: 'MATERIAL_FILE_TOO_LARGE',
      error: 'Selected file is larger than the 64 MiB material limit',
      maxSizeBytes: 64 * 1024 * 1024,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('material_pick_file', { kind: 'pdf' });
  });
});
