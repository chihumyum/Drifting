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
  syncObjectStore?: boolean;
  googleDriveTransport?: boolean;
  /** Desktop loopback-PKCE OAuth implementation, separate from Drive transport. */
  googleDriveOAuth?: boolean;
  materialFiles?: boolean;
  assetStore?: boolean;
  aiLog?: boolean;
  appUpdater?: boolean;
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
    syncObjectStore: ContractAvailability;
    googleDriveTransport: ContractAvailability;
    googleDriveOAuth: ContractAvailability;
    materialFiles: ContractAvailability;
    assetStore: ContractAvailability;
    aiLog: ContractAvailability;
    appUpdater?: ContractAvailability;
    oauth: ContractAvailability;
    mcpStdio: ContractAvailability;
    generalAgent: ContractAvailability;
  };
}

export interface LifecycleStatus {
  pendingFlushRequestId: number | null;
}

export type NativeSyncObjectKind =
  | 'segment'
  | 'genesis'
  | 'checkpoint'
  | 'snapshot-commit'
  | 'blob';

export interface SyncLocalObjectResult {
  sourceRef: string;
  sizeBytes: number;
  storedSha256: string;
}

export interface SyncObjectGcResult {
  removedObjects: number;
  removedTemporaryFiles: number;
}

export interface SyncProtocolChunkResult {
  offset: number;
  totalSizeBytes: number;
  bytes: NativeBytes;
}

export interface SyncVerifiedAssetSourceResult {
  sourceRef: string;
  blobId: string;
  sourceSha256: string;
  sizeBytes: number;
  mimeType: string;
}

export interface SyncPreparedAssetSourceResult {
  assetId: string;
  stagingRef: string;
  sourceSha256: string;
  sizeBytes: number;
}

export interface SyncAssetGcResult {
  removedAttempts: number;
}

export type GoogleDriveNativeErrorCode =
  | 'cancelled'
  | 'offline'
  | 'needs-reauth'
  | 'permission-denied'
  | 'rate-limited'
  | 'quota-exceeded'
  | 'transient'
  | 'invalid-cursor'
  | 'invalid-page-token'
  | 'invalid-request'
  | 'local-object-invalid'
  | 'remote-object-missing'
  | 'immutable-conflict'
  | 'remote-corrupt'
  | 'configuration-required'
  | 'account-mismatch'
  | 'unsupported-platform';

export interface GoogleDriveNativeDiagnosticError {
  /** Allowlisted family/domain labels only; raw NSError text and userInfo never cross IPC. */
  family: string;
  domain: string;
  code: number;
  reason: string | null;
  httpStatus: number | null;
}

export interface GoogleDriveNativeDiagnostics {
  schemaVersion: 1;
  operation: string;
  platform: string;
  phase: string;
  elapsedMs: number;
  completedPhases: string[];
  errorChain: GoogleDriveNativeDiagnosticError[];
}

export interface GoogleDriveNativeError {
  code: GoogleDriveNativeErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  diagnostics?: GoogleDriveNativeDiagnostics | null;
}

export type GoogleDriveNativeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GoogleDriveNativeError };

export interface GoogleDriveNativeRemoteObject {
  objectId: string;
  objectKind: NativeSyncObjectKind;
  logicalKeyId: string;
  storedSha256: string;
  sizeBytes: number;
}

export interface GoogleDriveNativeProjectSnapshotCandidate {
  syncGenerationId: string;
  object: GoogleDriveNativeRemoteObject & { objectKind: 'snapshot-commit' };
}

export type GoogleDriveNativeRemoteChange =
  | { kind: 'present'; object: GoogleDriveNativeRemoteObject }
  | { kind: 'removed'; objectId: string; logicalKeyId: string | null };

export interface GoogleDriveNativeGeneration {
  generationRef: string;
  syncGenerationId: string;
}

export interface GoogleDriveNativeOAuthResult {
  credentialSecretRef: string;
  accountSubject: string;
}

