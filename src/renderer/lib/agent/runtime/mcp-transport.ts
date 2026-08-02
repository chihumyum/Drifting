import type { McpHttpPlatformApi, McpStdioPlatformApi } from '../../../platform';

export const DRIFTING_MCP_PROTOCOL_VERSION = '2025-06-18' as const;

const MAX_RPC_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const RESERVED_HTTP_HEADERS = new Set([
  'accept',
  'content-length',
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
]);

export type AgentMcpRequestMethod = 'initialize' | 'ping' | 'tools/list' | 'tools/call';
export type AgentMcpNotificationMethod =
  | 'notifications/initialized'
  | 'notifications/cancelled';

export interface AgentMcpJsonRpcTransport {
  readonly kind: 'stdio' | 'streamable_http';
  connect(signal: AbortSignal): Promise<void>;
  request(input: {
    method: AgentMcpRequestMethod;
    params?: Record<string, unknown>;
    signal: AbortSignal;
    timeoutMs?: number;
  }): Promise<unknown>;
  notify(input: {
    method: AgentMcpNotificationMethod;
    params?: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<void>;
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

export class AgentMcpTransportError extends Error {
  readonly cause: unknown;
  readonly kind:
    | 'aborted'
    | 'configuration'
    | 'http'
    | 'protocol'
    | 'session_expired'
    | 'transport';

  constructor(
    kind: AgentMcpTransportError['kind'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'AgentMcpTransportError';
    this.kind = kind;
    this.cause = options?.cause;
  }
}

export interface StdioAgentMcpTransportOptions {
  platform: McpStdioPlatformApi;
  processId: string;
  command: string;
  args: readonly string[];
  cwd: string | null;
  env: Readonly<Record<string, string>>;
  configRevision: string;
}

export function createStdioAgentMcpTransport(
  options: StdioAgentMcpTransportOptions,
): AgentMcpJsonRpcTransport {
  let started = false;
  let closed = false;
  let connectPromise: Promise<void> | null = null;
  let nextRequestId = 1;

  const connect = (signal: AbortSignal): Promise<void> => {
    assertNotAborted(signal);
    if (closed) return Promise.reject(transportError('MCP stdio transport is closed'));
    if (started) return Promise.resolve();
    if (connectPromise) return raceAbort(connectPromise, signal);
    connectPromise = options.platform
      .start({
        processId: options.processId,
        command: options.command,
        args: [...options.args],
        cwd: options.cwd,
        env: { ...options.env },
        configRevision: options.configRevision,
      })
      .then((result) => {
        if (result.processId !== options.processId || !Number.isSafeInteger(result.pid)) {
          throw protocolError('MCP stdio host returned an invalid start receipt');
        }
        started = true;
      })
      .catch((error) => {
        connectPromise = null;
        throw normalizeTransportFailure(error, 'MCP stdio process could not be started');
      });
    return raceAbort(connectPromise, signal);
  };

  return {
    kind: 'stdio',
    connect,
    async request(input) {
      await connect(input.signal);
      assertNotAborted(input.signal);
      const id = `rpc:${nextRequestId++}`;
      const message = JSON.stringify(jsonRpcRequest(id, input.method, input.params));
      const timeoutMs = normalizeTimeout(input.timeoutMs);
      const pending = options.platform
        .request({
          processId: options.processId,
          requestId: id,
          message,
          timeoutMs,
        })
        .then((text) => parseJsonRpcResponse(text, id));
      try {
        return await raceAbort(pending, input.signal);
      } catch (error) {
        if (input.signal.aborted) {
          void options.platform.notify({
            processId: options.processId,
            message: JSON.stringify(
              jsonRpcNotification('notifications/cancelled', {
                requestId: id,
                reason: 'cancelled by Drifting',
              }),
            ),
          });
        }
        throw normalizeTransportFailure(error, 'MCP stdio request failed');
      }
    },
    async notify(input) {
      await connect(input.signal);
      assertNotAborted(input.signal);
      try {
        await raceAbort(
          options.platform.notify({
            processId: options.processId,
            message: JSON.stringify(jsonRpcNotification(input.method, input.params)),
          }),
          input.signal,
        );
      } catch (error) {
        throw normalizeTransportFailure(error, 'MCP stdio notification failed');
      }
    },
    setProtocolVersion(version) {
      if (version !== DRIFTING_MCP_PROTOCOL_VERSION) {
        throw protocolError(`Unsupported MCP protocol version "${version}"`);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!started && !connectPromise) return;
      try {
        await options.platform.stop(options.processId);
      } finally {
        started = false;
        connectPromise = null;
      }
    },
  };
}

export interface HttpAgentMcpTransportOptions {
  url: string;
  headers?: Readonly<Record<string, string>>;
  /** Product path: native request host avoids WebView CORS/CSP divergence. */
  platform?: McpHttpPlatformApi;
  /** Headless conformance seam. Product code supplies `platform` instead. */
  fetch?: typeof fetch;
}

export function createHttpAgentMcpTransport(
  options: HttpAgentMcpTransportOptions,
): AgentMcpJsonRpcTransport {
  const url = validateHttpEndpoint(options.url);
  const configuredHeaders = validateHttpHeaders(options.headers ?? {});
  const nativePlatform = options.platform;
  const fetchImpl = options.fetch ?? (nativePlatform ? undefined : globalThis.fetch);
  if (!nativePlatform && typeof fetchImpl !== 'function') {
    throw new AgentMcpTransportError('configuration', 'Fetch is unavailable for MCP HTTP');
  }
  let closed = false;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextRequestId = 1;
  const nativeTransportId = nextHttpTransportId++;
  let nextNativeRequestId = 1;

  const post = async (
    message: Record<string, unknown>,
    signal: AbortSignal,
    expectResponse: boolean,
    timeoutMs: number,
  ): Promise<unknown> => {
    if (closed) throw transportError('MCP HTTP transport is closed');
    assertNotAborted(signal);
    const requestSignal = combineTimeoutSignal(signal, timeoutMs);
    let response: Response;
    try {
      const headers = buildHttpHeaders(configuredHeaders, sessionId, protocolVersion);
      const body = JSON.stringify(message);
      if (nativePlatform) {
        const requestId = `mcp-http:${nativeTransportId}:${nextNativeRequestId++}`;
        const cancel = () => {
          void nativePlatform.cancel(requestId).catch(() => undefined);
        };
        requestSignal.signal.addEventListener('abort', cancel, { once: true });
        try {
          const native = await raceAbort(
            nativePlatform.request({
              requestId,
              url,
              method: 'POST',
              headers: Object.fromEntries(headers.entries()),
              body,
              timeoutMs,
            }),
            requestSignal.signal,
          );
          response = new Response(native.body || null, {
            status: native.status,
            headers: native.headers,
          });
        } finally {
          requestSignal.signal.removeEventListener('abort', cancel);
        }
      } else {
        response = await fetchImpl!(url, {
          method: 'POST',
          headers,
          body,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: requestSignal.signal,
        });
      }
    } catch (error) {
      requestSignal.dispose();
      if (signal.aborted || requestSignal.timedOut()) {
        throw abortedError(signal.aborted ? signal.reason : 'MCP HTTP request timed out');
      }
      throw normalizeTransportFailure(error, 'MCP HTTP request failed');
    }
    requestSignal.dispose();

    if (response.status === 404 && sessionId) {
      sessionId = null;
      throw new AgentMcpTransportError(
        'session_expired',
        'MCP HTTP session expired; reconnect before retrying',
      );
    }
    if (!response.ok) {
      throw new AgentMcpTransportError(
        'http',
        `MCP HTTP server returned status ${response.status}`,
      );
    }
    captureSessionId(response.headers);
    if (!expectResponse) {
      if (response.status !== 202 && response.status !== 200 && response.status !== 204) {
        throw protocolError('MCP HTTP notification returned an invalid status');
      }
      return undefined;
    }
    const id = message.id;
    if (typeof id !== 'string') throw protocolError('MCP request id is invalid');
    return parseHttpResponse(response, id);
  };

  const captureSessionId = (headers: Headers): void => {
    const value = headers.get('mcp-session-id');
    if (value == null) return;
    if (!/^[\x21-\x7e]{1,512}$/u.test(value)) {
      throw protocolError('MCP HTTP server returned an invalid session id');
    }
    if (sessionId && sessionId !== value) {
      throw protocolError('MCP HTTP server changed the active session id');
    }
    sessionId = value;
  };

  return {
    kind: 'streamable_http',
    async connect(signal) {
      assertNotAborted(signal);
      if (closed) throw transportError('MCP HTTP transport is closed');
    },
    async request(input) {
      const id = `rpc:${nextRequestId++}`;
      return post(
        jsonRpcRequest(id, input.method, input.params),
        input.signal,
        true,
        normalizeTimeout(input.timeoutMs),
      );
    },
    async notify(input) {
      await post(
        jsonRpcNotification(input.method, input.params),
        input.signal,
        false,
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
    },
    setProtocolVersion(version) {
      if (version !== DRIFTING_MCP_PROTOCOL_VERSION) {
        throw protocolError(`Unsupported MCP protocol version "${version}"`);
      }
      protocolVersion = version;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!sessionId) return;
      const headers = buildHttpHeaders(configuredHeaders, sessionId, protocolVersion);
      sessionId = null;
      try {
        if (nativePlatform) {
          const requestId = `mcp-http:${nativeTransportId}:${nextNativeRequestId++}`;
          await nativePlatform.request({
            requestId,
            url,
            method: 'DELETE',
            headers: Object.fromEntries(headers.entries()),
            body: null,
            timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
          });
        } else {
          await fetchImpl!(url, {
            method: 'DELETE',
            headers,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
          });
        }
      } catch {
        // The local session is closed regardless. Server cleanup is best effort.
      }
    },
  };
}

function jsonRpcRequest(
  id: string,
  method: AgentMcpRequestMethod,
  params?: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

function jsonRpcNotification(
  method: AgentMcpNotificationMethod,
  params?: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
}

function parseJsonRpcResponse(text: string, expectedId: string): unknown {
  if (utf8Length(text) > MAX_RPC_BYTES) {
    throw protocolError('MCP response exceeded the 4 MiB limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw protocolError('MCP response was not valid JSON');
  }
  return parseJsonRpcValue(value, expectedId);
}

function parseJsonRpcValue(value: unknown, expectedId: string): unknown {
  const object = requireRecord(value, 'MCP response');
  if (object.jsonrpc !== '2.0' || object.id !== expectedId) {
    throw protocolError('MCP response envelope or request id did not match');
  }
  const hasResult = hasOwn(object, 'result');
  const hasError = hasOwn(object, 'error');
  if (hasResult === hasError) {
    throw protocolError('MCP response must contain exactly one of result or error');
  }
  if (hasError) {
    const rpcError = requireRecord(object.error, 'MCP JSON-RPC error');
    if (!Number.isInteger(rpcError.code) || typeof rpcError.message !== 'string') {
      throw protocolError('MCP JSON-RPC error was malformed');
    }
    throw new AgentMcpTransportError(
      'protocol',
      `MCP request was rejected (${String(rpcError.code)})`,
    );
  }
  return object.result;
}

async function parseHttpResponse(response: Response, expectedId: string): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RPC_BYTES) {
    throw protocolError('MCP HTTP response exceeded the 4 MiB limit');
  }
  const text = await response.text();
  if (utf8Length(text) > MAX_RPC_BYTES) {
    throw protocolError('MCP HTTP response exceeded the 4 MiB limit');
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    return parseJsonRpcResponse(text, expectedId);
  }
  if (contentType.includes('text/event-stream')) {
    const values = parseSseData(text);
    let result: unknown;
    let matched = 0;
    for (const value of values) {
      const object = requireRecord(value, 'MCP SSE message');
      if (hasOwn(object, 'id')) {
        if (object.id !== expectedId) {
          throw protocolError('MCP SSE stream contained a foreign request id');
        }
        result = parseJsonRpcValue(object, expectedId);
        matched += 1;
      } else if (typeof object.method !== 'string') {
        throw protocolError('MCP SSE stream contained an invalid message');
      }
    }
    if (matched !== 1) {
      throw protocolError('MCP SSE stream did not contain exactly one matching response');
    }
    return result;
  }
  throw protocolError('MCP HTTP response used an unsupported content type');
}

function parseSseData(text: string): unknown[] {
  const messages: unknown[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    try {
      messages.push(JSON.parse(payload));
    } catch {
      throw protocolError('MCP SSE data was not valid JSON');
    }
  };
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /u, ''));
    }
  }
  flush();
  return messages;
}

