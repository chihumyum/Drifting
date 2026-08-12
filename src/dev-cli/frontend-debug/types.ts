export type FrontendDebugPlatform = 'android' | 'ios';
export type FrontendDebugTransport = 'android-cdp' | 'ios-renderer-bridge';
export type FrontendDebugCommand =
  | 'snapshot'
  | 'query'
  | 'wait'
  | 'style'
  | 'hit-test'
  | 'tap'
  | 'type'
  | 'scroll'
  | 'drag'
  | 'pinch'
  | 'evaluate'
  | 'console'
  | 'network'
  | 'screenshot'
  | 'bundle';

export type DebugLocator =
  | { kind: 'css'; value: string }
  | { kind: 'debug-id'; value: string }
  | { kind: 'role'; role: string; name?: string; exact?: boolean }
  | { kind: 'text'; value: string; exact?: boolean };

export interface DebugArtifact {
  kind: 'manifest' | 'screenshot' | 'console' | 'network' | 'transcript';
  path: string;
  mediaType: string;
}

export interface FrontendDebugCapabilities {
  dom: true;
  runtime: true;
  console: true;
  network: 'full' | 'resource-summary';
  screenshot: 'webview+device' | 'device';
  inputPath: 'cdp-webview' | 'synthetic-dom';
  nativeInput: false;
}

export interface FrontendDebugData<T = unknown> {
  schemaVersion: 1;
  source: 'frontend';
  runId: string;
  sessionId: string;
  transport: FrontendDebugTransport;
  capabilities: FrontendDebugCapabilities;
  result: T;
  artifacts?: DebugArtifact[];
}

export interface FrontendDebugSessionDescriptor {
  schemaVersion: 1;
  sessionId: string;
  runId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  token: string;
  platform: FrontendDebugPlatform;
  deviceId: string;
  transport: FrontendDebugTransport;
  startedAt: string;
  artifactDirectory: string;
}

export interface FrontendDebugStatus {
  platform: FrontendDebugPlatform;
  deviceId: string;
  connected: boolean;
  rendererConnected: boolean;
  targetUrl?: string;
  appPid?: string;
  lastConnectedAt?: string;
}

export interface RendererCommandRequest {
  id: string;
  command: Exclude<FrontendDebugCommand, 'screenshot' | 'bundle'>;
  input: Record<string, unknown>;
}

export interface RendererCommandResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface TelemetryEvent {
  id: number;
  at: string;
  channel: 'console' | 'network';
  level?: string;
  value: unknown;
  truncated?: boolean;
}

export const FRONTEND_DEBUG_CAPABILITIES: Record<FrontendDebugPlatform, FrontendDebugCapabilities> =
  {
    android: {
      dom: true,
      runtime: true,
      console: true,
      network: 'full',
      screenshot: 'webview+device',
      inputPath: 'cdp-webview',
      nativeInput: false,
    },
    ios: {
      dom: true,
      runtime: true,
      console: true,
      network: 'resource-summary',
      screenshot: 'device',
      inputPath: 'synthetic-dom',
      nativeInput: false,
    },
  };

export const FRONTEND_DEBUG_LIMITS = {
  requestBytes: 1_048_576,
  textChars: 8_192,
  elementTextChars: 200,
  queryElements: 500,
  events: 2_000,
  channelBytes: 5 * 1_048_576,
  commandTimeoutMs: 30_000,
  waitTimeoutMs: 15_000,
} as const;
