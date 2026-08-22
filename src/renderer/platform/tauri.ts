import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { APP_CONFIG, canUseExternalContent, canUseHostedService } from '../lib/config';
import { hasPdfSignature, renderPdfThumbnail } from '../lib/pdf-thumbnail';
import { consumePendingNativeOAuth, createPendingNativeOAuth } from './native-oauth-state';
import type {
  ContractAvailability,
  AppUpdateDownloadEvent,
  GoogleDriveNativeError,
  GoogleDriveNativeErrorCode,
  GoogleDriveNativeResult,
  ImageVariantResult,
  LifecycleEventPayload,
  NativeBytes,
  NativePlatformCapabilities,
  OpenAIResponsesStreamEvent,
  PlatformCapabilities,
  PrepareImageResult,
  TauriCommandArgs,
  TauriCommandName,
  TauriCommandResult,
  TauriEventContract,
} from './contracts';
import type { PlatformApi, Unsubscribe } from './types';

const DEEP_LINK_EVENT = 'drifting:deep-link' as const;
const LIFECYCLE_EVENT = 'drifting:lifecycle' as const;

type TauriGlobal = typeof globalThis & {
  __TAURI_INTERNALS__?: unknown;
};

export class PlatformUnavailableError extends Error {
  readonly feature: string;

  constructor(feature: string, reason?: string) {
    super(`Tauri capability "${feature}" is unavailable${reason ? `: ${reason}` : ''}`);
    this.name = 'PlatformUnavailableError';
    this.feature = feature;
  }
}

export class PlatformCommandError extends Error {
  readonly command: string;

  constructor(command: string, reason: string) {
    super(`Tauri command "${command}" failed: ${reason}`);
    this.name = 'PlatformCommandError';
    this.command = command;
  }
}

export class GoogleDrivePlatformError extends Error {
  readonly code: GoogleDriveNativeErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(error: GoogleDriveNativeError) {
    super(error.message);
    this.name = 'GoogleDrivePlatformError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.retryAfterMs = error.retryAfterMs;
  }
}

function unwrapGoogleDriveResult<T>(result: GoogleDriveNativeResult<T>): T {
  if (result.ok) return result.value;
  throw new GoogleDrivePlatformError(result.error);
}

