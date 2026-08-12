import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { startFrontendDebugDaemon, type FrontendDebugDaemon } from './daemon';

let daemon: FrontendDebugDaemon | null = null;

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
    if (!daemon) return;
    const artifacts = daemon.descriptor.artifactDirectory;
    await daemon.close();
    await rm(artifacts, { recursive: true, force: true });
    daemon = null;
  });

  it('authenticates, brokers a renderer command, and redacts telemetry end to end', async () => {
    daemon = await startFrontendDebugDaemon(
      { platform: 'ios', deviceId: 'SIMULATOR-QA', port: await freePort() },
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
      { platform: 'ios', deviceId: 'SIMULATOR-QA', port: await freePort() },
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
});
