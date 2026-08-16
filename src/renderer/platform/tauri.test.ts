import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  channels: [] as Array<{ onmessage: (event: unknown) => void }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel {
    onmessage: (event: unknown) => void;

    constructor(onmessage: (event: unknown) => void) {
      this.onmessage = onmessage;
      tauriMocks.channels.push(this);
    }
  },
  convertFileSrc: tauriMocks.convertFileSrc,
  invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen,
}));

// This suite exercises the explicit compatible-service OAuth seam. The
// production default remains local-only and guards this path before fetch.
vi.mock('../lib/config', () => ({
  APP_CONFIG: { API_BASE_URL: 'http://localhost:3000' },
  canUseExternalContent: () => true,
  canUseHostedService: () => true,
}));

import { tauriPlatform } from './tauri';
import {
  createPendingNativeOAuth,
  createPkceCodeChallenge,
  NATIVE_OAUTH_REDIRECT_URI,
  NATIVE_OAUTH_STATE_TTL_MS,
} from './native-oauth-state';

describe('tauri native OpenAI and Keychain status transport', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.channels.length = 0;
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  it('checks Keychain existence without invoking the secret read command', async () => {
    tauriMocks.invoke.mockResolvedValue(true);

    await expect(tauriPlatform.keychain.has('byok.openai')).resolves.toBe(true);
    expect(tauriMocks.invoke).toHaveBeenCalledWith('keychain_has', {
      key: 'byok.openai',
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('keychain_get', expect.anything());
  });

  it('keeps SyncEngine asset capture and restore behind opaque native refs', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'sync_asset_capture_source') {
        return {
          sourceRef: 'syncobj:captured-source',
          blobId: `sha256:${'a'.repeat(64)}`,
          sourceSha256: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 12,
          mimeType: 'application/pdf',
        };
      }
      if (command === 'sync_asset_prepare_restore_source') {
        return {
          assetId: 'asset-1',
          stagingRef: 'syncobj:staged-source',
          sourceSha256: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 12,
        };
      }
      if (command === 'sync_asset_activate_restore_sources') return 'activation-receipt';
      if (
        command === 'sync_asset_abandon_restore_attempt' ||
        command === 'sync_asset_finalize_restore_attempt'
      ) return undefined;
      if (command === 'sync_asset_gc_restore_attempts') return { removedAttempts: 1 };
      throw new Error(`unexpected command: ${command}`);
    });

    const sourceSha = `sha256:${'a'.repeat(64)}`;
    await expect(tauriPlatform.syncAssetStore.captureSource({
      projectId: 'project-1',
      assetId: 'asset-1',
      expectedSourceSha256: sourceSha,
      expectedSizeBytes: 12,
      expectedMimeType: 'application/pdf',
    })).resolves.toMatchObject({ sourceRef: 'syncobj:captured-source' });
    await expect(tauriPlatform.syncAssetStore.prepareRestoreSource({
      attemptId: 'attempt-1',
      targetProjectId: 'project-1',
      assetId: 'asset-1',
      blobId: sourceSha,
      sourceRef: 'syncobj:decrypted-source',
      expectedSourceSha256: sourceSha,
      expectedSizeBytes: 12,
      expectedMimeType: 'application/pdf',
    })).resolves.toMatchObject({ stagingRef: 'syncobj:staged-source' });
    await expect(tauriPlatform.syncAssetStore.activateRestoreSources({
      attemptId: 'attempt-1',
      targetProjectId: 'project-1',
      stagingRefs: ['syncobj:staged-source'],
    })).resolves.toBe('activation-receipt');
    await tauriPlatform.syncAssetStore.finalizeRestoreAttempt('attempt-1');
    await expect(tauriPlatform.syncAssetStore.gcRestoreAttempts({
      retainedAttemptIds: [],
      olderThanMs: 60_000,
    })).resolves.toEqual({ removedAttempts: 1 });

    expect(tauriMocks.invoke).toHaveBeenCalledWith('sync_asset_capture_source', {
      projectId: 'project-1',
      assetId: 'asset-1',
      expectedSourceSha256: sourceSha,
      expectedSizeBytes: 12,
      expectedMimeType: 'application/pdf',
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      expect.stringMatching(/^sync_asset_/u),
      expect.objectContaining({ filePath: expect.anything(), bytes: expect.anything() }),
    );
  });

  it('uses only opaque refs for native SyncEngine object staging', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'sync_object_allocate_protocol') {
        return {
          sourceRef: 'syncobj:plaintext-object',
          sizeBytes: 0,
          storedSha256: `sha256:${'0'.repeat(64)}`,
        };
      }
      if (command === 'sync_object_append_protocol_chunk') return 3;
      if (command === 'sync_object_finalize_protocol') {
        return {
          sourceRef: 'syncobj:plaintext-object',
          sizeBytes: 3,
          storedSha256: `sha256:${'a'.repeat(64)}`,
        };
      }
      if (command === 'sync_object_stage_asset_source') {
        return {
          sourceRef: 'syncobj:asset-object',
          sizeBytes: 3,
          storedSha256: `sha256:${'b'.repeat(64)}`,
        };
      }
      if (command === 'sync_object_read_protocol_chunk') {
        return { offset: 0, totalSizeBytes: 3, bytes: [1, 2, 3] };
      }
      if (command === 'sync_object_gc_orphans') {
        return { removedObjects: 2, removedTemporaryFiles: 1 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(tauriPlatform.syncObjectStore.stageBytes(Uint8Array.of(1, 2, 3))).resolves.toMatchObject({
      sourceRef: 'syncobj:plaintext-object',
    });
    await expect(
      tauriPlatform.syncObjectStore.stageAssetSource('project-1', 'asset-1', 'png'),
    ).resolves.toMatchObject({ sourceRef: 'syncobj:asset-object' });
    await expect(
      tauriPlatform.syncObjectStore.readProtocolBytes('syncobj:plaintext-object', 2 * 1024 * 1024),
    ).resolves.toEqual(Uint8Array.of(1, 2, 3));
    await expect(
      tauriPlatform.syncObjectStore.gcOrphans({
        retainedSourceRefs: ['syncobj:plaintext-object'],
        olderThanMs: 86_400_000,
      }),
    ).resolves.toEqual({ removedObjects: 2, removedTemporaryFiles: 1 });

    expect(tauriMocks.invoke).toHaveBeenCalledWith('sync_object_append_protocol_chunk', {
      sourceRef: 'syncobj:plaintext-object',
      offset: 0,
      bytes: [1, 2, 3],
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('sync_object_finalize_protocol', {
      sourceRef: 'syncobj:plaintext-object',
      expectedSizeBytes: 3,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('sync_object_read_protocol_chunk', {
      sourceRef: 'syncobj:plaintext-object',
      offset: 0,
      maxBytes: 2 * 1024 * 1024,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('sync_object_gc_orphans', {
      retainedSourceRefs: ['syncobj:plaintext-object'],
      olderThanMs: 86_400_000,
    });
    expect(JSON.stringify(tauriMocks.invoke.mock.calls)).not.toMatch(
      /filePath|\/Users\/|bearer|refreshToken/u,
    );
  });

  it('passes generated archive bytes to the native save contract', async () => {
    tauriMocks.invoke.mockResolvedValue({ ok: true });

    await expect(
      tauriPlatform.archive.save('drifting-export.zip', Uint8Array.from([80, 75, 3, 4])),
    ).resolves.toEqual({ ok: true });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('archive_save', {
      filename: 'drifting-export.zip',
      bytes: [80, 75, 3, 4],
    });
  });

  it('routes durable asset bytes through the local asset store contract', async () => {
    tauriMocks.invoke.mockResolvedValue({
      ok: true,
      filePath: '/app-data/assets/project-1/asset-1/source.png',
      fileUrl: 'file:///ignored-by-renderer',
      sizeBytes: 4,
    });

    await expect(
      tauriPlatform.assetStore.writeBytes(
        'project-1',
        'asset-1',
        'source',
        'png',
        Uint8Array.from([1, 2, 3, 4]),
      ),
    ).resolves.toMatchObject({
      ok: true,
      fileUrl: 'asset:///app-data/assets/project-1/asset-1/source.png',
      sizeBytes: 4,
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('asset_store_write_bytes', {
      projectId: 'project-1',
      assetId: 'asset-1',
      variant: 'source',
      ext: 'png',
      bytes: [1, 2, 3, 4],
    });
  });

  it('reconstructs an ordered Responses stream from native channel bytes', async () => {
    const ssePayload =
      'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    tauriMocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command !== 'openai_responses_stream') {
        throw new Error(`unexpected command: ${command}`);
      }
      const payload = args as {
        input: { body: string; requestId: string; timeoutMs: number };
        onEvent: { onmessage: (event: unknown) => void };
      };
      expect(payload.input.body).toBe('{"model":"gpt-5.6-luna"}');
      expect(JSON.stringify(payload)).not.toContain('Authorization');
      payload.onEvent.onmessage({
        type: 'started',
        status: 200,
        requestId: 'req_native_1',
        errorCode: null,
        errorMessage: null,
      });
      payload.onEvent.onmessage({
        type: 'chunk',
        bytes: Array.from(new TextEncoder().encode(ssePayload)),
      });
      payload.onEvent.onmessage({ type: 'finished' });
      return undefined;
    });

    const response = await tauriPlatform.openAIResponses.request(
      '{"model":"gpt-5.6-luna"}',
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req_native_1');
    await expect(response.text()).resolves.toBe(ssePayload);
  });

  it('forwards AbortSignal cancellation to the active native request', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'openai_responses_cancel') return true;
      if (command !== 'openai_responses_stream') {
        throw new Error(`unexpected command: ${command}`);
      }
      const payload = args as {
        onEvent: { onmessage: (event: unknown) => void };
      };
      payload.onEvent.onmessage({
        type: 'started',
        status: 200,
        requestId: 'req_native_abort',
        errorCode: null,
        errorMessage: null,
      });
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const response = await tauriPlatform.openAIResponses.request(
      '{"model":"gpt-5.6-luna"}',
      controller.signal,
    );
    const read = response.body!.getReader().read();

    controller.abort();

    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        'openai_responses_cancel',
        expect.objectContaining({ requestId: expect.stringMatching(/^openai-/) }),
      );
    });
  });
});

