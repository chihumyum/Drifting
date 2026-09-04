import type {
  AILogWriteResult,
  AppUpdateDownloadEvent,
  AppUpdateMetadata,
  AppInfo,
  ArchiveSaveResult,
  AssetStoreDeleteResult,
  AssetStorePathResult,
  AssetStoreWriteResult,
  AssetVariant,
  CodexLoginProjection,
  CodexSubscriptionStatus,
  DeleteImportResult,
  FilePickerKind,
  ImageVariantResult,
  InspectImageResult,
  McpStdioRequestInput,
  McpStdioNotifyInput,
  McpStdioStartInput,
  McpStdioStartResult,
  McpStdioStatusResult,
  McpHttpRequestInput,
  McpHttpResponseResult,
  OpenResult,
  PickFileResult,
  PlatformCapabilities,
  PrepareImageOptions,
  PrepareImageResult,
  SystemFontFamily,
  SyncLocalObjectResult,
  SyncObjectGcResult,
  SyncPreparedAssetSourceResult,
  SyncVerifiedAssetSourceResult,
  NativeSyncObjectKind,
  NativeBytes,
  ThumbnailResult,
  UrlMetadataResult,
  GoogleDriveNativeOAuthResult,
  GoogleDriveNativeRemoteChange,
  GoogleDriveNativeRemoteObject,
  GoogleDriveNativeProjectSnapshotCandidate,
  GoogleDriveNativeGeneration,
} from './contracts';

export type Unsubscribe = () => void;

export interface LifecycleFlushRequest {
  requestId: number | null;
  reason: 'shutdown' | 'suspended';
  deadlineMs: number | null;
  confirmationRequired: boolean;
}

export interface OAuthCallback {
  token: string | null;
  error: string | null;
}

export interface AppPlatformApi {
  getInfo(): Promise<AppInfo>;
  getVersion(): Promise<string>;
  getPath(name: string): Promise<string>;
  getCapabilities(): Promise<PlatformCapabilities>;
}

export interface WindowPlatformApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** macOS desktop only. Other targets reject as unsupported. */
  setTrafficLightPosition(position: { x: number; y: number }): Promise<void>;
}

export interface LifecyclePlatformApi {
  onFlushBeforeQuit(callback: (request: LifecycleFlushRequest) => void): Unsubscribe;
  /** Native cold-ready/resume wake-up used by foreground-only SyncEngine polling. */
  onReadyOrResume(callback: (event: 'ready' | 'resumed') => void): Unsubscribe;
  confirmFlushBeforeQuit(requestId: number): Promise<boolean>;
}

export interface AuthPlatformApi {
  openOAuthBrowser(provider: string): Promise<void>;
  onOAuthCallback(callback: (data: OAuthCallback) => void): Unsubscribe;
}

export interface KeychainPlatformApi {
  /** Renderer-managed values only; native SyncEngine/provider namespaces reject. */
  get(key: string): Promise<string | null>;
  /** Existence-only status. It must not release or decrypt a secret to JS. */
  has(key: string): Promise<boolean>;
  /** Renderer-managed values only; native SyncEngine/provider namespaces reject. */
  set(key: string, value: string): Promise<boolean>;
  /** Renderer-managed values only; native SyncEngine/provider namespaces reject. */
  delete(key: string): Promise<boolean>;
}

export interface SyncObjectStorePlatformApi {
  /** Stages small protocol bytes and returns an opaque native file reference. */
  stageBytes(bytes: ArrayBuffer | Uint8Array): Promise<SyncLocalObjectResult>;
  /** Copies the canonical app-owned source without exposing its path to provider code. */
  stageAssetSource(projectId: string, assetId: string, ext: string): Promise<SyncLocalObjectResult>;
  /** Best-effort cleanup for an opaque native staging object. */
  discardLocal?(sourceRef: string): Promise<void>;
  /** Removes only current-format native objects absent from the durable SQLite inventory. */
  gcOrphans(input: {
    retainedSourceRefs: readonly string[];
    olderThanMs: number;
  }): Promise<SyncObjectGcResult>;
  /** Reads bounded protocol bytes from a root-validated opaque local object. */
  readProtocolBytes(sourceRef: string, maxBytes: number): Promise<NativeBytes>;
}