function buildHttpHeaders(
  configured: Readonly<Record<string, string>>,
  sessionId: string | null,
  protocolVersion: string | null,
): Headers {
  const headers = new Headers(configured);
  headers.set('Accept', 'application/json, text/event-stream');
  headers.set('Content-Type', 'application/json');
  if (sessionId) headers.set('Mcp-Session-Id', sessionId);
  if (protocolVersion) headers.set('MCP-Protocol-Version', protocolVersion);
  return headers;
}

function validateHttpEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentMcpTransportError('configuration', 'MCP HTTP URL is invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new AgentMcpTransportError(
      'configuration',
      'MCP HTTP URL must use HTTPS (or loopback HTTP) and contain no credentials',
    );
  }
  return url.toString();
}

function validateHttpHeaders(value: Readonly<Record<string, string>>): Record<string, string> {
  if (Object.keys(value).length > 64) {
    throw new AgentMcpTransportError('configuration', 'MCP HTTP headers exceed 64 entries');
  }
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,200}$/u.test(lower)) {
      throw new AgentMcpTransportError('configuration', 'MCP HTTP header name is invalid');
    }
    if (RESERVED_HTTP_HEADERS.has(lower)) {
      throw new AgentMcpTransportError(
        'configuration',
        `MCP HTTP header "${name}" is reserved by the transport`,
      );
    }
    if (
      ['host', 'cookie', 'connection', 'origin', 'referer', 'transfer-encoding', 'upgrade'].includes(
        lower,
      ) ||
      lower.startsWith('sec-') ||
      lower.startsWith('proxy-')
    ) {
      throw new AgentMcpTransportError(
        'configuration',
        `MCP HTTP header "${name}" is forbidden by the native transport`,
      );
    }
    if (
      item.length > 8_000 ||
      item.includes('\u0000') ||
      item.includes('\r') ||
      item.includes('\n')
    ) {
      throw new AgentMcpTransportError('configuration', 'MCP HTTP header value is invalid');
    }
    result[name] = item;
  }
  return result;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
    throw new AgentMcpTransportError('configuration', 'MCP request timeout is invalid');
  }
  return timeout;
}

function combineTimeoutSignal(signal: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
  timedOut(): boolean;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
    timedOut: () => timeoutTriggered,
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  assertNotAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortedError(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError(signal.reason);
}

function abortedError(reason: unknown): AgentMcpTransportError {
  return new AgentMcpTransportError('aborted', 'MCP operation was cancelled', {
    cause: reason,
  });
}

function protocolError(message: string): AgentMcpTransportError {
  return new AgentMcpTransportError('protocol', message);
}

function transportError(message: string): AgentMcpTransportError {
  return new AgentMcpTransportError('transport', message);
}

function normalizeTransportFailure(error: unknown, fallback: string): AgentMcpTransportError {
  if (error instanceof AgentMcpTransportError) return error;
  return new AgentMcpTransportError('transport', fallback, { cause: error });
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

let nextHttpTransportId = 1;