describe('tauri General Agent capability', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['macos', 'desktop'],
    ['ios', 'mobile'],
    ['windows', 'desktop'],
    ['linux', 'desktop'],
    ['android', 'mobile'],
  ] as const)(
    'advertises the renderer-local runtime on %s',
    async (platform, target) => {
      tauriMocks.invoke.mockImplementation(async (command: string) => {
        if (command === 'app_get_info') {
          return {
            name: 'Drifting',
            version: '0.0.0',
            platform,
            architecture: 'test',
          };
        }
        if (command === 'platform_capabilities') {
          // An older native binary may still report the retired sidecar-era
          // value. The renderer owns this capability and must normalize it.
          return {
            desktopWindowControls: platform === 'macos',
            deepLinks: true,
            externalUrlOpener: true,
            secureStorage: true,
            googleDriveOAuth: target === 'desktop',
            materialFiles: true,
            assetStore: true,
            aiLog: true,
            oauth: true,
            imageCodecs: {
              rust: [],
              nativeSystem: [],
              runtimeChecked: true,
            },
            generalAgent: false,
            generalAgentUnavailableReason:
              'legacy Node/CLI requirement',
          };
        }
        throw new Error(`unexpected command: ${command}`);
      });

      await expect(tauriPlatform.app.getCapabilities()).resolves.toMatchObject({
        runtime: 'tauri',
        target,
        generalAgent: true,
        generalAgentUnavailableReason: '',
        featureStatus: {
          generalAgent: 'available',
          googleDriveOAuth: target === 'desktop' ? 'available' : 'unsupported',
        },
      });
    },
  );

  it('treats missing security and Drive OAuth advertisements as unsupported', async () => {
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'app_get_info') {
        return {
          name: 'Drifting',
          version: '0.0.0',
          platform: 'android',
          architecture: 'test',
        };
      }
      if (command === 'platform_capabilities') {
        return {
          desktopWindowControls: false,
          deepLinks: true,
          externalUrlOpener: true,
          generalAgent: true,
          generalAgentUnavailableReason: '',
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(tauriPlatform.app.getCapabilities()).resolves.toMatchObject({
      featureStatus: {
        googleDriveOAuth: 'unsupported',
      },
    });
  });
});

