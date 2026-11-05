import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error The executable Node launcher intentionally lives outside the renderer TS graph.
import * as desktopLauncher from '../../../scripts/run-desktop-tauri.mjs';

const {
  createDesktopTauriConfigOverride,
  createDesktopTauriEnvironment,
  prepareDesktopSigning,
  tauriCliInvocation,
} = desktopLauncher;

const temporaryDirectories: string[] = [];

function localEnv(contents: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-desktop-env-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, '.env.local');
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('desktop Tauri environment', () => {
  it('checks and pins the selected development identity before starting the native toolchain', () => {
    const environment: Record<string, string> = {};
    const resolveIdentity = vi.fn(() => 'synthetic-verified-identity');
    expect(prepareDesktopSigning({ command: 'dev', platform: 'darwin', environment, resolveIdentity })).toBe('synthetic-verified-identity');
    expect(environment.DRIFTING_MACOS_DEV_SIGNING_IDENTITY).toBe('synthetic-verified-identity');
    expect(resolveIdentity).toHaveBeenCalledOnce();
  });

  it('gives a new contributor actionable instructions while keeping signing failures closed', () => {
    const resolveIdentity = () => { throw new Error('No Apple Development identity found'); };
    expect(() => prepareDesktopSigning({ command: 'dev', platform: 'darwin', environment: {}, resolveIdentity }))
      .toThrow(/No Apple Development identity found[\s\S]*Xcode Settings[\s\S]*pnpm dev:check[\s\S]*contributor-quick-start/);
  });

  it('does not require a development certificate for non-macOS, help or configured distribution builds', () => {
    const resolveIdentity = vi.fn(() => { throw new Error('must not resolve'); });
    for (const config of [
      { command: 'dev', platform: 'linux', environment: {} },
      { command: 'dev', platform: 'darwin', environment: {}, arguments: ['--help'] },
      { command: 'build', platform: 'darwin', environment: { DRIFTING_UPDATER_PUBLIC_KEY: 'synthetic-public-key' } },
    ]) expect(prepareDesktopSigning({ ...config, resolveIdentity })).toBeUndefined();
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('still verifies local and debug bundles and honors an explicitly selected identity', () => {
    const environment = { DRIFTING_MACOS_DEV_SIGNING_IDENTITY: 'requested', DRIFTING_UPDATER_PUBLIC_KEY: 'synthetic-public-key' };
    const resolveIdentity = vi.fn(() => 'verified');
    expect(prepareDesktopSigning({ command: 'build', arguments: ['--debug'], platform: 'darwin', environment, resolveIdentity })).toBe('verified');
    expect(resolveIdentity).toHaveBeenCalledWith({ requestedIdentity: 'requested' });
  });

  it('keeps explicit shell or CI values authoritative', () => {
    const environment = createDesktopTauriEnvironment({
      baseEnvironment: {
        DRIFTING_SYNTHETIC_SETTING: 'explicit-value',
        DRIFTING_DB_DIR: '/tmp/drifting-explicit-database',
      },
      envFile: localEnv(
        'DRIFTING_SYNTHETIC_SETTING=file-value\n' +
          'DRIFTING_DB_DIR=file-database\n',
      ),
    });

    expect(environment.DRIFTING_SYNTHETIC_SETTING).toBe('explicit-value');
    expect(environment.DRIFTING_DB_DIR).toBe('/tmp/drifting-explicit-database');
  });


  it('keeps the development App-local folder apart from the installed App', () => {
    expect(desktopLauncher.developmentAppDataDirectory('dev', {})).toBe('.local-data/app-data');
    expect(desktopLauncher.developmentAppDataDirectory('dev', { DRIFTING_APP_DATA_DIR: '/tmp/explicit' }))
      .toBe('/tmp/explicit');
    expect(desktopLauncher.developmentAppDataDirectory('build', {})).toBeUndefined();
  });

  it('runs the development App under its own identifier beside an installed release', () => {
    expect(desktopLauncher.withDevelopmentIdentifier('dev', null)).toEqual({ identifier: 'cc.drifting.client.dev' });
    expect(desktopLauncher.withDevelopmentIdentifier('dev', { app: { security: {} } }))
      .toEqual({ app: { security: {} }, identifier: 'cc.drifting.client.dev' });
    expect(desktopLauncher.withDevelopmentIdentifier('build', null)).toBeNull();
  });

  it('uses one configured origin for renderer authentication, native sync and CSP while preserving HMR', () => {
    const environment = createDesktopTauriEnvironment({
      baseEnvironment: {},
      envFile: localEnv('DRIFTING_HOSTED_ORIGIN=https://hosted.example.test/\nVITE_API_BASE_URL=http://localhost:3000\n'),
      mode: 'online',
    });
    for (const key of ['DRIFTING_HOSTED_ORIGIN', 'VITE_API_BASE_URL', 'API_BASE_URL']) {
      expect(environment[key]).toBe('https://hosted.example.test');
    }
    const override = createDesktopTauriConfigOverride({ command: 'dev', environment });
    expect(override.app.security.devCsp).toContain('https://hosted.example.test');
    expect(override.app.security.devCsp).toContain('ws://localhost:5173');
    expect(override.app.security.csp).toContain('https://hosted.example.test');
    expect(override.plugins).toBeUndefined();
  });

  it('lets a shell service override the file origin without changing the local library', () => {
    const environment = createDesktopTauriEnvironment({
      baseEnvironment: { VITE_API_BASE_URL: 'https://shell.example.test' },
      envFile: localEnv('DRIFTING_HOSTED_ORIGIN=https://file.example.test\nDRIFTING_DB_DIR=existing-library\n'),
      mode: 'online',
    });
    expect(environment.DRIFTING_HOSTED_ORIGIN).toBe('https://shell.example.test');
    expect(environment.VITE_API_BASE_URL).toBe(environment.DRIFTING_HOSTED_ORIGIN);
    expect(environment.DRIFTING_DB_DIR).toBe('existing-library');
  });

  it.each(['https://example.test/api', 'https://user:secret@example.test',
    'https://example.test?token=secret', 'https://example.test/#fragment',
    'https://*.example.test', 'file:///tmp/service'])('rejects non-origin service configuration: %s', (origin) => {
    expect(() => createDesktopTauriEnvironment({
      baseEnvironment: { DRIFTING_HOSTED_ORIGIN: origin },
      envFile: localEnv(''),
      mode: 'online',
    })).toThrow(/exact HTTP\(S\) origin/);
  });

  it('keeps the default source launcher local-only even when a Hosted service is configured', () => {
    const environment = createDesktopTauriEnvironment({
      baseEnvironment: {},
      envFile: localEnv('DRIFTING_HOSTED_ORIGIN=https://hosted.example.test\nVITE_LOCAL_ONLY_MODE=false\n'),
    });
    expect(environment.VITE_LOCAL_ONLY_MODE).toBe('true');
    expect(environment.VITE_API_BASE_URL).toBe('http://localhost:3000');
    expect(createDesktopTauriConfigOverride({ command: 'dev', environment })).toBeNull();
  });

  it('disables updater artifacts for local and debug bundles', () => {
    // A key in the environment is compiled in, so the App starts the updater
    // plugin, which refuses to start without its configuration.
    expect(
      createDesktopTauriConfigOverride({
        command: 'build',
        arguments: ['--debug'],
        environment: { DRIFTING_UPDATER_PUBLIC_KEY: 'release-public-key' },
        macosSigningIdentity: 'development-identity',
      }),
    ).toEqual({
      plugins: { updater: { pubkey: 'release-public-key' } },
      bundle: {
        createUpdaterArtifacts: false,
        macOS: { signingIdentity: 'development-identity' },
      },
    });
    expect(
      createDesktopTauriConfigOverride({
        command: 'build',
        environment: {},
      }),
    ).toEqual({ bundle: { createUpdaterArtifacts: false } });
    // Windows previews: the key is compiled in and the updater configured, so
    // the installed App opens and updates to a release, but no updates are signed.
    expect(
      createDesktopTauriConfigOverride({
        command: 'build',
        environment: { DRIFTING_UPDATER_PUBLIC_KEY: 'release-public-key', DRIFTING_UPDATER_ARTIFACTS: 'off' },
      }),
    ).toEqual({
      plugins: { updater: { pubkey: 'release-public-key' } },
      bundle: { createUpdaterArtifacts: false },
    });
  });

  it('injects the protected updater public key only for configured release bundles', () => {
    expect(
      createDesktopTauriConfigOverride({
        command: 'build',
        arguments: [],
        environment: { DRIFTING_UPDATER_PUBLIC_KEY: 'release-public-key' },
      }),
    ).toEqual({ plugins: { updater: { pubkey: 'release-public-key' } } });
    expect(
      createDesktopTauriConfigOverride({
        command: 'dev',
        arguments: [],
        environment: { DRIFTING_UPDATER_PUBLIC_KEY: 'release-public-key' },
      }),
    ).toBeNull();
  });
});

describe('Tauri CLI invocation', () => {
  it('runs the CLI entry script with Node on Windows and pnpm exec elsewhere', () => {
    const windows = tauriCliInvocation({ platform: 'win32', nodeExecutable: 'C:\\node\\node.exe' });
    expect(windows.executable).toBe('C:\\node\\node.exe');
    expect(windows.arguments).toHaveLength(1);
    expect(windows.arguments[0]).toMatch(/node_modules[\\/]@tauri-apps[\\/]cli[\\/]tauri\.js$/);
    const mac = tauriCliInvocation({ platform: 'darwin' });
    expect(mac.executable).toBe('pnpm');
    expect(mac.arguments).toEqual(['--dir', expect.any(String), 'exec', 'tauri']);
  });
});