async function invokeGoogleDriveTransfer<T>(
  task: () => Promise<GoogleDriveNativeResult<T>>,
  transferId: string,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new GoogleDrivePlatformError({
      code: 'cancelled',
      message: 'Google Drive transfer was cancelled',
      retryable: false,
      retryAfterMs: null,
    });
  }
  let aborted = false;
  const cancel = () => {
    aborted = true;
    void invokeContract('google_drive_cancel_transfer', { transferId }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await task();
    if (aborted || signal.aborted) {
      throw new GoogleDrivePlatformError({
        code: 'cancelled',
        message: 'Google Drive transfer was cancelled',
        retryable: false,
        retryAfterMs: null,
      });
    }
    return unwrapGoogleDriveResult(result);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function googleDriveRevokeTransferId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `revoke-${randomId}`;
  return `revoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isTauriRuntime(): boolean {
  return Boolean((globalThis as TauriGlobal).__TAURI_INTERNALS__);
}

function requireTauriRuntime(feature: string): void {
  if (!isTauriRuntime()) {
    throw new PlatformUnavailableError(feature, 'the renderer is not running inside Tauri');
  }
}

async function invokeContract<Name extends TauriCommandName>(
  name: Name,
  args: TauriCommandArgs<Name>,
): Promise<TauriCommandResult<Name>> {
  requireTauriRuntime(name);
  try {
    return await invoke<TauriCommandResult<Name>>(name, args ?? undefined);
  } catch (error) {
    if (error instanceof PlatformUnavailableError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    if (
      /command.+(?:not found|not registered|not allowed)|unknown command|acl.+denied/i.test(reason)
    ) {
      throw new PlatformUnavailableError(name, reason);
    }
    throw new PlatformCommandError(name, reason);
  }
}

function listenContract<Name extends keyof TauriEventContract>(
  eventName: Name,
  callback: (payload: TauriEventContract[Name]) => void,
  onReady?: () => void,
): Unsubscribe {
  let active = true;
  let unlisten: UnlistenFn | undefined;

  if (!isTauriRuntime()) {
    console.error(
      new PlatformUnavailableError(eventName, 'the renderer is not running inside Tauri'),
    );
    return () => {
      active = false;
    };
  }

  void listen<TauriEventContract[Name]>(eventName, (event) => {
    if (active) callback(event.payload);
  })
    .then((stop) => {
      if (active) {
        unlisten = stop;
        onReady?.();
      } else stop();
    })
    .catch((error) => {
      console.error(new PlatformUnavailableError(eventName, String(error)));
    });

  return () => {
    active = false;
    unlisten?.();
  };
}

function toUint8Array(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  return new Uint8Array(bytes);
}

function toNumberArray(bytes: ArrayBuffer | Uint8Array): number[] {
  return Array.from(toUint8Array(bytes));
}

function toArrayBuffer(bytes: NativeBytes): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0);
  const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

const SYNC_PROTOCOL_IPC_CHUNK_BYTES = 2 * 1024 * 1024;
const SYNC_PROTOCOL_OBJECT_MAX_BYTES = 512 * 1024 * 1024;

function assertProtocolObjectLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > SYNC_PROTOCOL_OBJECT_MAX_BYTES) {
    throw new RangeError(`${label} must be between 0 and 512 MiB`);
  }
}

async function stageProtocolBytes(bytes: ArrayBuffer | Uint8Array) {
  const value = toUint8Array(bytes);
  assertProtocolObjectLimit(value.byteLength, 'sync protocol object size');
  const allocated = await invokeContract('sync_object_allocate_protocol', undefined);
  let finalized = false;
  try {
    let offset = 0;
    while (offset < value.byteLength) {
      const end = Math.min(offset + SYNC_PROTOCOL_IPC_CHUNK_BYTES, value.byteLength);
      const nextOffset = await invokeContract('sync_object_append_protocol_chunk', {
        sourceRef: allocated.sourceRef,
        offset,
        bytes: toNumberArray(value.subarray(offset, end)),
      });
      if (nextOffset !== end) {
        throw new Error('native sync protocol stage returned a non-contiguous offset');
      }
      offset = end;
    }
    const result = await invokeContract('sync_object_finalize_protocol', {
      sourceRef: allocated.sourceRef,
      expectedSizeBytes: value.byteLength,
    });
    finalized = true;
    return result;
  } finally {
    if (!finalized) {
      await invokeContract('sync_object_discard_local', {
        sourceRef: allocated.sourceRef,
      }).catch(() => undefined);
    }
  }
}

async function readProtocolBytes(sourceRef: string, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('sync protocol read limit must be a positive safe integer');
  }
  assertProtocolObjectLimit(maxBytes, 'sync protocol read limit');

  let output: Uint8Array | null = null;
  let offset = 0;
  do {
    const result = await invokeContract('sync_object_read_protocol_chunk', {
      sourceRef,
      offset,
      maxBytes: Math.min(SYNC_PROTOCOL_IPC_CHUNK_BYTES, maxBytes - offset),
    });
    if (
      !Number.isSafeInteger(result.offset) ||
      result.offset !== offset ||
      !Number.isSafeInteger(result.totalSizeBytes) ||
      result.totalSizeBytes < 0 ||
      result.totalSizeBytes > maxBytes
    ) {
      throw new Error('native sync protocol chunk metadata is invalid');
    }
    if (output === null) output = new Uint8Array(result.totalSizeBytes);
    if (output.byteLength !== result.totalSizeBytes) {
      throw new Error('native sync protocol object size changed between chunks');
    }
    const chunk = new Uint8Array(toArrayBuffer(result.bytes));
    if (chunk.byteLength > SYNC_PROTOCOL_IPC_CHUNK_BYTES || offset + chunk.byteLength > output.length) {
      throw new Error('native sync protocol chunk exceeds its authenticated bounds');
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
    if (offset < output.length && chunk.byteLength === 0) {
      throw new Error('native sync protocol chunk made no progress');
    }
  } while (output === null || offset < output.length);
  return output;
}

function normalizeImageVariant(result: ImageVariantResult) {
  if (!result.ok) return result;
  return { ...result, bytes: toArrayBuffer(result.bytes) };
}

function normalizePreparedImage(result: PrepareImageResult) {
  if (!result.ok) return result;
  return {
    ...result,
    display: { ...result.display, bytes: toArrayBuffer(result.display.bytes) },
    thumbnail: { ...result.thumbnail, bytes: toArrayBuffer(result.thumbnail.bytes) },
  };
}

async function readNativeFileBytes(filePath: string): Promise<ArrayBuffer | null> {
  const result = await invokeContract('material_read_bytes', { filePath });
  return result.ok ? toArrayBuffer(result.bytes) : null;
}

function normalizeStoredAssetFileUrl<T extends { ok: boolean }>(result: T): T {
  if (!result.ok || !('filePath' in result) || typeof result.filePath !== 'string') return result;
  return { ...result, fileUrl: convertFileSrc(result.filePath) };
}

function openAIRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `openai-${randomId}`;
  return `openai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function abortException(): DOMException {
  return new DOMException('OpenAI request was cancelled.', 'AbortError');
}

function nativeOpenAIResponse(body: string, signal: AbortSignal): Promise<Response> {
  requireTauriRuntime('openai_responses_stream');
  if (signal.aborted) return Promise.reject(abortException());

  const requestId = openAIRequestId();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let started = false;
  let finished = false;
  let settled = false;
  let resolveStart!: (response: Response) => void;
  let rejectStart!: (error: unknown) => void;

  const cleanup = () => signal.removeEventListener('abort', onAbort);
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (!settled) {
      settled = true;
      rejectStart(error);
    } else {
      streamController.error(error);
    }
  };
  const cancelNative = () => {
    void invokeContract('openai_responses_cancel', { requestId }).catch(() => undefined);
  };
  const onAbort = () => {
    cancelNative();
    fail(abortException());
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      finished = true;
      cancelNative();
      cleanup();
    },
  });
  const response = new Promise<Response>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const onEvent = new Channel<OpenAIResponsesStreamEvent>((event) => {
    if (finished) return;
    if (event.type === 'started') {
      if (started) {
        fail(new PlatformCommandError('openai_responses_stream', 'duplicate start event'));
        return;
      }
      started = true;
      const headers = new Headers({ 'content-type': 'text/event-stream' });
      if (event.requestId) headers.set('x-request-id', event.requestId);
      if (event.errorCode) headers.set('x-drifting-openai-error-code', event.errorCode);
      if (event.errorMessage) headers.set('x-drifting-openai-error-message', event.errorMessage);
      settled = true;
      resolveStart(new Response(stream, { status: event.status, headers }));
      return;
    }
    if (!started) {
      fail(new PlatformCommandError('openai_responses_stream', 'stream data preceded start'));
      return;
    }
    if (event.type === 'chunk') {
      streamController.enqueue(
        event.bytes instanceof Uint8Array ? event.bytes : Uint8Array.from(event.bytes),
      );
      return;
    }
    finished = true;
    cleanup();
    streamController.close();
  });

  signal.addEventListener('abort', onAbort, { once: true });
  void invokeContract('openai_responses_stream', {
    input: { requestId, body, timeoutMs: 600_000 },
    onEvent,
  }).catch(fail);
  return response;
}