export interface GoogleDriveNativeRevokeResult {
  status: 'revoked' | 'already-revoked' | 'already-missing';
  diagnostics?: GoogleDriveNativeDiagnostics | null;
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

export type AssetStorePathResult =
  | {
      ok: true;
      filePath: string;
      fileUrl: string;
      exists: boolean;
      sizeBytes: number | null;
    }
  | { ok: false; error: string };

export type AssetStoreWriteResult =
  | { ok: true; filePath: string; fileUrl: string; sizeBytes: number }
  | { ok: false; error: string };

export type AssetStoreDeleteResult = { ok: true } | { ok: false; error: string };
export interface AssetStoreRetainedAsset {
  projectId: string;
  assetId: string;
}
export interface AssetStoreGcResult {
  removedOrphans: number;
  clearedCommittedMarkers: number;
}

export type ArchiveSaveResult =
  | { ok: true }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string };

export interface AppUpdateMetadata {
  version: string;
  currentVersion: string;
  notes: string | null;
  publishedAt: string | null;
}

export type AppUpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength: number | null } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

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

export interface OpenAIResponsesRequestInput {
  /** Transport-only cancellation identity; never an OpenAI response id. */
  requestId: string;
  /** Responses API JSON body. Authorization is injected by native code. */
  body: string;
  timeoutMs: number;
}