type DeepLinkEventHandler = (event: { payload: { urls: string[] } }) => void;

describe('tauri OAuth callback delivery', () => {
  let eventHandler: DeepLinkEventHandler | undefined;
  let pendingUrls: string[];
  let storage: Storage;
  let exchangeFetch: ReturnType<typeof vi.fn>;

  const callbackUrl = (code: string, nativeState: string) => {
    const url = new URL('drifting://auth/callback');
    url.searchParams.set('code', code);
    url.searchParams.set('nativeState', nativeState);
    return url.toString();
  };

  const newPendingState = async () => (await createPendingNativeOAuth()).nativeState;

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
    exchangeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'exchanged-session-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', exchangeFetch);

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

  it('opens OAuth with a persisted state and S256 PKCE verifier', async () => {
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
    expect(openedUrl.searchParams.get('codeChallengeMethod')).toBe('S256');
    expect(openedUrl.searchParams.get('redirectUri')).toBe(NATIVE_OAUTH_REDIRECT_URI);

    const pending = JSON.parse(storage.getItem('drifting.native_oauth_state') ?? '{}') as {
      nativeState?: string;
      codeVerifier?: string;
      redirectUri?: string;
      expiresAt?: number;
    };
    expect(pending.nativeState).toBe(nativeState);
    expect(pending.codeVerifier).toMatch(/^[0-9a-f]{64}$/);
    expect(pending.redirectUri).toBe(NATIVE_OAUTH_REDIRECT_URI);
    expect(pending.expiresAt).toBe(Date.now() + NATIVE_OAUTH_STATE_TTL_MS);
    expect(openedUrl.searchParams.get('codeChallenge')).toBe(
      await createPkceCodeChallenge(pending.codeVerifier!),
    );
  });

  it('drains a queued code and exchanges it over HTTPS before releasing a token', async () => {
    const pending = await createPendingNativeOAuth();
    const code = 'A'.repeat(43);
    pendingUrls.push(callbackUrl(code, pending.nativeState));
    const callback = vi.fn();

    const stop = tauriPlatform.auth.onOAuthCallback(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

    expect(callback).toHaveBeenCalledWith({ token: 'exchanged-session-token', error: null });
    expect(exchangeFetch).toHaveBeenCalledOnce();
    const [exchangeUrl, exchangeInit] = exchangeFetch.mock.calls[0] as [string, RequestInit];
    expect(exchangeUrl).toBe('http://localhost:3000/api/auth/native-exchange');
    expect(JSON.parse(exchangeInit.body as string)).toEqual({
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
    });
    expect(exchangeInit.credentials).toBe('omit');
    expect(pendingUrls).toEqual([]);
    expect(storage.getItem('drifting.native_oauth_state')).toBeNull();
    stop();
    expect(tauriMocks.unlisten).toHaveBeenCalledOnce();
  });

  it('consumes a live URL from the native queue so it cannot replay on remount', async () => {
    const nativeState = await newPendingState();
    const liveUrl = callbackUrl('B'.repeat(43), nativeState);
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
    expect(exchangeFetch).toHaveBeenCalledOnce();
    stopSecond();
  });

  it('rejects missing and mismatched state without consuming the valid pending state', async () => {
    const nativeState = await newPendingState();
    const callback = vi.fn();
    const stop = tauriPlatform.auth.onOAuthCallback(callback);
    await vi.waitFor(() => expect(eventHandler).toBeTypeOf('function'));

    const missingState = `drifting://auth/callback?code=${'C'.repeat(43)}`;
    const wrongState = callbackUrl('D'.repeat(43), 'cd'.repeat(32));
    pendingUrls.push(missingState);
    eventHandler?.({ payload: { urls: [missingState] } });
    pendingUrls.push(wrongState);
    eventHandler?.({ payload: { urls: [wrongState] } });
    await vi.waitFor(() => expect(pendingUrls).toEqual([]));
    expect(callback).not.toHaveBeenCalled();
    expect(exchangeFetch).not.toHaveBeenCalled();

    const validUrl = callbackUrl('E'.repeat(43), nativeState);
    pendingUrls.push(validUrl);
    eventHandler?.({ payload: { urls: [validUrl] } });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith({ token: 'exchanged-session-token', error: null });
    stop();
  });

  it('rejects an expired pending state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    const nativeState = await newPendingState();
    vi.advanceTimersByTime(NATIVE_OAUTH_STATE_TTL_MS + 1);
    const expiredUrl = callbackUrl('F'.repeat(43), nativeState);
    pendingUrls.push(expiredUrl);
    const callback = vi.fn();

    const stop = tauriPlatform.auth.onOAuthCallback(callback);
    await vi.runAllTimersAsync();

    expect(callback).not.toHaveBeenCalled();
    expect(exchangeFetch).not.toHaveBeenCalled();
    expect(storage.getItem('drifting.native_oauth_state')).toBeNull();
    stop();
  });

  it('surfaces a failed HTTPS exchange without exposing the handoff code as a token', async () => {
    const nativeState = await newPendingState();
    exchangeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    const callback = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stop = tauriPlatform.auth.onOAuthCallback(callback);
    await vi.waitFor(() => expect(eventHandler).toBeTypeOf('function'));

    const url = callbackUrl('G'.repeat(43), nativeState);
    pendingUrls.push(url);
    eventHandler?.({ payload: { urls: [url] } });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

    expect(callback).toHaveBeenCalledWith({ token: null, error: 'exchange_failed' });
    expect(consoleError).toHaveBeenCalledOnce();
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

  it('exposes native ready and resume wake-ups without treating flushes as resumes', async () => {
    const callback = vi.fn();
    const stop = tauriPlatform.lifecycle.onReadyOrResume(callback);
    await vi.waitFor(() => expect(eventHandler).toBeTypeOf('function'));

    eventHandler?.({
      payload: {
        event: 'ready',
        requestId: null,
        deadlineMs: null,
        reason: null,
        confirmationRequired: false,
      },
    });
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
        event: 'resumed',
        requestId: null,
        deadlineMs: null,
        reason: null,
        confirmationRequired: false,
      },
    });

    expect(callback.mock.calls).toEqual([['ready'], ['resumed']]);
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

  it('routes app-owned import cleanup through the confined native command', async () => {
    tauriMocks.invoke.mockResolvedValue({ ok: true });

    await expect(
      tauriPlatform.material.deleteImport('/app/data/imports/picked.pdf'),
    ).resolves.toEqual({ ok: true });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('material_delete_import', {
      filePath: '/app/data/imports/picked.pdf',
    });
  });
});