function isMobilePlatform(platform: string): boolean {
  return platform === 'ios' || platform === 'android';
}

function advertised(value: boolean | undefined): ContractAvailability {
  return value === undefined ? 'contract-backed' : value ? 'available' : 'unsupported';
}

function normalizeCapabilities(
  native: NativePlatformCapabilities,
  platform: string,
): PlatformCapabilities {
  return {
    ...native,
    runtime: 'tauri',
    target: isMobilePlatform(platform) ? 'mobile' : 'desktop',
    // General Agent is renderer-local and provider-neutral. It no longer
    // depends on an Electron main process, Node sidecar, or Anthropic CLI, so
    // every Tauri target that can run this renderer has the same contract.
    generalAgent: true,
    generalAgentUnavailableReason: '',
    mcpStdio: native.mcpStdio === true,
    featureStatus: {
      secureStorage: advertised(native.secureStorage),
      syncObjectStore: advertised(native.syncObjectStore),
      googleDriveTransport: advertised(native.googleDriveTransport),
      googleDriveOAuth: native.googleDriveOAuth === true ? 'available' : 'unsupported',
      materialFiles: advertised(native.materialFiles),
      assetStore: advertised(native.assetStore),
      aiLog: advertised(native.aiLog),
      appUpdater: advertised(native.appUpdater),
      oauth:
        native.oauth === undefined && native.deepLinks && native.externalUrlOpener
          ? 'available'
          : advertised(native.oauth),
      mcpStdio: advertised(native.mcpStdio),
      generalAgent: 'available',
    },
  };
}

