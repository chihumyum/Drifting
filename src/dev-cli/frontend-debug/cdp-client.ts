import { writeFile } from 'node:fs/promises';
import CDP from 'chrome-remote-interface';
import { CliError } from '../protocol';
import {
  captureAndroidDeviceScreenshot,
  discoverAndroidWebView,
  removeAndroidForward,
} from './adb';
import { buildDomExpression, requireLocator } from './dom-expression';
import { BoundedTelemetryBuffer } from './redaction';
import type { FrontendDebugCommand, TelemetryEvent } from './types';

interface CdpDomain {
  enable?: () => Promise<unknown>;
  evaluate?: (
    input: Record<string, unknown>,
  ) => Promise<{ result?: { value?: unknown; description?: string }; exceptionDetails?: unknown }>;
  dispatchTouchEvent?: (input: Record<string, unknown>) => Promise<unknown>;
  dispatchMouseEvent?: (input: Record<string, unknown>) => Promise<unknown>;
  insertText?: (input: { text: string }) => Promise<unknown>;
  captureScreenshot?: (input: Record<string, unknown>) => Promise<{ data: string }>;
  consoleAPICalled?: (handler: (event: unknown) => void) => void;
  exceptionThrown?: (handler: (event: unknown) => void) => void;
  entryAdded?: (handler: (event: unknown) => void) => void;
  requestWillBeSent?: (handler: (event: unknown) => void) => void;
  responseReceived?: (handler: (event: unknown) => void) => void;
}

interface CdpConnection {
  Runtime: CdpDomain;
  DOM: CdpDomain;
  CSS: CdpDomain;
  Log: CdpDomain;
  Network: CdpDomain;
  Page: CdpDomain;
  Input: CdpDomain;
  close: () => Promise<void>;
  on: (event: string, handler: () => void) => void;
}

interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