export interface SyncAssetStorePlatformApi {
  captureSource(input: {
    projectId: string;
    assetId: string;
    expectedSourceSha256: string;
    expectedSizeBytes: number;
    expectedMimeType: string;
  }): Promise<SyncVerifiedAssetSourceResult>;
  prepareRestoreSource(input: {
    attemptId: string;
    targetProjectId: string;
    assetId: string;
    blobId: string;
    sourceRef: string;
    expectedSourceSha256: string;
    expectedSizeBytes: number;
    expectedMimeType: string;
    /** Receipt v2: preserve an existing canonical destination for rollback. */
    preserveExistingDestination?: boolean;
  }): Promise<SyncPreparedAssetSourceResult>;
  activateRestoreSources(input: {
    attemptId: string;
    targetProjectId: string;
    stagingRefs: readonly string[];
  }): Promise<string>;
  abandonRestoreAttempt(attemptId: string): Promise<void>;
  finalizeRestoreAttempt(attemptId: string): Promise<void>;
  gcRestoreAttempts(input: {
    retainedAttemptIds: readonly string[];
    olderThanMs: number;
  }): Promise<{ removedAttempts: number }>;
}

export interface GoogleDrivePlatformApi {
  /** Desktop uses loopback + PKCE; mobile delegates to the platform Google OAuth SDK. */
  connectAccount(): Promise<GoogleDriveNativeOAuthResult>;
  /** Idempotently marks the native provisional credential as owned by a durable SQLite attempt. */
  claimAccount(
    credentialSecretRef: string,
    accountSubject: string,
  ): Promise<GoogleDriveNativeOAuthResult>;
  /** Replaces a credential in place only after native verifies the same Google subject. */
  reauthorizeAccount(credentialSecretRef: string): Promise<GoogleDriveNativeOAuthResult>;
  /** Native reads/revokes/deletes the credential; the renderer passes only its opaque reference. */
  revokeAccount(credentialSecretRef: string, signal?: AbortSignal): Promise<void>;
  discoverProjectSnapshots(input: {
    credentialSecretRef: string;
    accountSubject: string;
    pageToken?: string;
  }): Promise<{
    snapshots: GoogleDriveNativeProjectSnapshotCandidate[];
    nextPageToken?: string;
  }>;
  openGeneration(input: {
    credentialSecretRef: string;
    accountSubject: string;
    bindingId: string;
    syncGenerationId: string;
    authorityGeneration: number;
  }): Promise<GoogleDriveNativeGeneration>;
  captureStartCursor(generationRef: string): Promise<string>;
  listInventory(input: {
    generationRef: string;
    pageToken?: string;
  }): Promise<{ objects: GoogleDriveNativeRemoteObject[]; nextPageToken?: string }>;
  listChanges(input: {
    generationRef: string;
    cursor: string;
    pageToken?: string;
  }): Promise<{
    changes: GoogleDriveNativeRemoteChange[];
    nextPageToken?: string;
    newCursor?: string;
  }>;
  statImmutable(input: {
    generationRef: string;
    objectKind: NativeSyncObjectKind;
    logicalKeyId: string;
  }): Promise<GoogleDriveNativeRemoteObject | null>;
  uploadImmutable(input: {
    generationRef: string;
    sourceRef: string;
    objectKind: NativeSyncObjectKind;
    logicalKeyId: string;
    storedSha256: string;
    sizeBytes: number;
    transferId: string;
    signal: AbortSignal;
  }): Promise<{ status: 'created' | 'already-present'; object: GoogleDriveNativeRemoteObject }>;
  downloadVerifiedImmutable(input: {
    generationRef: string;
    objectId: string;
    destinationRef: string;
    expectedStoredSha256: string;
    transferId: string;
    signal: AbortSignal;
  }): Promise<{ destinationRef: string; storedSha256: string; sizeBytes: number }>;
}

export interface TypographyPlatformApi {
  listSystemFonts(): Promise<SystemFontFamily[]>;
}

export interface MaterialPlatformApi {
  /** Convert an absolute native path into a URL that the current WebView may load. */
  toLocalResourceUrl(filePath: string): string | null;
  openLocal(filePath: string): Promise<OpenResult>;
  openExternal(url: string): Promise<OpenResult>;
  pickFile(kind?: FilePickerKind): Promise<PickFileResult>;
  deleteImport(filePath: string): Promise<DeleteImportResult>;
  thumbnail(filePath: string, size?: number): Promise<ThumbnailResult>;
  readBytes(
    filePath: string,
  ): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; error: string }>;
  inspectImage(filePath: string): Promise<InspectImageResult>;
  prepareImage(
    filePath: string,
    options?: Partial<PrepareImageOptions>,
  ): Promise<
    | (Omit<Extract<PrepareImageResult, { ok: true }>, 'display' | 'thumbnail'> & {
        display: Omit<Extract<ImageVariantResult, { ok: true }>, 'bytes'> & {
          bytes: ArrayBuffer;
        };
        thumbnail: Omit<Extract<ImageVariantResult, { ok: true }>, 'bytes'> & {
          bytes: ArrayBuffer;
        };
      })
    | Extract<PrepareImageResult, { ok: false }>
  >;
  createImageVariant(
    filePath: string,
    maxLongEdge: number,
    quality: number,
  ): Promise<
    | (Omit<Extract<ImageVariantResult, { ok: true }>, 'bytes'> & { bytes: ArrayBuffer })
    | Extract<ImageVariantResult, { ok: false }>
  >;
  createThumbnailVariant(
    filePath: string,
    size: number,
    quality: number,
  ): Promise<
    | (Omit<Extract<ImageVariantResult, { ok: true }>, 'bytes'> & { bytes: ArrayBuffer })
    | Extract<ImageVariantResult, { ok: false }>
  >;
  resolveUrlMeta(url: string): Promise<UrlMetadataResult>;
}

