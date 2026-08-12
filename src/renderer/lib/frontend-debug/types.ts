export type RendererDebugCommand =
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
  | 'network';

export type RendererDebugLocator =
  | { kind: 'css'; value: string }
  | { kind: 'debug-id'; value: string }
  | { kind: 'role'; role: string; name?: string; exact?: boolean }
  | { kind: 'text'; value: string; exact?: boolean };

export interface RendererDebugRequest {
  id: string;
  command: RendererDebugCommand;
  input: Record<string, unknown>;
}

export interface RendererDebugResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface FrontendDebugRegistryApi {
  readonly version: 1;
  snapshot(): unknown;
}

declare global {
  interface Window {
    __DRIFTING_FRONTEND_DEBUG_V1__?: FrontendDebugRegistryApi;
  }
}
