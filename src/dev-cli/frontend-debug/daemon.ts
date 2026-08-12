import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CliError, normalizeCliError } from '../protocol';
import { resolveAndroidEmulator } from './adb';
import { AndroidCdpSession } from './cdp-client';
import { BoundedTelemetryBuffer, redactDebugValue } from './redaction';
import {
  FRONTEND_DEBUG_CAPABILITIES,
  FRONTEND_DEBUG_LIMITS,
  type DebugArtifact,
  type FrontendDebugCommand,
  type FrontendDebugData,
  type FrontendDebugPlatform,
  type FrontendDebugSessionDescriptor,
  type FrontendDebugStatus,
  type RendererCommandRequest,
  type RendererCommandResult,
  type TelemetryEvent,
} from './types';

const execFileAsync = promisify(execFile);
const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPO_ROOT = path.resolve(CORE_ROOT, '..');
export const FRONTEND_DEBUG_ROOT = path.join(CORE_ROOT, '.local-data', 'frontend-debug');
export const FRONTEND_DEBUG_SESSION_PATH = path.join(FRONTEND_DEBUG_ROOT, 'session.json');
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

interface PendingRendererCommand {
  request: RendererCommandRequest;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TranscriptEntry {
  at: string;
  requestId: string;
  command: FrontendDebugCommand;
  input: unknown;
  ok: boolean;
  durationMs: number;
  error?: { code: string; message: string; details?: unknown };
}

function isPrivateIpv4(host: string): boolean {
  const values = host.split('.').map(Number);
  return (
    values.length === 4 &&
    values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) &&
    (values[0] === 10 ||
      (values[0] === 172 && values[1]! >= 16 && values[1]! <= 31) ||
      (values[0] === 192 && values[1] === 168))
  );
}

function rendererOriginAllowed(origin: string): boolean {
  if (origin === 'tauri://localhost') return true;
  try {
    const url = new URL(origin);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        isPrivateIpv4(url.hostname)) &&
      port >= 5173 &&
      port <= 5193
    );
  } catch {
    return false;
  }
}

function setCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!rendererOriginAllowed(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return true;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  response.end(json);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > FRONTEND_DEBUG_LIMITS.requestBytes) {
      throw new CliError('REQUEST_TOO_LARGE', 'Frontend debug request exceeds 1 MiB');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('INVALID_REQUEST', 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function resolveIosSimulator(requested?: string): Promise<string> {
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync(
      'xcrun',
      ['simctl', 'list', 'devices', 'available', '-j'],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    ));
  } catch (error) {
    throw new CliError('SIMCTL_FAILED', error instanceof Error ? error.message : String(error));
  }
  const parsed = JSON.parse(output) as {
    devices?: Record<string, { udid: string; state: string; isAvailable?: boolean }[]>;
  };
  const devices = Object.values(parsed.devices ?? {})
    .flat()
    .filter((device) => device.isAvailable !== false);
  const candidates = requested
    ? devices.filter((device) => device.udid === requested)
    : devices.filter((device) => device.state === 'Booted');
  if (candidates.length === 0)
    throw new CliError(
      'IOS_SIMULATOR_NOT_FOUND',
      requested ? `iOS Simulator ${requested} is unavailable` : 'No booted iOS Simulator was found',
    );
  if (candidates.length > 1)
    throw new CliError(
      'AMBIGUOUS_IOS_SIMULATOR',
      'Multiple booted iOS Simulators were found',
      candidates.map((device) => device.udid),
    );
  return candidates[0]!.udid;
}

