import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error The executable Node launcher intentionally lives outside the renderer TS graph.
import * as installer from '../../../scripts/install-ios-debug-device.mjs';

const {
  createIosDeviceDebugPlan,
  installIosDebugDevice,
  parseIosDeviceDebugArguments,
} = installer;

describe('standalone iOS device Debug installer', () => {
  it('accepts pnpm argument forwarding, explicit devices, and no-launch mode', () => {
    expect(
      parseIosDeviceDebugArguments(['--', '--device', 'Author iPhone', '--no-launch'], {}),
    ).toEqual({ device: 'Author iPhone', launch: false, help: false });
    expect(parseIosDeviceDebugArguments([], { DRIFTING_IOS_DEVICE: 'paired-id' })).toEqual({
      device: 'paired-id',
      launch: true,
      help: false,
    });
  });

  it('fails before building when the physical device target is ambiguous', () => {
    expect(() => parseIosDeviceDebugArguments([], {})).toThrow('A paired iOS device is required');
    expect(() => parseIosDeviceDebugArguments(['--device'], {})).toThrow(
      '--device requires a device name or identifier',
    );
    expect(() => parseIosDeviceDebugArguments(['--open'], {})).toThrow(
      'Unsupported option: --open',
    );
  });

  it('builds a bundled arm64 archive and installs without a development server', () => {
    const root = '/workspace/drifting';
    const plan = createIosDeviceDebugPlan({
      device: 'paired-id',
      root,
      pnpmExecutable: 'pnpm',
    });

    expect(plan.build).toEqual({
      command: 'pnpm',
      arguments: [
        '--dir',
        root,
        'exec',
        'tauri',
        'ios',
        'build',
        '--debug',
        '--target',
        'aarch64',
        '--archive-only',
        '--ci',
      ],
    });
    expect(plan.build.arguments).not.toContain('dev');
    expect(plan.appPath).toBe(
      path.join(
        root,
        'src-tauri/gen/apple/build/drifting_iOS.xcarchive/Products/Applications/Drifting.app',
      ),
    );
    expect(plan.verifySignature.arguments).toContain(plan.appPath);
    expect(plan.install.arguments).toEqual([
      'devicectl',
      'device',
      'install',
      'app',
      '--device',
      'paired-id',
      plan.appPath,
    ]);
    expect(plan.launch?.arguments).toContain('cc.drifting.client');
  });

  it('prepares local-only OAuth build state, validates the bundle, installs, and launches', async () => {
    const calls: Array<{
      command: string;
      arguments: readonly string[];
      environment?: Record<string, string>;
      captureOutput?: boolean;
    }> = [];
    const execute = vi.fn(
      async (
        command: string,
        args: readonly string[],
        options: { environment?: Record<string, string>; captureOutput?: boolean },
      ) => {
        calls.push({ command, arguments: args, ...options });
        return command === '/usr/bin/plutil' ? 'cc.drifting.client\n' : '';
      },
    );

    await installIosDebugDevice(['--device', 'paired-id'], {
      baseEnvironment: {},
      platform: 'darwin',
      pathExists: () => true,
      execute,
      createEnvironment: (_target: string, options: { baseEnvironment: Record<string, string> }) =>
        options.baseEnvironment,
      writeOauthConfiguration: () => ({ googleDriveOAuthConfigured: true }),
    });

    expect(calls.map((call) => call.command)).toEqual([
      'pnpm',
      '/usr/bin/codesign',
      '/usr/bin/plutil',
      'xcrun',
      'xcrun',
    ]);
    expect(calls[0]?.environment).toMatchObject({
      VITE_LOCAL_ONLY_MODE: 'true',
      VITE_REQUIRE_AUTH: 'false',
      VITE_AI_TRANSPORT: 'direct',
    });
    expect(calls[2]?.captureOutput).toBe(true);
    expect(calls[3]?.arguments).toContain('install');
    expect(calls[4]?.arguments).toContain('launch');
  });
});