interface ParsedOAuthCallback {
  code: string | null;
  error: string | null;
  nativeState: string | null;
}

function parseOAuthCallback(url: string): ParsedOAuthCallback | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'drifting:' ||
      parsed.hostname !== 'auth' ||
      parsed.pathname !== '/callback'
    ) {
      return null;
    }
    const codes = parsed.searchParams.getAll('code');
    const errors = parsed.searchParams.getAll('error');
    const states = parsed.searchParams.getAll('nativeState');
    if (codes.length > 1 || errors.length > 1 || states.length !== 1) return null;
    const code = codes[0] ?? null;
    const error = errors[0] ?? null;
    if ((code == null) === (error == null)) return null;
    if (code != null && !/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
    if (error != null && !/^[a-z0-9_]{1,64}$/.test(error)) return null;
    return {
      code,
      error,
      nativeState: states[0],
    };
  } catch {
    return null;
  }
}

async function exchangeNativeOAuthCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<string> {
  if (!canUseHostedService()) {
    throw new Error('HOSTED_SERVICE_DISABLED: native account OAuth is unavailable.');
  }
  const response = await fetch(
    `${APP_CONFIG.API_BASE_URL.replace(/\/$/, '')}/api/auth/native-exchange`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify({ code, codeVerifier, redirectUri }),
    },
  );
  if (!response.ok) throw new Error(`Native OAuth exchange failed (${response.status})`);

  const payload = (await response.json()) as { token?: unknown };
  if (
    typeof payload.token !== 'string' ||
    payload.token.length === 0 ||
    payload.token.length > 4096
  ) {
    throw new Error('Native OAuth exchange returned no session token');
  }
  return payload.token;
}

