/**
 * Renderer <-> Tauri command/event contracts.
 *
 * Keep this file free of Tauri implementation details. Rust commands should
 * mirror these names and camelCase payloads so desktop and mobile use the same
 * renderer API. A command that has not landed in Rust yet rejects with a
 * `PlatformUnavailableError`; callers never silently fall back to browser
 * storage or a legacy bridge.
 */

export type PlatformTarget = 'desktop' | 'mobile';

export type ContractAvailability = 'available' | 'contract-backed' | 'unsupported';

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  architecture: string;
}

export interface SystemFontFamily {
  /** Stable family name used as the CSS font-family value. */
  family: string;
  /** Localized family names used for search/display only. */
  aliases: string[];
}

export interface NativePlatformCapabilities {
  desktopWindowControls: boolean;
  deepLinks: boolean;
  externalUrlOpener: boolean;
  generalAgent: boolean;
  generalAgentUnavailableReason: string;
  mcpStdio: boolean;
  secureStorage?: boolean;
  materialFiles?: boolean;
  assetCache?: boolean;
  aiLog?: boolean;
  oauth?: boolean;
  imageCodecs?: {
    rust: string[];
    nativeSystem: string[];
    runtimeChecked: boolean;
  };
}

export interface PlatformCapabilities extends NativePlatformCapabilities {
  runtime: 'tauri';
  target: PlatformTarget;
  /**
   * `contract-backed` means the renderer contract is present but the running
   * native binary did not advertise the corresponding Rust implementation.
   * Invoking that feature rejects clearly; it is not a browser fallback.
   */
  featureStatus: {
    secureStorage: ContractAvailability;
    materialFiles: ContractAvailability;
    assetCache: ContractAvailability;
    aiLog: ContractAvailability;
    oauth: ContractAvailability;
    mcpStdio: ContractAvailability;
    generalAgent: ContractAvailability;
  };
}

export interface LifecycleStatus {
  pendingFlushRequestId: number | null;
}

export interface DeepLinkEventPayload {
  urls: string[];
}

export interface LifecycleEventPayload {
  event: 'ready' | 'resumed' | 'flush-requested';
  requestId: number | null;
  deadlineMs: number | null;
  reason: 'shutdown' | 'suspended' | null;
  confirmationRequired: boolean;
}

export type OpenResult = { ok: true } | { ok: false; error: string };

export type FilePickerKind = 'image' | 'pdf' | 'any';

export type PickFileResult =
  | { ok: true; filePath: string; sizeBytes: number | null }
  | { ok: false; canceled: true }
  | {
      ok: false;
      canceled: false;
      code: 'MATERIAL_FILE_TOO_LARGE';
      error: string;
      /** Native-owned limit; the renderer must not duplicate this value. */
      maxSizeBytes: number;
    }
  | {
      ok: false;
      canceled: false;
      code: 'MATERIAL_IMPORT_FAILED';
      error: string;
      maxSizeBytes: null;
    };

export type DeleteImportResult = { ok: true } | { ok: false; error: string };

export type ThumbnailResult = { ok: true; dataUrl: string } | { ok: false; error: string };

export type NativeBytes = ArrayBuffer | Uint8Array | number[];

export type ReadBytesResult = { ok: true; bytes: NativeBytes } | { ok: false; error: string };

export type InspectImageResult =
  | { ok: true; mime: string; sizeBytes: number; width: number; height: number }
  | { ok: false; error: string };

export type ImageVariantResult =
  | {
      ok: true;
      bytes: NativeBytes;
      mime: string;
      sizeBytes: number;
      width: number;
      height: number;
    }
  | { ok: false; error: string };

export interface PrepareImageOptions {
  displayMaxLongEdge: number;
  displayQuality: number;
  thumbnailMaxLongEdge: number;
  thumbnailQuality: number;
}

export type PrepareImageResult =
  | {
      ok: true;
      source: { mime: string; sizeBytes: number; width: number; height: number };
      display: Extract<ImageVariantResult, { ok: true }>;
      thumbnail: Extract<ImageVariantResult, { ok: true }>;
    }
  | {
      ok: false;
      code: 'IMAGE_CODEC_UNAVAILABLE' | 'IMAGE_INVALID';
      codec: 'heic' | 'heif' | 'avif' | null;
      error: string;
    };

export type UrlMetadataResult =
  | { ok: true; title: string | null; ogImage: string | null; favicon: string | null }
  | { ok: false; error: string };

export type AssetVariant = 'source' | 'display' | 'thumbnail';

export type AssetCachePathResult =
  | {
      ok: true;
      filePath: string;
      fileUrl: string;
      exists: boolean;
      sizeBytes: number | null;
    }
  | { ok: false; error: string };

export type AssetCacheWriteResult =
  | { ok: true; filePath: string; fileUrl: string; sizeBytes: number }
  | { ok: false; error: string };

export type AssetCacheUploadResult = { ok: true; sizeBytes: number } | { ok: false; error: string };

export type AssetCacheDeleteResult = { ok: true } | { ok: false; error: string };

export type AILogWriteResult = { ok: true; filePath: string } | { ok: false; error: string };

export interface McpStdioStartInput {
  processId: string;
  command: string;
  args: string[];
  cwd: string | null;
  /** Public environment only. Secret values are resolved from Keychain first. */
  env: Record<string, string>;
  configRevision: string;
}

