import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeFrontendCliCommand, frontendDebugRendererEnv } from './client';
import { FRONTEND_DEBUG_SESSION_PATH, startFrontendDebugDaemon, type FrontendDebugDaemon } from './daemon';

let daemon: FrontendDebugDaemon | null = null;
let root: string | null = null;

// Each test keeps its descriptor and evidence in its own directory, so a test
// run never replaces or deletes the session of a daemon an author has running.
async function testRoot(): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), 'drifting-frontend-debug-'));
  return root;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('frontend debug daemon and renderer bridge', () => {
  afterEach(async () => {
    if (daemon) await daemon.close();
    daemon = null;
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it('authenticates, brokers a renderer command, and redacts telemetry end to end', async () => {
    daemon = await startFrontendDebugDaemon(
      { platform: 'ios', deviceId: 'SIMULATOR-QA', port: await freePort(), root: await testRoot() },
      { resolveIosSimulator: async () => 'SIMULATOR-QA' },
    );
    const { host, port, token } = daemon.descriptor;
    const root = `http://${host}:${port}`;

    expect((await fetch(`${root}/status`)).status).toBe(401);
    expect((await fetch(`${root}/status`, { headers: headers(token) })).status).toBe(200);

    const poll = fetch(`${root}/renderer/next`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ url: 'tauri://localhost/#/project/qa' }),
    });
    const command = fetch(`${root}/command`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ command: 'snapshot', input: {}, requestId: 'qa-request' }),
    });
    const rendererRequest = (await (await poll).json()) as { id: string; command: string };
    expect(rendererRequest.command).toBe('snapshot');
    expect(
      (
        await fetch(`${root}/renderer/result`, {
          method: 'POST',
          headers: headers(token),
          body: JSON.stringify({
            id: rendererRequest.id,
            ok: true,
            result: { readyState: 'complete' },
          }),
        })
      ).status,
    ).toBe(200);
    await expect((await command).json()).resolves.toMatchObject({
      source: 'frontend',
      transport: 'ios-renderer-bridge',
      result: { readyState: 'complete' },
    });

    await fetch(`${root}/renderer/telemetry`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        events: [
          {
            at: '2026-08-13T00:00:00.000Z',
            channel: 'console',
            level: 'error',
            value: { message: 'qa', Authorization: 'Bearer must-not-leak' },
          },
        ],
      }),
    });
    const consoleResult = await fetch(`${root}/command`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ command: 'console', input: {}, requestId: 'qa-console' }),
    });
    await expect(consoleResult.json()).resolves.toMatchObject({
      result: {
        events: [{ value: { message: 'qa', Authorization: '[REDACTED]' } }],
        truncated: false,
      },
    });
  });

  it('serializes interactive commands and streams telemetry as NDJSON', async () => {
    daemon = await startFrontendDebugDaemon(
      { platform: 'ios', deviceId: 'SIMULATOR-QA', port: await freePort(), root: await testRoot() },
      { resolveIosSimulator: async () => 'SIMULATOR-QA' },
    );
    const { host, port, token } = daemon.descriptor;
    const root = `http://${host}:${port}`;

    const firstCommand = fetch(`${root}/command`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ command: 'query', input: {}, requestId: 'serial-1' }),
    });
    const firstPoll = await fetch(`${root}/renderer/next`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ url: 'tauri://localhost' }),
    });
    const firstRequest = (await firstPoll.json()) as { id: string; command: string };
    expect(firstRequest.command).toBe('query');

    const secondCommand = fetch(`${root}/command`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ command: 'tap', input: {}, requestId: 'serial-2' }),
    });
    let secondPollResolved = false;
    const secondPollPromise = fetch(`${root}/renderer/next`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ url: 'tauri://localhost' }),
    }).then((response) => {
      secondPollResolved = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondPollResolved).toBe(false);

    await fetch(`${root}/renderer/result`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ id: firstRequest.id, ok: true, result: { count: 1 } }),
    });
    await expect((await firstCommand).json()).resolves.toMatchObject({ result: { count: 1 } });

    const secondPoll = await secondPollPromise;
    const secondRequest = (await secondPoll.json()) as { id: string; command: string };
    expect(secondRequest.command).toBe('tap');
    await fetch(`${root}/renderer/result`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        id: secondRequest.id,
        ok: true,
        result: { inputPath: 'synthetic-dom' },
      }),
    });
    await expect((await secondCommand).json()).resolves.toMatchObject({
      result: { inputPath: 'synthetic-dom' },
    });

    const stream = await fetch(`${root}/stream?channel=console`, { headers: headers(token) });
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    await fetch(`${root}/renderer/telemetry`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        events: [
          { at: '2026-08-13T00:00:00.000Z', channel: 'console', value: { message: 'streamed' } },
        ],
      }),
    });
    const chunk = await reader!.read();
    const line = new TextDecoder().decode(chunk.value).trim();
    expect(JSON.parse(line)).toMatchObject({ channel: 'console', value: { message: 'streamed' } });
    await reader!.cancel();
  });

  it('attaches to the desktop WebView with no simulator and only loopback renderer origins', async () => {
    const port = await freePort();
    const directory = await testRoot();
    let simulatorResolved = false;
    daemon = await startFrontendDebugDaemon(
      { platform: 'desktop', port, root: directory },
      {
        resolveIosSimulator: async () => {
          simulatorResolved = true;
          return 'unused';
        },
      },
    );
    expect(simulatorResolved).toBe(false);
    expect(daemon.descriptor).toMatchObject({ platform: 'desktop', deviceId: 'desktop', transport: 'desktop-renderer-bridge' });
    const session = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
    expect(session.sessionId).toBe(daemon.descriptor.sessionId);
    expect(path.dirname(daemon.descriptor.artifactDirectory)).toBe(directory);
    expect(path.dirname(FRONTEND_DEBUG_SESSION_PATH)).not.toBe(directory);

    const { host, token } = daemon.descriptor;
    const base = `http://${host}:${port}`;
    // A worktree profile serves its renderer on a port derived from the checkout.
    const fromWorktree = await fetch(`${base}/status`, { headers: { ...headers(token), Origin: 'http://127.0.0.1:28412' } });
    expect(fromWorktree.status).toBe(200);
    expect(fromWorktree.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:28412');
    const fromLan = await fetch(`${base}/status`, { headers: { ...headers(token), Origin: 'http://192.168.1.20:5173' } });
    expect(fromLan.status).toBe(403);

    const poll = fetch(`${base}/renderer/next`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ url: 'http://127.0.0.1:28412/#/project/qa' }),
    });
    const command = fetch(`${base}/command`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ command: 'query', input: {}, requestId: 'desktop-query' }),
    });
    const request = (await (await poll).json()) as { id: string; command: string };
    expect(request.command).toBe('query');
    await fetch(`${base}/renderer/result`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ id: request.id, ok: true, result: { count: 2 } }),
    });
    await expect((await command).json()).resolves.toMatchObject({
      transport: 'desktop-renderer-bridge',
      capabilities: { screenshot: 'none', inputPath: 'synthetic-dom' },
      result: { count: 2 },
    });
    expect(daemon.status()).toMatchObject({ platform: 'desktop', rendererConnected: true, targetUrl: 'http://127.0.0.1:28412/#/project/qa' });

    // No window pixels: screenshots say so, and a bundle is evidence without one.
    const screenshot = await fetch(`${base}/command`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ command: 'screenshot', input: {}, requestId: 'desktop-shot' }),
    });
    await expect(screenshot.json()).resolves.toMatchObject({ error: { code: 'SCREENSHOT_UNSUPPORTED' } });
    const bundle = await (await fetch(`${base}/command`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ command: 'bundle', input: {}, requestId: 'desktop-bundle' }),
    })).json() as { artifacts: { kind: string }[] };
    expect(bundle.artifacts.map((item) => item.kind)).toEqual(['manifest', 'console', 'network', 'transcript']);
  });

  it('refuses a device for desktop, and gives a desktop renderer the bridge endpoint', async () => {
    await expect(startFrontendDebugDaemon({ platform: 'desktop', deviceId: 'x', root: await testRoot() })).rejects.toMatchObject({
      code: 'DEVICE_UNSUPPORTED',
    });
    await expect(
      executeFrontendCliCommand({ action: 'serve', values: { platform: 'windows' }, requestId: 'qa', stream: false }),
    ).rejects.toMatchObject({ code: 'INVALID_PLATFORM' });
    expect(existsSync(path.join(root!, 'session.json'))).toBe(false);
    expect(
      frontendDebugRendererEnv({ platform: 'desktop', transport: 'desktop-renderer-bridge', host: '127.0.0.1', port: 4318, token: 't' }),
    ).toEqual({
      VITE_DRIFTING_FRONTEND_DEBUG: '1',
      VITE_DRIFTING_FRONTEND_DEBUG_TRANSPORT: 'desktop-renderer-bridge',
      VITE_DRIFTING_FRONTEND_DEBUG_URL: 'http://127.0.0.1:4318',
      VITE_DRIFTING_FRONTEND_DEBUG_TOKEN: 't',
    });
  });
});
