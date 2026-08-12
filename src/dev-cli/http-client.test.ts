import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { bridgeRequest, serverRequest } from './http-client';

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  server.close();
  await once(server, 'close');
  server = null;
});

async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('CLI HTTP transports', () => {
  it('rejects a non-loopback or HTTPS Agent bridge before making a request', async () => {
    await expect(
      bridgeRequest({
        bridgeUrl: 'https://localhost:4317',
        endpoint: '/turn',
        body: {},
      }),
    ).rejects.toMatchObject({ code: 'BRIDGE_URL_REFUSED' });
    await expect(
      bridgeRequest({
        bridgeUrl: 'http://example.com:4317',
        endpoint: '/turn',
        body: {},
      }),
    ).rejects.toMatchObject({ code: 'BRIDGE_URL_REFUSED' });
  });

  it('parses real JSON HTTP responses and terminal NDJSON bridge events', async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === '/turn') {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end(
          `${JSON.stringify({ type: 'bridge_started' })}\n${JSON.stringify({ type: 'bridge_completed', result: { ok: true } })}\n`,
        );
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=must-not-enter-cli-output',
      });
      response.end(JSON.stringify({ requestId: request.headers['x-request-id'] }));
    });

    await expect(
      serverRequest({
        baseUrl,
        method: 'GET',
        path: '/api/projects',
        requestId: 'server-fixture',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 200,
        body: { requestId: 'server-fixture' },
        headers: expect.not.objectContaining({ 'set-cookie': expect.anything() }),
      }),
    );
    await expect(
      bridgeRequest({ bridgeUrl: baseUrl, endpoint: '/turn', body: { prompt: 'inspect' } }),
    ).resolves.toMatchObject({ terminal: { type: 'bridge_completed', result: { ok: true } } });
  });
});