export const tauriPlatform: PlatformApi = {
  app: {
    getInfo: () => invokeContract('app_get_info', undefined),
    async getVersion() {
      return (await invokeContract('app_get_info', undefined)).version;
    },
    getPath: (name) => invokeContract('app_get_path', { name }),
    async getCapabilities() {
      const [native, appInfo] = await Promise.all([
        invokeContract('platform_capabilities', undefined),
        invokeContract('app_get_info', undefined),
      ]);
      return normalizeCapabilities(native, appInfo.platform);
    },
  },

  window: {
    minimize: () => invokeContract('window_minimize', undefined),
    toggleMaximize: () => invokeContract('window_toggle_maximize', undefined),
    close: () => invokeContract('window_close', undefined),
    isMaximized: () => invokeContract('window_is_maximized', undefined),
    setTrafficLightPosition: (position) =>
      invokeContract('window_set_traffic_light_position', { position }),
  },

  lifecycle: {
    onFlushBeforeQuit(callback) {
      const seen = new Set<number>();
      const dispatch = (payload: LifecycleEventPayload) => {
        if (payload.event !== 'flush-requested' || payload.reason == null) return;
        if (payload.requestId != null) {
          if (seen.has(payload.requestId)) return;
          seen.add(payload.requestId);
        }
        callback({
          requestId: payload.requestId,
          reason: payload.reason,
          deadlineMs: payload.deadlineMs,
          confirmationRequired: payload.confirmationRequired,
        });
      };

      const stop = listenContract(LIFECYCLE_EVENT, dispatch);
      void invokeContract('lifecycle_get_status', undefined)
        .then((status) => {
          if (status.pendingFlushRequestId != null) {
            dispatch({
              event: 'flush-requested',
              requestId: status.pendingFlushRequestId,
              deadlineMs: null,
              reason: 'shutdown',
              confirmationRequired: true,
            });
          }
        })
        .catch((error) => console.error(error));
      return stop;
    },
    onReadyOrResume(callback) {
      return listenContract(LIFECYCLE_EVENT, (payload) => {
        if (payload.event === 'ready' || payload.event === 'resumed') {
          callback(payload.event);
        }
      });
    },
    confirmFlushBeforeQuit(requestId) {
      return invokeContract('lifecycle_complete_flush', { requestId });
    },
  },

  auth: {
    async openOAuthBrowser(provider) {
      if (!canUseHostedService()) {
        throw new Error('HOSTED_SERVICE_DISABLED: native account OAuth is unavailable.');
      }
      const pending = await createPendingNativeOAuth();
      const url = new URL(
        `${APP_CONFIG.API_BASE_URL.replace(/\/$/, '')}/api/auth/oauth-redirect/${encodeURIComponent(provider)}`,
      );
      url.searchParams.set('nativeState', pending.nativeState);
      url.searchParams.set('codeChallenge', pending.codeChallenge);
      url.searchParams.set('codeChallengeMethod', 'S256');
      url.searchParams.set('redirectUri', pending.redirectUri);
      await invokeContract('opener_open_external', { url: url.toString() });
    },
    onOAuthCallback(callback) {
      const seen = new Set<string>();
      let active = true;
      let drainChain = Promise.resolve();
      const dispatch = async (urls: string[]) => {
        if (!active) return;
        for (const url of urls) {
          if (seen.has(url)) continue;
          seen.add(url);
          const result = parseOAuthCallback(url);
          if (!result) continue;
          const pending = consumePendingNativeOAuth(result.nativeState);
          if (!pending) continue;
          if (result.error) {
            callback({ token: null, error: result.error });
            continue;
          }
          try {
            const token = await exchangeNativeOAuthCode(
              result.code!,
              pending.codeVerifier,
              pending.redirectUri,
            );
            if (active) callback({ token, error: null });
          } catch (error) {
            console.error(error);
            if (active) callback({ token: null, error: 'exchange_failed' });
          }
        }
      };
      const drainPending = () => {
        drainChain = drainChain
          .then(() => invokeContract('deep_link_take_pending', undefined))
          .then(dispatch)
          .catch((error) => console.error(error));
      };

      // Native keeps every incoming URL until the renderer drains it. Always
      // dispatch from that queue (instead of the event payload) so a live URL is
      // consumed and cannot be replayed after logout/LoginPage remount. Waiting
      // until the listener is installed also closes the startup race: URLs that
      // arrive before registration remain queued and are handled by this drain.
      const stop = listenContract(DEEP_LINK_EVENT, drainPending, drainPending);
      return () => {
        active = false;
        stop();
      };
    },
  },

  keychain: {
    get: (key) => invokeContract('keychain_get', { key }),
    has: (key) => invokeContract('keychain_has', { key }),
    set: (key, value) => invokeContract('keychain_set', { key, value }),
    delete: (key) => invokeContract('keychain_delete', { key }),
  },

  syncObjectStore: {
    stageBytes: stageProtocolBytes,
    stageAssetSource: (projectId, assetId, ext) =>
      invokeContract('sync_object_stage_asset_source', { projectId, assetId, ext }),
    discardLocal: (sourceRef) => invokeContract('sync_object_discard_local', { sourceRef }),
    gcOrphans: (input) => invokeContract('sync_object_gc_orphans', input),
    readProtocolBytes,
  },

  syncAssetStore: {
    captureSource: (input) => invokeContract('sync_asset_capture_source', input),
    prepareRestoreSource: (input) =>
      invokeContract('sync_asset_prepare_restore_source', input),
    activateRestoreSources: (input) =>
      invokeContract('sync_asset_activate_restore_sources', input),
    abandonRestoreAttempt: (attemptId) =>
      invokeContract('sync_asset_abandon_restore_attempt', { attemptId }),
    finalizeRestoreAttempt: (attemptId) =>
      invokeContract('sync_asset_finalize_restore_attempt', { attemptId }),
    gcRestoreAttempts: (input) => invokeContract('sync_asset_gc_restore_attempts', input),
  },

  googleDrive: {
    connectAccount: async () =>
      unwrapGoogleDriveResult(await invokeContract('google_drive_oauth_connect', undefined)),
    claimAccount: async (credentialSecretRef, accountSubject) =>
      unwrapGoogleDriveResult(
        await invokeContract('google_drive_claim_account', {
          credentialSecretRef,
          accountSubject,
        }),
      ),
    reauthorizeAccount: async (credentialSecretRef) =>
      unwrapGoogleDriveResult(
        await invokeContract('google_drive_oauth_reauthorize', { credentialSecretRef }),
      ),
    revokeAccount: async (
      credentialSecretRef,
      signal = new AbortController().signal,
    ): Promise<void> => {
      const transferId = googleDriveRevokeTransferId();
      await invokeGoogleDriveTransfer(
        () =>
          invokeContract('google_drive_revoke_account', {
            credentialSecretRef,
            transferId,
          }),
        transferId,
        signal,
      );
    },
    discoverProjectSnapshots: async (input) =>
      unwrapGoogleDriveResult(
        await invokeContract('google_drive_discover_project_snapshots', input),
      ),
    openGeneration: async (input) =>
      unwrapGoogleDriveResult(await invokeContract('google_drive_open_generation', input)),
    captureStartCursor: async (generationRef) =>
      unwrapGoogleDriveResult(
        await invokeContract('google_drive_capture_start_cursor', { generationRef }),
      ),
    listInventory: async (input) =>
      unwrapGoogleDriveResult(await invokeContract('google_drive_list_inventory', input)),
    listChanges: async (input) =>
      unwrapGoogleDriveResult(await invokeContract('google_drive_list_changes', input)),
    statImmutable: async (input) =>
      unwrapGoogleDriveResult(await invokeContract('google_drive_stat_immutable', input)),
    uploadImmutable: ({ signal, ...input }) =>
      invokeGoogleDriveTransfer(
        () => invokeContract('google_drive_upload_immutable', input),
        input.transferId,
        signal,
      ),
    downloadVerifiedImmutable: ({ signal, ...input }) =>
      invokeGoogleDriveTransfer(
        () => invokeContract('google_drive_download_verified_immutable', input),
        input.transferId,
        signal,
      ),
  },

  typography: {
    listSystemFonts: () => invokeContract('typography_list_system_fonts', undefined),
  },

  material: {
    toLocalResourceUrl(filePath) {
      if (!filePath || !isTauriRuntime()) return null;
      return convertFileSrc(filePath);
    },
    openLocal: (filePath) => invokeContract('material_open_local', { filePath }),
    async openExternal(url) {
      try {
        await invokeContract('opener_open_external', { url });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    pickFile: (kind = 'any') => invokeContract('material_pick_file', { kind }),
    deleteImport: (filePath) => invokeContract('material_delete_import', { filePath }),
    async thumbnail(filePath, size = 96) {
      const native = await invokeContract('material_thumbnail', { filePath, size });
      if (native.ok) return native;
      try {
        const bytes = await readNativeFileBytes(filePath);
        if (!bytes || !hasPdfSignature(bytes)) return native;
        const thumbnail = await renderPdfThumbnail(bytes, size, 80);
        return { ok: true, dataUrl: thumbnail.dataUrl };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async readBytes(filePath) {
      const result = await invokeContract('material_read_bytes', { filePath });
      return result.ok ? { ...result, bytes: toArrayBuffer(result.bytes) } : result;
    },
    inspectImage: (filePath) => invokeContract('material_inspect_image', { filePath }),
    async prepareImage(filePath, options = {}) {
      return normalizePreparedImage(
        await invokeContract('material_prepare_image', {
          filePath,
          displayMaxLongEdge: options.displayMaxLongEdge ?? 1600,
          displayQuality: options.displayQuality ?? 82,
          thumbnailMaxLongEdge: options.thumbnailMaxLongEdge ?? 512,
          thumbnailQuality: options.thumbnailQuality ?? 72,
        }),
      );
    },
    async createImageVariant(filePath, maxLongEdge, quality) {
      return normalizeImageVariant(
        await invokeContract('material_create_image_variant', {
          filePath,
          maxLongEdge,
          quality,
        }),
      );
    },
    async createThumbnailVariant(filePath, size, quality) {
      const native = normalizeImageVariant(
        await invokeContract('material_create_thumbnail_variant', { filePath, size, quality }),
      );
      if (native.ok) return native;
      try {
        const bytes = await readNativeFileBytes(filePath);
        if (!bytes || !hasPdfSignature(bytes)) return native;
        const thumbnail = await renderPdfThumbnail(bytes, size, quality);
        return {
          ok: true,
          bytes: thumbnail.bytes,
          mime: thumbnail.mime,
          sizeBytes: thumbnail.sizeBytes,
          width: thumbnail.width,
          height: thumbnail.height,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    resolveUrlMeta: (url) =>
      canUseExternalContent()
        ? invokeContract('material_resolve_url_meta', { url })
        : Promise.resolve({
            ok: false,
            error: 'EXTERNAL_CONTENT_OFFLINE: URL metadata is unavailable while offline.',
          }),
  },

  assetStore: {
    beginImport: (projectId, assetId) =>
      invokeContract('asset_store_begin_import', { projectId, assetId }),
    commitImport: (projectId, assetId) =>
      invokeContract('asset_store_commit_import', { projectId, assetId }),
    gcOrphanImports: (retainedAssets) =>
      invokeContract('asset_store_gc_orphan_imports', { retainedAssets }),
    async getPath(projectId, assetId, variant, ext) {
      return normalizeStoredAssetFileUrl(
        await invokeContract('asset_store_get_path', { projectId, assetId, variant, ext }),
      );
    },
    async writeBytes(projectId, assetId, variant, ext, bytes) {
      return normalizeStoredAssetFileUrl(
        await invokeContract('asset_store_write_bytes', {
          projectId,
          assetId,
          variant,
          ext,
          bytes: toNumberArray(bytes),
        }),
      );
    },
    async copyFile(projectId, assetId, variant, ext, sourcePath) {
      return normalizeStoredAssetFileUrl(
        await invokeContract('asset_store_copy_file', {
          projectId,
          assetId,
          variant,
          ext,
          sourcePath,
        }),
      );
    },
    deleteAsset: (projectId, assetId) =>
      invokeContract('asset_store_delete_asset', { projectId, assetId }),
  },

  archive: {
    save: (filename, bytes) =>
      invokeContract('archive_save', { filename, bytes: toNumberArray(bytes) }),
  },

  updater: {
    check: () => invokeContract('update_check', undefined),
    download: (callback) => {
      const onEvent = new Channel<AppUpdateDownloadEvent>(callback);
      return invokeContract('update_download', { onEvent });
    },
    install: () => invokeContract('update_install', undefined),
    dismiss: () => invokeContract('update_dismiss', undefined),
  },

  aiLog: {
    write: (filename, content) => invokeContract('ai_log_write', { filename, content }),
    openDir: () => invokeContract('ai_log_open_dir', undefined),
    getDir: () => invokeContract('ai_log_get_dir', undefined),
  },

  mcpStdio: {
    start: (input) => invokeContract('mcp_stdio_start', { input }),
    request: (input) => invokeContract('mcp_stdio_request', { input }),
    notify: (input) => invokeContract('mcp_stdio_notify', { input }),
    stop: (processId) => invokeContract('mcp_stdio_stop', { processId }),
    status: (processId) => invokeContract('mcp_stdio_status', { processId }),
  },

  mcpHttp: {
    request: (input) => invokeContract('mcp_http_request', { input }),
    cancel: (requestId) => invokeContract('mcp_http_cancel', { requestId }),
  },

  openAIResponses: {
    request: nativeOpenAIResponse,
  },
};
