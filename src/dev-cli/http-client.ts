import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CliError } from './protocol';

function checkedUrl(base: string, path: string, loopbackOnly = false): URL {
  const baseUrl = new URL(base);
  if (!['http:', 'https:'].includes(baseUrl.protocol))
    throw new CliError('URL_REFUSED', 'Only HTTP(S) URLs are supported');
  if (
    loopbackOnly &&
    (baseUrl.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname))
  ) {
    throw new CliError('BRIDGE_URL_REFUSED', 'The renderer debug bridge must use loopback HTTP');
  }
  return new URL(path, baseUrl);
}

async function cookieHeader(cookieFile?: string): Promise<string | undefined> {
  if (!cookieFile) return undefined;
  const text = (await readFile(resolve(cookieFile), 'utf8')).trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { cookie?: unknown }).cookie === 'string'
    ) {
      return (parsed as { cookie: string }).cookie;
    }
  } catch {
    return text;
  }
  throw new CliError(
    'COOKIE_FILE_INVALID',
    'Cookie file must contain a Cookie header string or {"cookie":"..."}',
  );
}

async function responsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return response.json();
  const text = await response.text();
  return text || null;
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const sensitive = /^(?:set-cookie|authorization|proxy-authenticate)$/iu;
  return Object.fromEntries([...headers.entries()].filter(([name]) => !sensitive.test(name)));
}

export async function serverRequest(input: {
  baseUrl: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  cookieFile?: string;
  requestId: string;
}): Promise<unknown> {
  const url = checkedUrl(input.baseUrl, input.path);
  const cookie = await cookieHeader(input.cookieFile);
  const response = await fetch(url, {
    method: input.method,
    headers: {
      Accept: 'application/json',
      'X-Request-Id': input.requestId,
      ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });
  const payload = await responsePayload(response);
  if (!response.ok)
    throw new CliError(
      'SERVER_HTTP_ERROR',
      `${input.method} ${url.pathname} returned HTTP ${response.status}`,
      payload,
    );
  return {
    status: response.status,
    headers: safeResponseHeaders(response.headers),
    body: payload,
  };
}

export async function bridgeRequest(input: {
  bridgeUrl: string;
  endpoint: '/turn' | '/review';
  body: Record<string, unknown>;
}): Promise<unknown> {
  const url = checkedUrl(input.bridgeUrl, input.endpoint, true);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
    body: JSON.stringify(input.body),
  });
  if (!response.ok || !response.body) {
    throw new CliError(
      'BRIDGE_HTTP_ERROR',
      `Agent bridge returned HTTP ${response.status}`,
      await responsePayload(response),
    );
  }
  const events: unknown[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let terminal: Record<string, unknown> | null = null;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        const event = JSON.parse(line) as unknown;
        events.push(event);
        if (event && typeof event === 'object') {
          const type = (event as { type?: unknown }).type;
          if (type === 'bridge_completed' || type === 'bridge_failed')
            terminal = event as Record<string, unknown>;
        }
      }
      newline = buffered.indexOf('\n');
    }
  }
  if (!terminal)
    throw new CliError('BRIDGE_INCOMPLETE', 'Agent bridge closed without a terminal event', events);
  if (terminal.type === 'bridge_failed')
    throw new CliError('BRIDGE_FAILED', String(terminal.error ?? 'Agent bridge failed'), terminal);
  return { terminal, events };
}
