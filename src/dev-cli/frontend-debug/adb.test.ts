import { describe, expect, it } from 'vitest';
import { parseAdbDevices, parseWebViewSockets } from './adb';

describe('frontend debug adb discovery', () => {
  it('parses connected states without treating unauthorized devices as usable', () => {
    expect(
      parseAdbDevices(
        'List of devices attached\nemulator-5554\tdevice product:sdk_gphone\nABC\tunauthorized\n\n',
      ),
    ).toEqual([
      { serial: 'emulator-5554', state: 'device' },
      { serial: 'ABC', state: 'unauthorized' },
    ]);
  });

  it('selects only WebView sockets owned by the requested app PID', () => {
    const unix = [
      '00000000: 00000002 00000000 00010000 0001 01 111 @webview_devtools_remote_4321',
      '00000000: 00000002 00000000 00010000 0001 01 222 @webview_devtools_remote_9876',
      '00000000: 00000002 00000000 00010000 0001 01 333 @webview_devtools_remote_4321',
    ].join('\n');
    expect(parseWebViewSockets(unix, '4321')).toEqual(['webview_devtools_remote_4321']);
  });
});
