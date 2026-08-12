import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from '../protocol';

const execFileAsync = promisify(execFile);

export interface AdbDevice {
  serial: string;
  state: string;
}

export function parseAdbDevices(output: string): AdbDevice[] {
  return output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([serial, state]) => Boolean(serial && state))
    .map(([serial, state]) => ({ serial: serial!, state: state! }));
}

export function parseWebViewSockets(output: string, pid: string): string[] {
  const sockets = new Set<string>();
  const escapedPid = pid.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const ownsPid = new RegExp(`(?:^|\\D)${escapedPid}(?:\\D|$)`, 'u');
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/@((?:webview|chrome)_devtools_remote[^\s]*)/u);
    if (!match?.[1]) continue;
    if (!ownsPid.test(match[1])) continue;
    sockets.add(match[1]);
  }
  return [...sockets];
}

async function adb(args: string[], timeout = 10_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('adb', args, {
      timeout,
      maxBuffer: 8 * 1_048_576,
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError('ADB_FAILED', `adb ${args.join(' ')} failed: ${message}`);
  }
}

export async function resolveAndroidEmulator(requested?: string): Promise<string> {
  const devices = parseAdbDevices(await adb(['devices'])).filter(
    (device) => device.state === 'device',
  );
  const candidates = requested ? devices.filter((device) => device.serial === requested) : devices;
  if (candidates.length === 0) {
    throw new CliError(
      'ANDROID_DEVICE_NOT_FOUND',
      requested
        ? `Android device ${requested} is not connected`
        : 'No Android emulator is connected',
    );
  }
  const emulators: string[] = [];
  for (const device of candidates) {
    const qemu = await adb(['-s', device.serial, 'shell', 'getprop', 'ro.kernel.qemu']);
    if (qemu === '1') emulators.push(device.serial);
  }
  if (emulators.length === 0) {
    throw new CliError(
      'PHYSICAL_DEVICE_UNSUPPORTED',
      'Frontend Debug V1 only supports Android emulators',
    );
  }
  if (emulators.length > 1) {
    throw new CliError(
      'AMBIGUOUS_ANDROID_DEVICE',
      'Multiple Android emulators are connected',
      emulators,
    );
  }
  return emulators[0]!;
}

export async function discoverAndroidWebView(deviceId: string): Promise<{
  pid: string;
  socket: string;
  port: number;
}> {
  const pid = await adb(['-s', deviceId, 'shell', 'pidof', '-s', 'cc.drifting.client']).catch(
    () => '',
  );
  if (!/^\d+$/u.test(pid)) {
    throw new CliError(
      'ANDROID_APP_NOT_RUNNING',
      'cc.drifting.client is not running on the emulator',
    );
  }
  const sockets = parseWebViewSockets(
    await adb(['-s', deviceId, 'shell', 'cat', '/proc/net/unix']),
    pid,
  );
  if (sockets.length !== 1) {
    throw new CliError(
      sockets.length === 0 ? 'WEBVIEW_SOCKET_NOT_FOUND' : 'AMBIGUOUS_WEBVIEW_SOCKET',
      sockets.length === 0
        ? `No debuggable WebView socket was found for app PID ${pid}`
        : `Multiple WebView sockets were found for app PID ${pid}`,
      sockets,
    );
  }
  const forwarded = await adb(['-s', deviceId, 'forward', 'tcp:0', `localabstract:${sockets[0]}`]);
  const port = Number(forwarded);
  if (!Number.isSafeInteger(port) || port < 1) {
    throw new CliError(
      'ADB_FORWARD_FAILED',
      `adb returned an invalid forwarded port: ${forwarded}`,
    );
  }
  return { pid, socket: sockets[0]!, port };
}

export async function removeAndroidForward(deviceId: string, port: number): Promise<void> {
  await adb(['-s', deviceId, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined);
}

export async function captureAndroidDeviceScreenshot(
  deviceId: string,
  outputPath: string,
): Promise<void> {
  try {
    const { stdout } = await execFileAsync('adb', ['-s', deviceId, 'exec-out', 'screencap', '-p'], {
      timeout: 20_000,
      encoding: 'buffer',
      maxBuffer: 32 * 1_048_576,
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outputPath, stdout);
  } catch (error) {
    throw new CliError(
      'ANDROID_SCREENSHOT_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}
