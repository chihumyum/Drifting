import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error Node launchers intentionally live outside the renderer TS graph.
import { installIosReleaseDevice, parseIosDeviceReleaseArguments } from '../../../scripts/install-ios-release-device.mjs';
// @ts-expect-error Node device discovery intentionally lives outside the renderer TS graph.
import { availableIosDevices, discoverIosDevices, selectIosDevice } from '../../../scripts/ios-device-selection.mjs';

const output = new Writable({ write: (_chunk, _encoding, done) => done() });
const first = { identifier: 'phone-a', coreDeviceIdentifier: 'core-a', name: 'Test Phone', model: 'iPhone' };
const second = { identifier: 'phone-b', coreDeviceIdentifier: 'core-b', name: 'Test Phone', model: 'iPhone' };
const payload = (devices: unknown[]) => ({ info: { outcome: 'success' }, result: { devices } });
const physical = {
  identifier: 'core-a',
  properties: {
    hardware: { reality: 'physical', deviceType: 'iPhone', udid: 'phone-a' },
    connection: { pairingState: 'paired', state: 'connected' },
    state: { name: 'Test Phone' },
  },
};

describe('iOS Release device selection', () => {
  it('filters simulated, offline, unpaired and non-iOS devices across Xcode JSON formats', () => {
    const legacy = {
      identifier: 'core-b',
      hardwareProperties: { reality: 'physical', deviceType: 'iPad', udid: 'tablet-b' },
      connectionProperties: { pairingState: 'paired', tunnelState: 'disconnected' },
      deviceProperties: { name: 'Test Tablet' },
    };
    const variants = [
      { hardware: { ...physical.properties.hardware, reality: 'simulated' } },
      { connection: { pairingState: 'paired', state: 'unavailable' } },
      { connection: { pairingState: 'unpaired', state: 'connected' } },
      { hardware: { ...physical.properties.hardware, deviceType: 'AppleTV' } },
    ].map((properties) => ({ ...physical, properties: { ...physical.properties, ...properties } }));
    expect(availableIosDevices(payload([physical, physical, legacy, ...variants]))).toEqual([
      first,
      { identifier: 'tablet-b', coreDeviceIdentifier: 'core-b', name: 'Test Tablet', model: 'iPad' },
    ]);
    expect(() => availableIosDevices({ result: { devices: [] } })).toThrow('successful device list');
  });

  it('reads the devicectl JSON file and removes transient device metadata', async () => {
    let outputPath = '';
    const execute = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('xcrun');
      expect(args.slice(0, 5)).toEqual(['devicectl', 'list', 'devices', '--timeout', '15']);
      outputPath = args[args.indexOf('--json-output') + 1];
      await writeFile(outputPath, JSON.stringify(payload([physical])));
    });
    expect(await discoverIosDevices(execute, {})).toEqual([first]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('auto-selects a single device and resolves explicit UDID/CoreDevice ID', async () => {
    const prompt = vi.fn();
    expect(await selectIosDevice([first], { interactive: false, output, prompt })).toBe('phone-a');
    for (const requested of ['phone-b', 'core-b']) {
      expect(await selectIosDevice([first, second], { requested, interactive: false, output, prompt })).toBe('phone-b');
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it('prompts for multiple devices, retries invalid input and respects the selected number', async () => {
    const prompt = vi.fn().mockResolvedValueOnce('0').mockResolvedValueOnce('3')
      .mockResolvedValueOnce('1abc').mockResolvedValueOnce('2');
    expect(await selectIosDevice([first, second], { requested: 'Test Phone', interactive: true, prompt, output })).toBe('phone-b');
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it.each(['q', '', 'quit'])('cancels selection on %j without picking a default', async (answer) => {
    await expect(selectIosDevice([first, second], {
      interactive: true, prompt: async () => answer, output,
    })).rejects.toThrow('cancelled');
  });

  it('rejects missing, unavailable and ambiguous non-interactive targets', async () => {
    await expect(selectIosDevice([], { output })).rejects.toThrow('No available paired');
    await expect(selectIosDevice([first], { requested: 'missing', output })).rejects.toThrow('unavailable');
    await expect(selectIosDevice([first, second], { interactive: false, output })).rejects.toThrow('Multiple iOS devices');
  });
});

function harness({ failure = '', bundle = 'cc.drifting.client', origin = 'https://service.example.test', xcodeOrigin = origin }: {
  failure?: string; bundle?: string; origin?: string; xcodeOrigin?: string;
} = {}) {
  const execute = vi.fn(async (command: string, args: string[]) => {
    const stage = command === 'pnpm' ? 'build'
      : command === '/usr/bin/codesign' ? 'signature'
      : args.includes('install') ? 'install' : args.includes('launch') ? 'launch' : '';
    if (stage === failure && failure) throw new Error(`${failure} failed`);
    if (command === '/usr/bin/plutil') return bundle;
    if (command === 'xcodebuild') return JSON.stringify([{ target: 'drifting_iOS', buildSettings: { DRIFTING_HOSTED_ORIGIN: xcodeOrigin } }]);
    if (args.includes('--show-sdk-path')) return '/test/iphoneos.sdk\n';
    return '';
  });
  const dependencies = {
    platform: 'darwin', baseEnvironment: {}, execute, pathExists: () => true,
    createEnvironment: vi.fn((_target: string, options: { mode: string; baseEnvironment: object }) => ({
      ...options.baseEnvironment,
      PATH: '/test/bin',
      DRIFTING_APPLE_DEVELOPMENT_TEAM: 'SYNTHETIC1',
      DRIFTING_HOSTED_ORIGIN: origin,
      VITE_API_BASE_URL: origin,
      VITE_LOCAL_ONLY_MODE: options.mode === 'online' ? 'false' : 'true',
    })),
    writeOauthConfiguration: vi.fn(() => ({ googleDriveOAuthConfigured: false })),
    discoverDevices: vi.fn(async () => [first, second]),
    selectDevice: vi.fn((devices: unknown[], options: object) => selectIosDevice(devices, {
      ...options, interactive: true, prompt: async () => '2', output,
    })),
  };
  return { dependencies, execute };
}

describe('standalone iOS Release build and install', () => {
  it('allows device discovery but rejects unsupported build overrides', () => {
    expect(parseIosDeviceReleaseArguments(['--', '--online', '--no-launch'], {})).toEqual({
      device: '', online: true, launch: false, help: false,
    });
    expect(parseIosDeviceReleaseArguments([], { DRIFTING_IOS_DEVICE: 'core-a' }).device).toBe('core-a');
    for (const flag of ['--debug', '--no-sign', '--target', '--config', '--device']) {
      expect(() => parseIosDeviceReleaseArguments([flag], {})).toThrow();
    }
  });

  it('builds a signed Release with HTTPS/CSP, installs on the selected device, then launches', async () => {
    const { dependencies, execute } = harness();
    await installIosReleaseDevice(['--online'], dependencies);
    const calls = execute.mock.calls;
    expect(calls.map(([command]) => command)).toEqual(['xcrun', 'xcodebuild', 'pnpm', '/usr/bin/codesign', '/usr/bin/plutil', 'xcrun', 'xcrun']);
    expect(calls[1][1]).toEqual(expect.arrayContaining(['-configuration', 'release', '-showBuildSettings', '-json']));
    const build = calls[2][1];
    expect(build).toEqual(expect.arrayContaining(['ios', 'build', '--target', 'aarch64', '--archive-only', '--ci']));
    expect(build).not.toEqual(expect.arrayContaining(['--debug']));
    expect(build).not.toContain('--no-sign');
    expect(build).not.toContain('dev');
    const config = JSON.parse(build[build.indexOf('--config') + 1]);
    expect(config.app.security.csp).toContain('https://service.example.test');
    expect(dependencies.writeOauthConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      SDKROOT: '/test/iphoneos.sdk', APPLE_DEVELOPMENT_TEAM: 'SYNTHETIC1',
      PATH: expect.stringContaining('/scripts/apple-toolchain:'), VITE_LOCAL_ONLY_MODE: 'false',
      DRIFTING_HOSTED_ORIGIN: 'https://service.example.test',
    }));
    expect(calls[5][1]).toEqual(['devicectl', 'device', 'install', 'app', '--device', 'phone-b', expect.stringMatching(/Drifting\.app$/)]);
    expect(calls[6][1]).toEqual(['devicectl', 'device', 'process', 'launch', '--device', 'phone-b', '--terminate-existing', 'cc.drifting.client']);
    expect(calls.flatMap(([, args]) => args)).not.toContain('uninstall');
  });

  it.each(['', 'https:', 'https://wrong.example.test'])('rejects an absent, truncated or mismatched native origin: %j', async (xcodeOrigin) => {
    const { dependencies, execute } = harness({ xcodeOrigin });
    await expect(installIosReleaseDevice(['--online'], dependencies)).rejects.toThrow('Xcode DRIFTING_HOSTED_ORIGIN');
    expect(execute.mock.calls.some(([command]) => command === 'pnpm')).toBe(false);
    expect(execute.mock.calls.flatMap(([, args]) => args)).not.toContain('install');
  });

  it('keeps source builds local-only and honors --no-launch and explicit device', async () => {
    const { dependencies, execute } = harness();
    await installIosReleaseDevice(['--device', 'phone-a', '--no-launch'], dependencies);
    expect(dependencies.createEnvironment).toHaveBeenCalledWith('ios', expect.objectContaining({ mode: 'local' }));
    expect(execute.mock.calls[execute.mock.calls.length - 1]?.[1]).toEqual(expect.arrayContaining(['install', '--device', 'phone-a']));
    expect(execute.mock.calls[1][1]).not.toContain('--config');
  });

  it('fails before discovery, signing config or builds on non-HTTPS Hosted configuration', async () => {
    const { dependencies, execute } = harness({ origin: 'http://service.example.test' });
    await expect(installIosReleaseDevice(['--online'], dependencies)).rejects.toThrow('HTTPS');
    expect(dependencies.discoverDevices).not.toHaveBeenCalled();
    expect(dependencies.writeOauthConfiguration).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops before builds or signing writes when device selection is cancelled', async () => {
    const { dependencies, execute } = harness();
    dependencies.selectDevice.mockRejectedValueOnce(new Error('Device selection cancelled.'));
    await expect(installIosReleaseDevice([], dependencies)).rejects.toThrow('cancelled');
    expect(execute).not.toHaveBeenCalled();
    expect(dependencies.writeOauthConfiguration).not.toHaveBeenCalled();
  });

  it('fails before building when no valid private signing team is configured', async () => {
    const { dependencies, execute } = harness();
    const createEnvironment = dependencies.createEnvironment;
    createEnvironment.mockImplementationOnce(() => ({
      PATH: '/test/bin', DRIFTING_APPLE_DEVELOPMENT_TEAM: '',
      DRIFTING_HOSTED_ORIGIN: 'https://service.example.test',
      VITE_API_BASE_URL: 'https://service.example.test', VITE_LOCAL_ONLY_MODE: 'true',
    }));
    await expect(installIosReleaseDevice([], dependencies)).rejects.toThrow('DRIFTING_APPLE_DEVELOPMENT_TEAM');
    expect(execute.mock.calls.some(([command]) => command === 'pnpm')).toBe(false);
    expect(dependencies.writeOauthConfiguration).not.toHaveBeenCalled();
  });

  it.each(['build', 'signature', 'install'])('stops after %s failure without continuing to install/launch', async (failure) => {
    const { dependencies, execute } = harness({ failure });
    await expect(installIosReleaseDevice([], dependencies)).rejects.toThrow(`${failure} failed`);
    const commands = execute.mock.calls.flatMap(([, args]) => args);
    if (failure !== 'install') expect(commands).not.toContain('install');
    expect(commands).not.toContain('launch');
  });

  it('does not install a missing archive or an unexpected bundle identity', async () => {
    for (const missing of [true, false]) {
      const { dependencies, execute } = harness({ bundle: 'example.wrong-app' });
      dependencies.pathExists = () => !missing;
      await expect(installIosReleaseDevice([], dependencies)).rejects.toThrow(missing ? 'expected app bundle' : 'unexpected bundle identifier');
      expect(execute.mock.calls.flatMap(([, args]) => args)).not.toContain('install');
    }
  });
});