async function captureIosScreenshot(deviceId: string, outputPath: string): Promise<void> {
  try {
    await execFileAsync('xcrun', ['simctl', 'io', deviceId, 'screenshot', outputPath], {
      encoding: 'utf8',
      timeout: 20_000,
    });
  } catch (error) {
    throw new CliError(
      'IOS_SCREENSHOT_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function gitEvidence(): Promise<{ sha: string | null; dirty: boolean | null }> {
  try {
    const [{ stdout: sha }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }),
      execFileAsync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' }),
    ]);
    return { sha: sha.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
}

function artifact(kind: DebugArtifact['kind'], filePath: string, mediaType: string): DebugArtifact {
  return { kind, path: filePath, mediaType };
}

class RendererCommandQueue {
  private queued: PendingRendererCommand[] = [];
  private active = new Map<string, PendingRendererCommand>();
  private waitingResponse: ServerResponse | null = null;
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;
  lastSeenAt: number | null = null;
  targetUrl: string | undefined;

  enqueue(command: RendererCommandRequest, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const pending: PendingRendererCommand = {
        request: command,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.queued = this.queued.filter((item) => item !== pending);
          this.active.delete(command.id);
          reject(
            new CliError(
              'RENDERER_COMMAND_TIMEOUT',
              `Renderer did not complete ${command.command} within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.queued.push(pending);
      this.dispatch();
    });
  }

  attachPoll(response: ServerResponse, targetUrl?: string): void {
    this.lastSeenAt = Date.now();
    this.targetUrl = targetUrl ?? this.targetUrl;
    if (this.waitingResponse && !this.waitingResponse.writableEnded) {
      this.waitingResponse.writeHead(204, { 'Cache-Control': 'no-store' });
      this.waitingResponse.end();
    }
    if (this.waitingTimer) clearTimeout(this.waitingTimer);
    this.waitingResponse = response;
    this.waitingTimer = setTimeout(() => {
      if (this.waitingResponse !== response || response.writableEnded) return;
      this.waitingResponse = null;
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
    }, 25_000);
    response.once('close', () => {
      if (this.waitingResponse === response) this.waitingResponse = null;
    });
    this.dispatch();
  }

  complete(result: RendererCommandResult): void {
    const pending = this.active.get(result.id);
    if (!pending)
      throw new CliError('UNKNOWN_RENDERER_REQUEST', `Unknown renderer request: ${result.id}`);
    this.active.delete(result.id);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result.result);
    else
      pending.reject(
        new CliError(
          result.error?.code ?? 'RENDERER_COMMAND_FAILED',
          result.error?.message ?? 'Renderer command failed',
          result.error?.details,
        ),
      );
  }

  close(): void {
    if (this.waitingTimer) clearTimeout(this.waitingTimer);
    if (this.waitingResponse && !this.waitingResponse.writableEnded) {
      this.waitingResponse.writeHead(204);
      this.waitingResponse.end();
    }
    for (const pending of [...this.queued, ...this.active.values()]) {
      clearTimeout(pending.timer);
      pending.reject(new CliError('DAEMON_STOPPED', 'Frontend debug daemon stopped'));
    }
    this.queued = [];
    this.active.clear();
  }

  private dispatch(): void {
    const response = this.waitingResponse;
    const pending = this.queued.shift();
    if (!response || response.writableEnded || !pending) {
      if (pending) this.queued.unshift(pending);
      return;
    }
    this.waitingResponse = null;
    if (this.waitingTimer) clearTimeout(this.waitingTimer);
    this.waitingTimer = null;
    this.active.set(pending.request.id, pending);
    sendJson(response, 200, pending.request);
  }
}

export interface FrontendDebugDaemon {
  descriptor: FrontendDebugSessionDescriptor;
  status(): FrontendDebugStatus;
  close(): Promise<void>;
}

export interface FrontendDebugDaemonPlatformAdapters {
  resolveAndroidEmulator?: (requested?: string) => Promise<string>;
  resolveIosSimulator?: (requested?: string) => Promise<string>;
  captureIosScreenshot?: (deviceId: string, outputPath: string) => Promise<void>;
}

export async function startFrontendDebugDaemon(
  input: {
    platform: FrontendDebugPlatform;
    deviceId?: string;
    port?: number;
  },
  adapters: FrontendDebugDaemonPlatformAdapters = {},
): Promise<FrontendDebugDaemon> {
  const host = '127.0.0.1' as const;
  const port = input.port ?? 4318;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new CliError('INVALID_PORT', '--port must be between 1 and 65535');
  const deviceId =
    input.platform === 'android'
      ? await (adapters.resolveAndroidEmulator ?? resolveAndroidEmulator)(input.deviceId)
      : await (adapters.resolveIosSimulator ?? resolveIosSimulator)(input.deviceId);
  const sessionId = `frontend-${randomUUID()}`;
  const runId = `run-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const token = randomBytes(32).toString('base64url');
  const artifactDirectory = path.join(FRONTEND_DEBUG_ROOT, runId);
  await mkdir(artifactDirectory, { recursive: true });
  const descriptor: FrontendDebugSessionDescriptor = {
    schemaVersion: 1,
    sessionId,
    runId,
    pid: process.pid,
    host,
    port,
    token,
    platform: input.platform,
    deviceId,
    transport: input.platform === 'android' ? 'android-cdp' : 'ios-renderer-bridge',
    startedAt: new Date().toISOString(),
    artifactDirectory,
  };
  const android = input.platform === 'android' ? new AndroidCdpSession(deviceId) : null;
  const renderer = new RendererCommandQueue();
  const consoleEvents = new BoundedTelemetryBuffer();
  const networkEvents = new BoundedTelemetryBuffer();
  const transcript: TranscriptEntry[] = [];
  let commandTail = Promise.resolve();
  let closed = false;

  const status = (): FrontendDebugStatus => {
    const androidStatus = android?.status();
    const rendererConnected =
      renderer.lastSeenAt !== null && Date.now() - renderer.lastSeenAt < 35_000;
    return {
      platform: input.platform,
      deviceId,
      connected:
        input.platform === 'android' ? androidStatus?.connected === true : rendererConnected,
      rendererConnected,
      ...(input.platform === 'android' ? androidStatus : {}),
      ...(input.platform === 'ios' && renderer.targetUrl ? { targetUrl: renderer.targetUrl } : {}),
      ...(input.platform === 'ios' && renderer.lastSeenAt
        ? { lastConnectedAt: new Date(renderer.lastSeenAt).toISOString() }
        : {}),
    };
  };

  const data = <T>(result: T, artifacts?: DebugArtifact[]): FrontendDebugData<T> => ({
    schemaVersion: 1,
    source: 'frontend',
    runId,
    sessionId,
    transport: descriptor.transport,
    capabilities: FRONTEND_DEBUG_CAPABILITIES[input.platform],
    result,
    ...(artifacts?.length ? { artifacts } : {}),
  });

  const screenshot = async (): Promise<FrontendDebugData<unknown>> => {
    const stamp = Date.now();
    const artifacts: DebugArtifact[] = [];
    if (android) {
      const webviewPath = path.join(artifactDirectory, `webview-${stamp}.png`);
      const devicePath = path.join(artifactDirectory, `device-${stamp}.png`);
      await android.captureScreenshots(webviewPath, devicePath);
      artifacts.push(
        artifact('screenshot', webviewPath, 'image/png'),
        artifact('screenshot', devicePath, 'image/png'),
      );
    } else {
      const devicePath = path.join(artifactDirectory, `simulator-${stamp}.png`);
      await (adapters.captureIosScreenshot ?? captureIosScreenshot)(deviceId, devicePath);
      artifacts.push(artifact('screenshot', devicePath, 'image/png'));
    }
    return data({ capturedAt: new Date().toISOString() }, artifacts);
  };

  const eventList = (channel: 'console' | 'network', afterId = 0) => {
    if (android)
      return channel === 'console'
        ? android.consoleEvents.list(afterId)
        : android.networkEvents.list(afterId);
    return channel === 'console' ? consoleEvents.list(afterId) : networkEvents.list(afterId);
  };

  const bundle = async (): Promise<FrontendDebugData<unknown>> => {
    const artifacts: DebugArtifact[] = [];
    const consolePath = path.join(artifactDirectory, 'console.json');
    const networkPath = path.join(artifactDirectory, 'network.json');
    const transcriptPath = path.join(artifactDirectory, 'transcript.json');
    await Promise.all([
      writeFile(consolePath, `${JSON.stringify(eventList('console'), null, 2)}\n`),
      writeFile(networkPath, `${JSON.stringify(eventList('network'), null, 2)}\n`),
      writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`),
    ]);
    artifacts.push(
      artifact('console', consolePath, 'application/json'),
      artifact('network', networkPath, 'application/json'),
      artifact('transcript', transcriptPath, 'application/json'),
    );
    try {
      const captured = await screenshot();
      artifacts.push(...(captured.artifacts ?? []));
    } catch (error) {
      transcript.push({
        at: new Date().toISOString(),
        requestId: 'bundle-screenshot',
        command: 'screenshot',
        input: {},
        ok: false,
        durationMs: 0,
        error: normalizeCliError(error),
      });
    }
    const manifestPath = path.join(artifactDirectory, 'manifest.json');
    const manifest = {
      schemaVersion: 1,
      runId,
      sessionId,
      capturedAt: new Date().toISOString(),
      checkout: await gitEvidence(),
      descriptor: { ...descriptor, token: '[REDACTED]' },
      status: status(),
      capabilities: FRONTEND_DEBUG_CAPABILITIES[input.platform],
      truncation: {
        console: eventList('console').truncated,
        network: eventList('network').truncated,
      },
      artifacts,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    artifacts.unshift(artifact('manifest', manifestPath, 'application/json'));
    return data({ artifactDirectory, manifest: manifestPath }, artifacts);
  };

  const execute = async (
    command: FrontendDebugCommand,
    commandInput: Record<string, unknown>,
    requestId: string,
  ): Promise<FrontendDebugData> => {
    const startedAt = Date.now();
    try {
      let result: FrontendDebugData;
      if (command === 'screenshot') result = await screenshot();
      else if (command === 'bundle') result = await bundle();
      else if (command === 'console' || command === 'network') {
        result = data(eventList(command, Number(commandInput.afterId) || 0));
      } else if (android) {
        result = data(await android.execute(command, commandInput));
      } else {
        const timeoutMs =
          command === 'wait'
            ? Math.min(
                65_000,
                Math.max(
                  FRONTEND_DEBUG_LIMITS.commandTimeoutMs,
                  Number(commandInput.timeoutMs) + 5_000 || 0,
                ),
              )
            : FRONTEND_DEBUG_LIMITS.commandTimeoutMs;
        const resultValue = await renderer.enqueue(
          { id: `renderer-${randomUUID()}`, command, input: commandInput },
          timeoutMs,
        );
        result = data(resultValue);
      }
      transcript.push({
        at: new Date().toISOString(),
        requestId,
        command,
        input: redactDebugValue(commandInput),
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      transcript.push({
        at: new Date().toISOString(),
        requestId,
        command,
        input: redactDebugValue(commandInput),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: normalizeCliError(error),
      });
      throw error;
    }
  };

  const server = createServer(async (request, response) => {
    if (!setCors(request, response)) {
      sendJson(response, 403, {
        error: { code: 'ORIGIN_DENIED', message: 'Renderer origin is not allowed' },
      });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, {
        error: { code: 'UNAUTHORIZED', message: 'Invalid frontend debug token' },
      });
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    try {
      if (request.method === 'GET' && url.pathname === '/status') {
        sendJson(response, 200, data(status()));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/renderer/next') {
        if (input.platform !== 'ios')
          throw new CliError(
            'RENDERER_BRIDGE_DISABLED',
            'Renderer bridge is only enabled for iOS Simulator',
          );
        const body = await readJson(request);
        renderer.attachPoll(response, typeof body.url === 'string' ? body.url : undefined);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/renderer/result') {
        renderer.complete((await readJson(request)) as unknown as RendererCommandResult);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/renderer/telemetry') {
        if (input.platform !== 'ios')
          throw new CliError(
            'RENDERER_BRIDGE_DISABLED',
            'Renderer telemetry is only enabled for iOS Simulator',
          );
        const body = await readJson(request);
        const events = Array.isArray(body.events) ? body.events.slice(0, 128) : [];
        for (const event of events) {
          if (!event || typeof event !== 'object') continue;
          const value = event as Partial<TelemetryEvent>;
          const channel = value.channel === 'network' ? 'network' : 'console';
          const target = channel === 'network' ? networkEvents : consoleEvents;
          target.push({
            at: typeof value.at === 'string' ? value.at : new Date().toISOString(),
            channel,
            ...(typeof value.level === 'string' ? { level: value.level } : {}),
            value: value.value,
          });
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/stream') {
        const channel = url.searchParams.get('channel');
        if (channel !== 'console' && channel !== 'network')
          throw new CliError('INVALID_CHANNEL', 'channel must be console or network');
        let afterId = Number(url.searchParams.get('afterId')) || 0;
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders?.();
        const flush = () => {
          const list = eventList(channel, afterId);
          for (const event of list.events) {
            response.write(`${JSON.stringify(event)}\n`);
            afterId = Math.max(afterId, event.id);
          }
        };
        flush();
        const timer = setInterval(flush, 250);
        request.once('close', () => clearInterval(timer));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/command') {
        const body = await readJson(request);
        const command = body.command;
        if (typeof command !== 'string' || !COMMANDS.has(command as FrontendDebugCommand))
          throw new CliError(
            'UNKNOWN_FRONTEND_COMMAND',
            `Unknown frontend command: ${String(command)}`,
          );
        const commandInput =
          body.input && typeof body.input === 'object' && !Array.isArray(body.input)
            ? (body.input as Record<string, unknown>)
            : {};
        const requestId =
          typeof body.requestId === 'string' ? body.requestId : `frontend-${randomUUID()}`;
        const outcome = await new Promise<FrontendDebugData>((resolve, reject) => {
          commandTail = commandTail.then(() =>
            execute(command as FrontendDebugCommand, commandInput, requestId).then(resolve, reject),
          );
        });
        sendJson(response, 200, outcome);
        return;
      }
      sendJson(response, 404, {
        error: { code: 'NOT_FOUND', message: 'Unknown frontend debug endpoint' },
      });
    } catch (error) {
      sendJson(response, 400, { error: normalizeCliError(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  await mkdir(FRONTEND_DEBUG_ROOT, { recursive: true });
  await writeFile(FRONTEND_DEBUG_SESSION_PATH, `${JSON.stringify(descriptor, null, 2)}\n`, {
    mode: 0o600,
  });

  const close = async () => {
    if (closed) return;
    closed = true;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    renderer.close();
    await android?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const current = JSON.parse(
        await readFile(FRONTEND_DEBUG_SESSION_PATH, 'utf8'),
      ) as FrontendDebugSessionDescriptor;
      if (current.sessionId === sessionId) await rm(FRONTEND_DEBUG_SESSION_PATH, { force: true });
    } catch {
      // A newer daemon may have replaced the descriptor.
    }
  };
  const onSignal = () => void close().finally(() => process.exit(0));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { descriptor, status, close };
}
