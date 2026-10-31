import type { McpClient, McpServerConnection, McpServerCreateInput, McpServerPermissionInput } from './mcp-server-contract';
/**
 * Renderer <-> Tauri command/event contracts.
 *
 * Keep this file free of Tauri implementation details. Rust commands should
 * mirror these names and camelCase payloads so desktop and mobile use the same
 * renderer API. A command that has not landed in Rust yet rejects with a
 * `PlatformUnavailableError`; callers never silently fall back to browser
 * storage or a legacy bridge.
 */

/** Native copies only project-owned assets, never a renderer-supplied source path. */
export interface MarkdownProjectionAsset {
  path: string;
  assetId: string;
  variant: 'source' | 'display';
  ext: string;
  sourceSha256: string | null;
  sourceSizeBytes: number | null;
}

export interface MarkdownProjectionDocument {
  key: string;
  path: string;
  title: string;
  anchor: string | null;
  sourceVersion: string | null;
}

export interface MarkdownProjectionInfo {
  directory: string;
  customRoot: string | null;
  generatedAt: string | null;
  readOnly: false;
  reverseSync: true;
}

/** Generated reading files are replaced freely; authored files never over bytes Drifting has not read. */
export interface MarkdownProjectionEntry {
  path: string;
  text: string;
  authored?: boolean;
  /** SHA-256 of the authored file as Drifting last wrote or read it. */
  expectedSha256?: string | null;
}

export interface MarkdownProjectionWriteResult extends MarkdownProjectionInfo {
  /** Authored paths left untouched because they changed on disk. */
  conflicts: string[];
  /** Edited files kept under `.drifting/preserved` before being replaced. */
  preserved: string[];
}

export interface MarkdownProjectionReadRequest {
  path: string;
  knownSize: number | null;
  knownModifiedMs: number | null;
  force?: boolean;
}

export interface MarkdownProjectionReadResult {
  path: string;
  exists: boolean;
  size: number;
  modifiedMs: number;
  changed: boolean;
  sha256: string | null;
  text: string | null;
  error: string | null;
}

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

/** A cover image picked for a manuscript export, re-encoded by native code. */
export interface ManuscriptCoverImage {
  mediaType: 'image/jpeg' | 'image/png';
  data: string;
  width: number;
  height: number;
}

export type ManuscriptCoverPickResult =
  | { ok: true; canceled: false; cover: ManuscriptCoverImage }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string };

/** One native panic recorded by the panic hook and taken on the next launch. */
export interface NativeCrashReport {
  message: string;
  location: string;
  thread: string;
  backtrace: string;
  occurredAtMs: number;
  appVersion: string;
}

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

/** Native credential that authorizes a Responses request. */
export type OpenAIResponsesCredentialSource = 'api_key' | 'chatgpt_subscription';

export interface OpenAIResponsesRequestInput {
  /** Transport-only cancellation identity; never an OpenAI response id. */
  requestId: string;
  /** Responses API JSON body. Authorization is injected by native code. */
  body: string;
  timeoutMs: number;
  /** Defaults to the `byok.openai` API key when omitted. */
  credentialSource?: OpenAIResponsesCredentialSource;
}

export type CodexLoginPhase =
  | 'awaiting_authorization'
  | 'exchanging'
  | 'authenticated'
  | 'failed'
  | 'cancelled';

/** Renderer-visible projection of one ChatGPT device-code sign-in attempt. */
export interface CodexLoginProjection {
  attemptId: string;
  phase: CodexLoginPhase;
  /** One-time code the author types at `verificationUrl`. */
  userCode: string;
  verificationUrl: string;
  expiresAtMs: number;
  /** Bounded failure class; never provider text. */
  failure: string | null;
}

/** Non-secret claims from the signed-in ChatGPT account. */
export interface CodexAccountSummary {
  accountId: string | null;
  email: string | null;
  plan: string | null;
}

export interface CodexSubscriptionStatus {
  signedIn: boolean;
  account: CodexAccountSummary | null;
  login: CodexLoginProjection | null;
}

/** Native projection only: no tokens, provider instructions or raw responses. */
export interface CodexModel {
  slug: string;
  displayName: string;
  contextWindow: number | null;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  supportsReasoningSummary: boolean;
  supportsVerbosity: boolean;
}

export interface ImageCandidateTarget {
  kind: 'element';
  id: string;
}

/** Recorded with every generated candidate; keeping it copies this into the material. */
export interface ImageCandidateProvenance {
  provider: 'chatgpt-subscription';
  model: string;
  /** Exact prompt sent to the provider. */
  prompt: string;
  subjectPrompt: string | null;
  styleText: string | null;
  extraPrompt: string | null;
  conversationId: string | null;
  generationId: string | null;
  imagegenRequestId: string | null;
}

/** Unsynced local candidate under the native generation inbox. */
export interface ImageInboxCandidate {
  id: string;
  projectId: string;
  target: ImageCandidateTarget;
  createdAtMs: number;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  filePath: string;
  provenance: ImageCandidateProvenance;
}

/** Non-secret image limit projected from the Codex backend's response headers. */
export interface ImageQuotaSnapshot {
  limit: string | null;
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAtMs: number | null;
}

export interface CodexImagesGenerateInput {
  /** Transport-only cancellation identity. */
  requestId: string;
  projectId: string;
  target: ImageCandidateTarget;
  prompt: string;
  /** 1–4 independent requests; the subscription endpoint returns one image each. */
  count: number;
  provenance: {
    subjectPrompt?: string | null;
    styleText?: string | null;
    extraPrompt?: string | null;
    conversationId?: string | null;
  };
}

