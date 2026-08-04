import type {
  AILogWriteResult,
  AppInfo,
  AssetCacheDeleteResult,
  AssetCachePathResult,
  AssetCacheUploadResult,
  AssetCacheWriteResult,
  AssetVariant,
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
  ThumbnailResult,
  UrlMetadataResult,
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
  confirmFlushBeforeQuit(requestId: number): Promise<boolean>;
}

export interface AuthPlatformApi {
  openOAuthBrowser(provider: string): Promise<void>;
  onOAuthCallback(callback: (data: OAuthCallback) => void): Unsubscribe;
}

export interface KeychainPlatformApi {
  get(key: string): Promise<string | null>;
  /** Existence-only status. It must not release or decrypt a secret to JS. */
  has(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
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

export interface AssetCachePlatformApi {
  getPath(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
  ): Promise<AssetCachePathResult>;
  writeBytes(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
    bytes: ArrayBuffer | Uint8Array,
  ): Promise<AssetCacheWriteResult>;
  copyFile(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
    sourcePath: string,
  ): Promise<AssetCacheWriteResult>;
  uploadFile(
    url: string,
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
    contentType: string,
  ): Promise<AssetCacheUploadResult>;
  download(
    url: string,
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
  ): Promise<AssetCacheWriteResult>;
  deleteAsset(projectId: string, assetId: string): Promise<AssetCacheDeleteResult>;
}

export interface AILogPlatformApi {
  write(filename: string, content: string): Promise<AILogWriteResult>;
  openDir(): Promise<string>;
  getDir(): Promise<string>;
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

export interface PlatformApi {
  readonly app: AppPlatformApi;
  readonly window: WindowPlatformApi;
  readonly lifecycle: LifecyclePlatformApi;
  readonly auth: AuthPlatformApi;
  readonly keychain: KeychainPlatformApi;
  readonly typography: TypographyPlatformApi;
  readonly material: MaterialPlatformApi;
  readonly assetCache: AssetCachePlatformApi;
  readonly aiLog: AILogPlatformApi;
  readonly mcpStdio: McpStdioPlatformApi;
  readonly mcpHttp: McpHttpPlatformApi;
  readonly openAIResponses: OpenAIResponsesPlatformApi;
}
