import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { APP_CONFIG } from '../lib/config';
import { hasPdfSignature, renderPdfThumbnail } from '../lib/pdf-thumbnail';
import { consumePendingNativeOAuth, createPendingNativeOAuth } from './native-oauth-state';
import type {
  ContractAvailability,
  ImageVariantResult,
  LifecycleEventPayload,
  NativeBytes,
  NativePlatformCapabilities,
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
const GENERAL_AGENT_UNAVAILABLE =
  'General Agent is unavailable in the Tauri client because the current Anthropic runtime requires the desktop Node/CLI SDK.';

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

function normalizeAssetFileUrl<T extends { ok: boolean }>(result: T): T {
  if (!result.ok || !('filePath' in result) || typeof result.filePath !== 'string') return result;
  return { ...result, fileUrl: convertFileSrc(result.filePath) };
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
    generalAgent: false,
    generalAgentUnavailableReason:
      native.generalAgentUnavailableReason || GENERAL_AGENT_UNAVAILABLE,
    featureStatus: {
      secureStorage: advertised(native.secureStorage),
      materialFiles: advertised(native.materialFiles),
      assetCache: advertised(native.assetCache),
      aiLog: advertised(native.aiLog),
      oauth:
        native.oauth === undefined && native.deepLinks && native.externalUrlOpener
          ? 'available'
          : advertised(native.oauth),
      generalAgent: 'unsupported',
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
    confirmFlushBeforeQuit(requestId) {
      return invokeContract('lifecycle_complete_flush', { requestId });
    },
  },

  auth: {
    async openOAuthBrowser(provider) {
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
    set: (key, value) => invokeContract('keychain_set', { key, value }),
    delete: (key) => invokeContract('keychain_delete', { key }),
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
    resolveUrlMeta: (url) => invokeContract('material_resolve_url_meta', { url }),
  },

  assetCache: {
    async getPath(projectId, assetId, variant, ext) {
      return normalizeAssetFileUrl(
        await invokeContract('asset_cache_get_path', { projectId, assetId, variant, ext }),
      );
    },
    async writeBytes(projectId, assetId, variant, ext, bytes) {
      return normalizeAssetFileUrl(
        await invokeContract('asset_cache_write_bytes', {
          projectId,
          assetId,
          variant,
          ext,
          bytes: toNumberArray(bytes),
        }),
      );
    },
    async copyFile(projectId, assetId, variant, ext, sourcePath) {
      return normalizeAssetFileUrl(
        await invokeContract('asset_cache_copy_file', {
          projectId,
          assetId,
          variant,
          ext,
          sourcePath,
        }),
      );
    },
    uploadFile: (url, projectId, assetId, variant, ext, contentType) =>
      invokeContract('asset_cache_upload_file', {
        url,
        projectId,
        assetId,
        variant,
        ext,
        contentType,
      }),
    async download(url, projectId, assetId, variant, ext) {
      return normalizeAssetFileUrl(
        await invokeContract('asset_cache_download', { url, projectId, assetId, variant, ext }),
      );
    },
    deleteAsset: (projectId, assetId) =>
      invokeContract('asset_cache_delete_asset', { projectId, assetId }),
  },

  aiLog: {
    write: (filename, content) => invokeContract('ai_log_write', { filename, content }),
    openDir: () => invokeContract('ai_log_open_dir', undefined),
    getDir: () => invokeContract('ai_log_get_dir', undefined),
  },
};
