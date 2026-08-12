import { readFile } from 'node:fs/promises';
import { CliError } from '../protocol';
import { FRONTEND_DEBUG_SESSION_PATH, startFrontendDebugDaemon } from './daemon';
import {
  FRONTEND_DEBUG_CAPABILITIES,
  type FrontendDebugCommand,
  type FrontendDebugPlatform,
  type FrontendDebugSessionDescriptor,
} from './types';

const COMMANDS = new Set<FrontendDebugCommand>([
  'snapshot',
  'query',
  'wait',
  'style',
  'hit-test',
  'tap',
  'type',
  'scroll',
  'drag',
  'pinch',
  'evaluate',
  'console',
  'network',
  'screenshot',
  'bundle',
]);

async function descriptor(): Promise<FrontendDebugSessionDescriptor> {
  try {
    const value = JSON.parse(
      await readFile(FRONTEND_DEBUG_SESSION_PATH, 'utf8'),
    ) as FrontendDebugSessionDescriptor;
    if (value.schemaVersion !== 1 || typeof value.token !== 'string')
      throw new Error('unsupported descriptor');
    return value;
  } catch (error) {
    throw new CliError(
      'FRONTEND_DAEMON_NOT_RUNNING',
      `No usable frontend debug session exists at ${FRONTEND_DEBUG_SESSION_PATH}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function baseUrl(session: FrontendDebugSessionDescriptor): string {
  return `http://${session.host}:${session.port}`;
}

async function daemonRequest(
  session: FrontendDebugSessionDescriptor,
  pathname: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(session)}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(70_000),
    });
  } catch (error) {
    throw new CliError(
      'FRONTEND_DAEMON_UNREACHABLE',
      `Frontend debug daemon PID ${session.pid} is unreachable`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const body = (await response.json()) as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!response.ok)
    throw new CliError(
      body.error?.code ?? 'FRONTEND_DAEMON_FAILED',
      body.error?.message ?? `Frontend debug daemon returned HTTP ${response.status}`,
      body.error?.details,
    );
  return body;
}

async function streamEvents(
  session: FrontendDebugSessionDescriptor,
  channel: 'console' | 'network',
  afterId: number,
): Promise<unknown> {
  const controller = new AbortController();
  const stop = () => controller.abort('stream stopped');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let count = 0;
  try {
    const response = await fetch(
      `${baseUrl(session)}/stream?channel=${channel}&afterId=${afterId}`,
      {
        headers: { Authorization: `Bearer ${session.token}` },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body)
      throw new CliError(
        'FRONTEND_STREAM_FAILED',
        `Frontend stream returned HTTP ${response.status}`,
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          process.stdout.write(`${line}\n`);
          count += 1;
        }
        newline = buffered.indexOf('\n');
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return { channel, streamedEvents: count, stopped: true };
}

function stringValue(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === 'string' && input[key].trim() ? input[key].trim() : undefined;
}

export async function executeFrontendCliCommand(input: {
  action?: string;
  values: Record<string, unknown>;
  requestId: string;
  stream: boolean;
}): Promise<unknown> {
  if (input.action === 'capabilities') {
    return { schemaVersion: 1, source: 'frontend', platforms: FRONTEND_DEBUG_CAPABILITIES };
  }
  if (input.action === 'serve') {
    const platform = stringValue(input.values, 'platform');
    if (platform !== 'android' && platform !== 'ios')
      throw new CliError('INVALID_PLATFORM', '--platform must be android or ios');
    const daemon = await startFrontendDebugDaemon({
      platform: platform as FrontendDebugPlatform,
      ...(stringValue(input.values, 'device')
        ? { deviceId: stringValue(input.values, 'device') }
        : {}),
      ...(Number.isSafeInteger(Number(input.values.port))
        ? { port: Number(input.values.port) }
        : {}),
    });
    const session = daemon.descriptor;
    return {
      schemaVersion: 1,
      source: 'frontend',
      runId: session.runId,
      sessionId: session.sessionId,
      transport: session.transport,
      capabilities: FRONTEND_DEBUG_CAPABILITIES[session.platform],
      result: {
        status: daemon.status(),
        sessionFile: FRONTEND_DEBUG_SESSION_PATH,
        artifactDirectory: session.artifactDirectory,
        rendererEnv: {
          VITE_DRIFTING_FRONTEND_DEBUG: '1',
          VITE_DRIFTING_FRONTEND_DEBUG_TRANSPORT: session.transport,
          ...(session.platform === 'ios'
            ? {
                VITE_DRIFTING_FRONTEND_DEBUG_URL: baseUrl(session),
                VITE_DRIFTING_FRONTEND_DEBUG_TOKEN: session.token,
              }
            : {}),
        },
      },
    };
  }
  const session = await descriptor();
  if (input.action === 'status') return daemonRequest(session, '/status');
  if (!input.action || !COMMANDS.has(input.action as FrontendDebugCommand))
    throw new CliError(
      'UNKNOWN_FRONTEND_COMMAND',
      `Unknown frontend command: ${String(input.action)}`,
    );
  if (input.stream) {
    if (input.action !== 'console' && input.action !== 'network')
      throw new CliError(
        'STREAM_UNSUPPORTED',
        '--stream is only supported by frontend console and frontend network',
      );
    return streamEvents(session, input.action, Number(input.values.afterId) || 0);
  }
  return daemonRequest(session, '/command', {
    method: 'POST',
    body: JSON.stringify({
      command: input.action,
      input: input.values,
      requestId: input.requestId,
    }),
  });
}