export interface AssetStorePlatformApi {
  beginImport(projectId: string, assetId: string): Promise<void>;
  commitImport(projectId: string, assetId: string): Promise<void>;
  gcOrphanImports(
    retainedAssets: import('./contracts').AssetStoreRetainedAsset[],
  ): Promise<import('./contracts').AssetStoreGcResult>;
  getPath(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
  ): Promise<AssetStorePathResult>;
  writeBytes(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
    bytes: ArrayBuffer | Uint8Array,
  ): Promise<AssetStoreWriteResult>;
  copyFile(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
    sourcePath: string,
  ): Promise<AssetStoreWriteResult>;
  deleteAsset(projectId: string, assetId: string): Promise<AssetStoreDeleteResult>;
}

export interface ArchivePlatformApi {
  /** Save an app-generated ZIP through the native document picker. */
  save(filename: string, bytes: ArrayBuffer | Uint8Array): Promise<ArchiveSaveResult>;
}

export interface AILogPlatformApi {
  write(filename: string, content: string): Promise<AILogWriteResult>;
  openDir(): Promise<string>;
  getDir(): Promise<string>;
}

export interface UpdatePlatformApi {
  check(): Promise<AppUpdateMetadata | null>;
  download(onEvent: (event: AppUpdateDownloadEvent) => void): Promise<number>;
  install(): Promise<void>;
  dismiss(): Promise<void>;
}

export interface McpStdioPlatformApi {
  start(input: McpStdioStartInput): Promise<McpStdioStartResult>;
  request(input: McpStdioRequestInput): Promise<string>;
  notify(input: McpStdioNotifyInput): Promise<void>;
  stop(processId: string): Promise<boolean>;
  status(processId: string): Promise<McpStdioStatusResult>;
}

export interface McpHttpPlatformApi {
  request(input: McpHttpRequestInput): Promise<McpHttpResponseResult>;
  cancel(requestId: string): Promise<boolean>;
}

export interface OpenAIResponsesPlatformApi {
  /** Native fixed-origin Responses transport; the API key never enters JS. */
  request(body: string, signal: AbortSignal): Promise<Response>;
}

/**
 * Experimental ChatGPT subscription route. The OAuth tokens live only in
 * native secure storage; the renderer drives sign-in and reads status.
 */
export interface CodexSubscriptionPlatformApi extends OpenAIResponsesPlatformApi {
  /** Native Codex-backend Responses transport authorized by the ChatGPT sign-in. */
  request(body: string, signal: AbortSignal): Promise<Response>;
  status(): Promise<CodexSubscriptionStatus>;
  /** Starts a device-code sign-in; poll `status()` until the attempt is terminal. */
  startLogin(): Promise<CodexLoginProjection>;
  cancelLogin(): Promise<boolean>;
  logout(): Promise<boolean>;
}

export interface PlatformApi {
  readonly app: AppPlatformApi;
  readonly window: WindowPlatformApi;
  readonly lifecycle: LifecyclePlatformApi;
  readonly auth: AuthPlatformApi;
  readonly keychain: KeychainPlatformApi;
  readonly syncObjectStore: SyncObjectStorePlatformApi;
  readonly syncAssetStore: SyncAssetStorePlatformApi;
  readonly googleDrive: GoogleDrivePlatformApi;
  readonly typography: TypographyPlatformApi;
  readonly material: MaterialPlatformApi;
  readonly assetStore: AssetStorePlatformApi;
  readonly archive: ArchivePlatformApi;
  readonly updater: UpdatePlatformApi;
  readonly aiLog: AILogPlatformApi;
  readonly mcpStdio: McpStdioPlatformApi;
  readonly mcpHttp: McpHttpPlatformApi;
  readonly openAIResponses: OpenAIResponsesPlatformApi;
  readonly codexSubscription: CodexSubscriptionPlatformApi;
}
