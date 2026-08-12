import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cdp: vi.fn(),
  discover: vi.fn(),
  removeForward: vi.fn(),
  screenshot: vi.fn(),
}));

vi.mock('chrome-remote-interface', () => ({ default: mocks.cdp }));
vi.mock('./adb', () => ({
  discoverAndroidWebView: mocks.discover,
  removeAndroidForward: mocks.removeForward,
  captureAndroidDeviceScreenshot: mocks.screenshot,
}));

import { AndroidCdpSession } from './cdp-client';

function fakeClient() {
  const handlers = new Map<string, () => void>();
  const domain = () => ({ enable: vi.fn(async () => undefined) });
  return {
    Runtime: {
      ...domain(),
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: expression.includes('const command = "snapshot"')
            ? { readyState: 'complete' }
            : { x: 50, y: 60 },
        },
      })),
      consoleAPICalled: vi.fn(),
      exceptionThrown: vi.fn(),
    },
    DOM: domain(),
    CSS: domain(),
    Log: { ...domain(), entryAdded: vi.fn() },
    Network: { ...domain(), requestWillBeSent: vi.fn(), responseReceived: vi.fn() },
    Page: domain(),
    Input: { dispatchTouchEvent: vi.fn(), dispatchMouseEvent: vi.fn(), insertText: vi.fn() },
    close: vi.fn(async () => undefined),
    on: vi.fn((name: string, handler: () => void) => handlers.set(name, handler)),
    emitDisconnect: () => handlers.get('disconnect')?.(),
  };
}

describe('Android CDP frontend session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cdp.mockReset();
    mocks.discover.mockReset();
    mocks.removeForward.mockReset();
    mocks.screenshot.mockReset();
    mocks.discover.mockResolvedValue({
      pid: '4321',
      socket: 'webview_devtools_remote_4321',
      port: 9318,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            id: 'page-1',
            type: 'page',
            title: 'Drifting',
            url: 'http://localhost:5173',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9318/devtools/page/page-1',
          },
        ],
      })),
    );
  });

  it('enables observability domains and sends touch input through CDP', async () => {
    const client = fakeClient();
    mocks.cdp.mockResolvedValue(client);
    const session = new AndroidCdpSession('emulator-5554');

    await expect(session.execute('snapshot', {})).resolves.toEqual({ readyState: 'complete' });
    await expect(
      session.execute('tap', { locator: { kind: 'debug-id', value: 'mobile-paper-cluster' } }),
    ).resolves.toMatchObject({ inputPath: 'cdp-webview', point: { x: 50, y: 60 } });

    expect(client.Runtime.enable).toHaveBeenCalledOnce();
    expect(client.Network.enable).toHaveBeenCalledOnce();
    expect(client.Input.dispatchTouchEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'touchStart' }),
    );
    expect(client.Input.dispatchTouchEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'touchEnd' }),
    );
    await session.close();
    expect(mocks.removeForward).toHaveBeenCalledWith('emulator-5554', 9318);
  });

  it('re-discovers the WebView and replaces the CDP client after a disconnect', async () => {
    const first = fakeClient();
    const second = fakeClient();
    mocks.cdp.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const session = new AndroidCdpSession('emulator-5554');

    await expect(session.execute('snapshot', {})).resolves.toEqual({ readyState: 'complete' });
    first.emitDisconnect();
    await expect(session.execute('snapshot', {})).resolves.toEqual({ readyState: 'complete' });

    expect(mocks.discover).toHaveBeenCalledTimes(2);
    expect(mocks.cdp).toHaveBeenCalledTimes(2);
    expect(mocks.removeForward).toHaveBeenCalledWith('emulator-5554', 9318);
    await session.close();
  });
});