export type OpenAIResponsesStreamEvent =
  | {
      type: 'started';
      status: number;
      requestId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    }
  | { type: 'chunk'; bytes: number[] | Uint8Array }
  | { type: 'finished' };

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
  keychain_has: { args: { key: string }; result: boolean };
  keychain_set: { args: { key: string; value: string }; result: boolean };
  keychain_delete: { args: { key: string }; result: boolean };
  sync_object_allocate_protocol: {
    args: undefined;
    result: SyncLocalObjectResult;
  };
  sync_object_append_protocol_chunk: {
    args: { sourceRef: string; offset: number; bytes: number[] };
    result: number;
  };
  sync_object_finalize_protocol: {
    args: { sourceRef: string; expectedSizeBytes: number };
    result: SyncLocalObjectResult;
  };
  sync_object_discard_local: {
    args: { sourceRef: string };
    result: undefined;
  };
  sync_object_gc_orphans: {
    args: { retainedSourceRefs: readonly string[]; olderThanMs: number };
    result: SyncObjectGcResult;
  };
  sync_object_stage_asset_source: {
    args: { projectId: string; assetId: string; ext: string };
    result: SyncLocalObjectResult;
  };
  sync_object_read_protocol_chunk: {
    args: { sourceRef: string; offset: number; maxBytes: number };
    result: SyncProtocolChunkResult;
  };
  sync_asset_capture_source: {
    args: {
      projectId: string;
      assetId: string;
      expectedSourceSha256: string;
      expectedSizeBytes: number;
      expectedMimeType: string;
      preserveExistingDestination?: boolean;
    };
    result: SyncVerifiedAssetSourceResult;
  };
  sync_asset_prepare_restore_source: {
    args: {
      attemptId: string;
      targetProjectId: string;
      assetId: string;
      blobId: string;
      sourceRef: string;
      expectedSourceSha256: string;
      expectedSizeBytes: number;
      expectedMimeType: string;
    };
    result: SyncPreparedAssetSourceResult;
  };
  sync_asset_activate_restore_sources: {
    args: { attemptId: string; targetProjectId: string; stagingRefs: readonly string[] };
    result: string;
  };
  sync_asset_abandon_restore_attempt: {
    args: { attemptId: string };
    result: undefined;
  };
  sync_asset_finalize_restore_attempt: {
    args: { attemptId: string };
    result: undefined;
  };
  sync_asset_gc_restore_attempts: {
    args: { retainedAttemptIds: readonly string[]; olderThanMs: number };
    result: SyncAssetGcResult;
  };
  google_drive_oauth_connect: {
    args: undefined;
    result: GoogleDriveNativeResult<GoogleDriveNativeOAuthResult>;
  };
  google_drive_claim_account: {
    args: { credentialSecretRef: string; accountSubject: string };
    result: GoogleDriveNativeResult<GoogleDriveNativeOAuthResult>;
  };
  google_drive_oauth_reauthorize: {
    args: { credentialSecretRef: string };
    result: GoogleDriveNativeResult<GoogleDriveNativeOAuthResult>;
  };
  google_drive_revoke_account: {
    args: { credentialSecretRef: string; transferId: string };
    result: GoogleDriveNativeResult<GoogleDriveNativeRevokeResult>;
  };
  google_drive_open_generation: {
    args: {
      credentialSecretRef: string;
      accountSubject: string;
      bindingId: string;
      syncGenerationId: string;
      authorityGeneration: number;
    };
    result: GoogleDriveNativeResult<GoogleDriveNativeGeneration>;
  };
  google_drive_discover_project_snapshots: {
    args: { credentialSecretRef: string; accountSubject: string; pageToken?: string };
    result: GoogleDriveNativeResult<{
      snapshots: GoogleDriveNativeProjectSnapshotCandidate[];
      nextPageToken?: string;
    }>;
  };
  google_drive_capture_start_cursor: {
    args: { generationRef: string };
    result: GoogleDriveNativeResult<string>;
  };
  google_drive_list_inventory: {
    args: { generationRef: string; pageToken?: string };
    result: GoogleDriveNativeResult<{
      objects: GoogleDriveNativeRemoteObject[];
      nextPageToken?: string;
    }>;
  };
  google_drive_list_changes: {
    args: { generationRef: string; cursor: string; pageToken?: string };
    result: GoogleDriveNativeResult<{
      changes: GoogleDriveNativeRemoteChange[];
      nextPageToken?: string;
      newCursor?: string;
    }>;
  };
  google_drive_stat_immutable: {
    args: { generationRef: string; objectKind: NativeSyncObjectKind; logicalKeyId: string };
    result: GoogleDriveNativeResult<GoogleDriveNativeRemoteObject | null>;
  };
  google_drive_upload_immutable: {
    args: {
      generationRef: string;
      sourceRef: string;
      objectKind: NativeSyncObjectKind;
      logicalKeyId: string;
      storedSha256: string;
      sizeBytes: number;
      transferId: string;
    };
    result: GoogleDriveNativeResult<{
      status: 'created' | 'already-present';
      object: GoogleDriveNativeRemoteObject;
    }>;
  };
  google_drive_download_verified_immutable: {
    args: {
      generationRef: string;
      objectId: string;
      destinationRef: string;
      expectedStoredSha256: string;
      transferId: string;
    };
    result: GoogleDriveNativeResult<{
      destinationRef: string;
      storedSha256: string;
      sizeBytes: number;
    }>;
  };
  google_drive_cancel_transfer: {
    args: { transferId: string };
    result: boolean;
  };
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
  asset_store_get_path: {
    args: { projectId: string; assetId: string; variant: AssetVariant; ext: string };
    result: AssetStorePathResult;
  };
  asset_store_write_bytes: {
    args: {
      projectId: string;
      assetId: string;
      variant: AssetVariant;
      ext: string;
      bytes: number[];
    };
    result: AssetStoreWriteResult;
  };
  asset_store_copy_file: {
    args: {
      projectId: string;
      assetId: string;
      variant: AssetVariant;
      ext: string;
      sourcePath: string;
    };
    result: AssetStoreWriteResult;
  };
  asset_store_begin_import: {
    args: { projectId: string; assetId: string };
    result: undefined;
  };
  asset_store_commit_import: {
    args: { projectId: string; assetId: string };
    result: undefined;
  };
  asset_store_gc_orphan_imports: {
    args: { retainedAssets: AssetStoreRetainedAsset[] };
    result: AssetStoreGcResult;
  };
  asset_store_delete_asset: {
    args: { projectId: string; assetId: string };
    result: AssetStoreDeleteResult;
  };
  archive_save: {
    args: { filename: string; bytes: number[] };
    result: ArchiveSaveResult;
  };
  update_check: { args: undefined; result: AppUpdateMetadata | null };
  update_download: {
    args: { onEvent: unknown };
    result: number;
  };
  update_install: { args: undefined; result: undefined };
  update_dismiss: { args: undefined; result: undefined };
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
  openai_responses_stream: {
    args: { input: OpenAIResponsesRequestInput; onEvent: unknown };
    result: void;
  };
  openai_responses_cancel: { args: { requestId: string }; result: boolean };
}

export interface TauriEventContract {
  'drifting:deep-link': DeepLinkEventPayload;
  'drifting:lifecycle': LifecycleEventPayload;
}

export type TauriCommandName = keyof TauriCommandContract;
export type TauriCommandArgs<Name extends TauriCommandName> = TauriCommandContract[Name]['args'];
export type TauriCommandResult<Name extends TauriCommandName> =
  TauriCommandContract[Name]['result'];