export interface CodexImagesGenerateResult {
  candidates: ImageInboxCandidate[];
  /** Bounded failure codes for requests that produced no candidate. */
  failures: string[];
  quota: ImageQuotaSnapshot | null;
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
  window_set_close_returns_to_shelf: { args: { enabled: boolean }; result: void };
  opener_open_external: { args: { url: string }; result: void };
  /** Drains only queued URLs that start with `prefix` (one consumer per kind). */
  deep_link_take_pending: { args: { prefix: string }; result: string[] };
  lifecycle_get_status: { args: undefined; result: LifecycleStatus };
  lifecycle_complete_flush: { args: { requestId: number }; result: boolean };
  typography_list_system_fonts: { args: undefined; result: SystemFontFamily[] };
  keychain_get: { args: { key: string }; result: string | null };
  sync_installation_identity: { args: undefined; result: string };
  keychain_has: { args: { key: string }; result: boolean };
  keychain_set: { args: { key: string; value: string }; result: boolean };
  keychain_delete: { args: { key: string }; result: boolean };
  hosted_sync_request: {
    args: { input: { origin: string; token: string; path: string; method: 'GET' | 'PUT' | 'DELETE' | 'POST'; transferId: string;
      sourceRef?: string; destinationRef?: string; objectKind?: string; storedSha256?: string; sizeBytes?: number;
      jsonBody?: unknown } };
    result: unknown;
  };
  hosted_sync_cancel: { args: { transferId: string }; result: void };
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
  material_open_local: { args: { filePath: string }; result: OpenResult };
  material_pick_file: { args: { kind: FilePickerKind }; result: PickFileResult };
  material_stage_import_bytes: { args: { bytes: number[]; name: string }; result: PickFileResult };
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
  archive_create_text_zip: {
    args: { entries: { path: string; text: string }[] };
    result: NativeBytes;
  };
  archive_save: {
    args: { filename: string; bytes: number[] };
    result: ArchiveSaveResult;
  };
  share_save_markdown: {
    args: { filename: string; markdown: string };
    result: ArchiveSaveResult;
  };
  manuscript_export_save: {
    args: { format: 'epub' | 'pdf' | 'docx'; filename: string; payload: string };
    result: ArchiveSaveResult;
  };
  manuscript_export_pick_cover: { args: undefined; result: ManuscriptCoverPickResult };
  update_check: { args: undefined; result: AppUpdateMetadata | null };
  update_download: {
    args: { onEvent: unknown };
    result: number;
  };
  update_install: { args: undefined; result: undefined };
  update_dismiss: { args: undefined; result: undefined };
  diagnostics_take_native_reports: { args: undefined; result: NativeCrashReport[] };
  ai_log_write: {
    args: { filename: string; content: string };
    result: AILogWriteResult;
  };
  ai_log_open_dir: { args: undefined; result: string };
  ai_log_get_dir: { args: undefined; result: string };
  markdown_projection_remove: { args: { projectId: string }; result: void };
  markdown_projection_info: { args: { projectId: string }; result: MarkdownProjectionInfo };
  markdown_projection_pick_output_root: { args: { title: string }; result: string | null };
  markdown_projection_set_output_root: {
    args: { projectId: string; customRoot: string | null };
    result: MarkdownProjectionInfo;
  };
  markdown_projection_write: {
    args: { projectId: string; generatedAt: string; entries: MarkdownProjectionEntry[]; assets: MarkdownProjectionAsset[]; documents: MarkdownProjectionDocument[] };
    result: MarkdownProjectionWriteResult;
  };
  markdown_projection_read: {
    args: { projectId: string; requests: MarkdownProjectionReadRequest[] };
    result: MarkdownProjectionReadResult[];
  };
  mcp_server_list: { args: undefined; result: McpServerConnection[] };
  mcp_server_create: { args: { input: McpServerCreateInput }; result: McpServerConnection };
  mcp_server_connect: { args: { input: McpServerCreateInput; client: McpClient }; result: McpServerConnection };
  mcp_server_update_permission: { args: { input: McpServerPermissionInput }; result: McpServerConnection };
  mcp_server_revoke: { args: { id: string }; result: string | null };
  mcp_server_attach: { args: { projectId: string; onEvent: unknown }; result: string };
  mcp_server_detach: { args: { epoch: string }; result: void };
  mcp_server_complete: { args: { epoch: string; requestId: string; response: unknown }; result: void };
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
  codex_oauth_start: { args: undefined; result: CodexLoginProjection };
  codex_oauth_status: { args: undefined; result: CodexSubscriptionStatus };
  codex_models_list: { args: undefined; result: CodexModel[] };
  codex_oauth_cancel: { args: undefined; result: boolean };
  codex_oauth_logout: { args: undefined; result: boolean };
  codex_images_generate: {
    args: { input: CodexImagesGenerateInput };
    result: CodexImagesGenerateResult;
  };
  codex_images_cancel: { args: { requestId: string }; result: boolean };
  image_inbox_list: { args: { projectId: string }; result: ImageInboxCandidate[] };
  image_inbox_delete: { args: { projectId: string; candidateId: string }; result: void };
  image_inbox_stage_import: { args: { projectId: string; candidateId: string }; result: string };
}

export interface TauriEventContract {
  'drifting:deep-link': DeepLinkEventPayload;
  'drifting:lifecycle': LifecycleEventPayload;
  'drifting:close-to-shelf': null;
}

export type TauriCommandName = keyof TauriCommandContract;
export type TauriCommandArgs<Name extends TauriCommandName> = TauriCommandContract[Name]['args'];
export type TauriCommandResult<Name extends TauriCommandName> =
  TauriCommandContract[Name]['result'];