function numeric(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AndroidCdpSession {
  private client: CdpConnection | null = null;
  private forwardedPort: number | null = null;
  private pid: string | undefined;
  private targetUrl: string | undefined;
  private lastConnectedAt: string | undefined;
  private connecting: Promise<CdpConnection> | null = null;
  readonly consoleEvents = new BoundedTelemetryBuffer();
  readonly networkEvents = new BoundedTelemetryBuffer();

  constructor(readonly deviceId: string) {}

  status() {
    return {
      connected: this.client !== null,
      rendererConnected: false,
      ...(this.pid ? { appPid: this.pid } : {}),
      ...(this.targetUrl ? { targetUrl: this.targetUrl } : {}),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => undefined);
    if (this.forwardedPort) {
      await removeAndroidForward(this.deviceId, this.forwardedPort);
      this.forwardedPort = null;
    }
  }

  async execute(command: FrontendDebugCommand, input: Record<string, unknown>): Promise<unknown> {
    if (command === 'console') return this.consoleEvents.list(numeric(input, 'afterId', 0));
    if (command === 'network') return this.networkEvents.list(numeric(input, 'afterId', 0));
    if (command === 'screenshot' || command === 'bundle') {
      throw new CliError('INTERNAL_COMMAND_ROUTING', `${command} must be handled by the daemon`);
    }
    if (command === 'wait') return this.waitFor(input);
    const client = await this.ensureConnected();
    if (command === 'evaluate') {
      if (typeof input.expression !== 'string' || !input.expression.trim()) {
        throw new CliError('INVALID_ARGUMENT', 'input.expression is required');
      }
      return this.evaluate(client, input.expression);
    }
    if (['snapshot', 'query', 'style', 'hit-test'].includes(command)) {
      if (command !== 'snapshot' && command !== 'hit-test') requireLocator(input);
      return this.evaluate(
        client,
        buildDomExpression(command as 'snapshot' | 'query' | 'style' | 'hit-test', input),
      );
    }
    if (command === 'type') {
      const point = await this.resolvePoint(client, input);
      await this.touch(client, 'touchStart', [point]);
      await this.touch(client, 'touchEnd', []);
      if (input.replace !== false) {
        await this.evaluate(
          client,
          `(() => { const element = document.elementFromPoint(${point.x}, ${point.y}); if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) { element.select(); } else if (element instanceof HTMLElement && element.isContentEditable) { const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range); } return true; })()`,
        );
      }
      await client.Input.insertText?.({ text: String(input.text ?? '') });
      return { inputPath: 'cdp-webview', point };
    }
    if (command === 'scroll') {
      const point = await this.resolvePoint(client, input, true);
      await client.Input.dispatchMouseEvent?.({
        type: 'mouseWheel',
        x: point.x,
        y: point.y,
        deltaX: numeric(input, 'deltaX', 0),
        deltaY: numeric(input, 'deltaY', 0),
      });
      return { inputPath: 'cdp-webview', point };
    }
    if (command === 'tap') {
      const point = await this.resolvePoint(client, input, true);
      await this.touch(client, 'touchStart', [point]);
      await this.touch(client, 'touchEnd', []);
      return { inputPath: 'cdp-webview', point };
    }
    if (command === 'drag') {
      const from = await this.resolvePoint(client, input, true);
      const to = {
        x: numeric(input, 'toX', from.x + numeric(input, 'deltaX', 0)),
        y: numeric(input, 'toY', from.y + numeric(input, 'deltaY', 0)),
      };
      await this.touch(client, 'touchStart', [from]);
      for (let step = 1; step <= 8; step += 1) {
        await this.touch(client, 'touchMove', [
          { x: from.x + ((to.x - from.x) * step) / 8, y: from.y + ((to.y - from.y) * step) / 8 },
        ]);
        await delay(16);
      }
      await this.touch(client, 'touchEnd', []);
      return { inputPath: 'cdp-webview', from, to };
    }
    if (command === 'pinch') {
      const center = await this.resolvePoint(client, input, true);
      const start = numeric(input, 'startDistance', 180);
      const end = numeric(input, 'endDistance', 80);
      const points = (distance: number) => [
        { x: center.x - distance / 2, y: center.y },
        { x: center.x + distance / 2, y: center.y },
      ];
      await this.touch(client, 'touchStart', points(start));
      for (let step = 1; step <= 10; step += 1) {
        await this.touch(client, 'touchMove', points(start + ((end - start) * step) / 10));
        await delay(16);
      }
      await this.touch(client, 'touchEnd', []);
      return { inputPath: 'cdp-webview', center, startDistance: start, endDistance: end };
    }
    throw new CliError('UNKNOWN_FRONTEND_COMMAND', `Unsupported CDP command: ${command}`);
  }

  async captureScreenshots(webviewPath: string, devicePath: string): Promise<void> {
    const client = await this.ensureConnected();
    const screenshot = await client.Page.captureScreenshot?.({ format: 'png', fromSurface: true });
    if (!screenshot?.data)
      throw new CliError('CDP_SCREENSHOT_FAILED', 'CDP did not return image data');
    await writeFile(webviewPath, Buffer.from(screenshot.data, 'base64'));
    await captureAndroidDeviceScreenshot(this.deviceId, devicePath);
  }

  private async ensureConnected(): Promise<CdpConnection> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<CdpConnection> {
    await this.close();
    const discovery = await discoverAndroidWebView(this.deviceId);
    this.forwardedPort = discovery.port;
    this.pid = discovery.pid;
    const response = await fetch(`http://127.0.0.1:${discovery.port}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new CliError(
        'CDP_DISCOVERY_FAILED',
        `CDP target list returned HTTP ${response.status}`,
      );
    const targets = (await response.json()) as CdpTarget[];
    const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (pages.length !== 1) {
      throw new CliError(
        'AMBIGUOUS_CDP_TARGET',
        `Expected one Drifting WebView page, found ${pages.length}`,
        pages.map(({ id, title, url }) => ({ id, title, url })),
      );
    }
    const target = pages[0]!;
    const client = (await CDP({
      target: target.webSocketDebuggerUrl,
      local: true,
    })) as unknown as CdpConnection;
    this.client = client;
    this.targetUrl = target.url;
    this.lastConnectedAt = new Date().toISOString();
    client.on('disconnect', () => {
      if (this.client === client) this.client = null;
    });
    await Promise.all([
      client.Runtime.enable?.(),
      client.DOM.enable?.(),
      client.CSS.enable?.(),
      client.Log.enable?.(),
      client.Network.enable?.(),
      client.Page.enable?.(),
    ]);
    client.Runtime.consoleAPICalled?.((event) =>
      this.consoleEvents.push({ at: new Date().toISOString(), channel: 'console', value: event }),
    );
    client.Runtime.exceptionThrown?.((event) =>
      this.consoleEvents.push({
        at: new Date().toISOString(),
        channel: 'console',
        level: 'error',
        value: event,
      }),
    );
    client.Log.entryAdded?.((event) =>
      this.consoleEvents.push({ at: new Date().toISOString(), channel: 'console', value: event }),
    );
    client.Network.requestWillBeSent?.((event) =>
      this.networkEvents.push({ at: new Date().toISOString(), channel: 'network', value: event }),
    );
    client.Network.responseReceived?.((event) =>
      this.networkEvents.push({ at: new Date().toISOString(), channel: 'network', value: event }),
    );
    return client;
  }

  private async evaluate(client: CdpConnection, expression: string): Promise<unknown> {
    const response = await client.Runtime.evaluate?.({
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response?.exceptionDetails)
      throw new CliError(
        'CDP_EVALUATION_FAILED',
        response.result?.description ?? 'Renderer evaluation failed',
        response.exceptionDetails,
      );
    return response?.result?.value;
  }

  private async resolvePoint(
    client: CdpConnection,
    input: Record<string, unknown>,
    allowCoordinates = false,
  ): Promise<{ x: number; y: number }> {
    if (allowCoordinates && Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y))) {
      return { x: Number(input.x), y: Number(input.y) };
    }
    requireLocator(input);
    const resolved = await this.evaluate(client, buildDomExpression('resolve-point', input));
    if (!resolved || typeof resolved !== 'object')
      throw new CliError('ELEMENT_NOT_FOUND', 'The locator did not match an element');
    const point = resolved as { x?: unknown; y?: unknown };
    return { x: Number(point.x), y: Number(point.y) };
  }

  private async touch(
    client: CdpConnection,
    type: string,
    points: { x: number; y: number }[],
  ): Promise<void> {
    await client.Input.dispatchTouchEvent?.({
      type,
      touchPoints: points.map((point, index) => ({
        ...point,
        id: index + 1,
        radiusX: 1,
        radiusY: 1,
        force: type === 'touchEnd' ? 0 : 1,
      })),
    });
  }

  private async waitFor(input: Record<string, unknown>): Promise<unknown> {
    requireLocator(input);
    const timeoutMs = Math.min(60_000, Math.max(50, numeric(input, 'timeoutMs', 15_000)));
    const state = typeof input.state === 'string' ? input.state : 'visible';
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const result = (await this.execute('query', { ...input, limit: 1 })) as {
        count?: number;
        elements?: { visible?: boolean }[];
      };
      const exists = Boolean(result.count);
      const visible = result.elements?.[0]?.visible === true;
      if (
        (state === 'attached' && exists) ||
        (state === 'visible' && visible) ||
        (state === 'hidden' && !visible)
      )
        return { state, elapsedMs: Date.now() - started, match: result.elements?.[0] ?? null };
      await delay(50);
    }
    throw new CliError('WAIT_TIMEOUT', `Timed out waiting for locator to become ${state}`);
  }
}

export function telemetryList(
  buffer: BoundedTelemetryBuffer,
  afterId: number,
): { events: TelemetryEvent[]; truncated: boolean } {
  return buffer.list(afterId);
}