export interface McpStdioStartResult {
  processId: string;
  pid: number;
}

export interface McpStdioRequestInput {
  processId: string;
  requestId: string;
  /** One complete JSON-RPC object. Newlines are rejected by the native host. */
  message: string;
  timeoutMs: number;
}

export interface McpStdioNotifyInput {
  processId: string;
  /** A complete JSON-RPC notification with no id. */
  message: string;
}

export interface McpStdioStatusResult {
  processId: string;
  running: boolean;
  pid: number | null;
  configRevision: string | null;
  fatalError: string | null;
  stderrLines: string[];
}

export interface McpHttpRequestInput {
  /** Transport-unique cancellation identity; not the JSON-RPC authority id. */
  requestId: string;
  url: string;
  method: 'POST' | 'DELETE';
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}

export interface McpHttpResponseResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface TauriCommandContract {
  app_get_info: { args: undefined; result: AppInfo };
  app_get_path: { args: { name: string }; result: string };
  platform_capabilities: { args: undefined; result: NativePlatformCapabilities };
  window_minimize: { args: undefined; result: void };
  window_toggle_maximize: { args: undefined; result: boolean };
  window_is_maximized: { args: undefined; result: boolean };
  window_close: { args: undefined; result: void };
  window_set_traffic_light_position: {
    args: { position: { x: number; y: number } };
    result: void;
  };
  opener_open_external: { args: { url: string }; result: void };
  deep_link_take_pending: { args: undefined; result: string[] };
  lifecycle_get_status: { args: undefined; result: LifecycleStatus };
  lifecycle_complete_flush: { args: { requestId: number }; result: boolean };
  typography_list_system_fonts: { args: undefined; result: SystemFontFamily[] };
  keychain_get: { args: { key: string }; result: string | null };
  keychain_set: { args: { key: string; value: string }; result: boolean };
  keychain_delete: { args: { key: string }; result: boolean };
  material_open_local: { args: { filePath: string }; result: OpenResult };
  material_pick_file: { args: { kind: FilePickerKind }; result: PickFileResult };
  material_delete_import: { args: { filePath: string }; result: DeleteImportResult };
  material_thumbnail: {
    args: { filePath: string; size: number };
    result: ThumbnailResult;
  };
  material_read_bytes: { args: { filePath: string }; result: ReadBytesResult };
  material_inspect_image: { args: { filePath: string }; result: InspectImageResult };
  material_prepare_image: {
    args: { filePath: string } & PrepareImageOptions;
    result: PrepareImageResult;
  };
  material_create_image_variant: {
    args: { filePath: string; maxLongEdge: number; quality: number };
    result: ImageVariantResult;
  };
  material_create_thumbnail_variant: {
    args: { filePath: string; size: number; quality: number };
    result: ImageVariantResult;
  };
  material_resolve_url_meta: { args: { url: string }; result: UrlMetadataResult };
  asset_cache_get_path: {
    args: { projectId: string; assetId: string; variant: AssetVariant; ext: string };
    result: AssetCachePathResult;
  };
  asset_cache_write_bytes: {
    args: {
      projectId: string;
      assetId: string;
      variant: AssetVariant;
      ext: string;
      bytes: number[];
    };
    result: AssetCacheWriteResult;
  };
  asset_cache_copy_file: {
    args: {
      projectId: string;
      assetId: string;
      variant: AssetVariant;
      ext: string;
      sourcePath: string;
    };
    result: AssetCacheWriteResult;
  };
  asset_cache_upload_file: {
    args: {
      url: string;
      projectId: string;
      assetId: string;
      variant: AssetVariant;
      ext: string;
      contentType: string;
    };
    result: AssetCacheUploadResult;
  };
  asset_cache_download: {
    args: { url: string; projectId: string; assetId: string; variant: AssetVariant; ext: string };
    result: AssetCacheWriteResult;
  };
  asset_cache_delete_asset: {
    args: { projectId: string; assetId: string };
    result: AssetCacheDeleteResult;
  };
  ai_log_write: {
    args: { filename: string; content: string };
    result: AILogWriteResult;
  };
  ai_log_open_dir: { args: undefined; result: string };
  ai_log_get_dir: { args: undefined; result: string };
  mcp_stdio_start: {
    args: { input: McpStdioStartInput };
    result: McpStdioStartResult;
  };
  mcp_stdio_request: {
    args: { input: McpStdioRequestInput };
    result: string;
  };
  mcp_stdio_notify: { args: { input: McpStdioNotifyInput }; result: void };
  mcp_stdio_stop: { args: { processId: string }; result: boolean };
  mcp_stdio_status: {
    args: { processId: string };
    result: McpStdioStatusResult;
  };
  mcp_http_request: {
    args: { input: McpHttpRequestInput };
    result: McpHttpResponseResult;
  };
  mcp_http_cancel: { args: { requestId: string }; result: boolean };
}

export interface TauriEventContract {
  'drifting:deep-link': DeepLinkEventPayload;
  'drifting:lifecycle': LifecycleEventPayload;
}

export type TauriCommandName = keyof TauriCommandContract;
export type TauriCommandArgs<Name extends TauriCommandName> = TauriCommandContract[Name]['args'];
export type TauriCommandResult<Name extends TauriCommandName> =
  TauriCommandContract[Name]['result'];
