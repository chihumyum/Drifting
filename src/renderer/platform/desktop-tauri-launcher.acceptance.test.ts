import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The executable Node launcher intentionally lives outside the renderer TS graph.
import * as desktopLauncher from '../../../scripts/run-desktop-tauri.mjs';

const { createDesktopTauriEnvironment, describeDesktopOauthConfiguration } = desktopLauncher;

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
  it('loads native Google OAuth build values from the ignored root env file', () => {
    const environment = createDesktopTauriEnvironment({
      baseEnvironment: {},
      envFile: localEnv(
        'DRIFTING_GOOGLE_DESKTOP_CLIENT_ID=file-client-id\n' +
          'DRIFTING_GOOGLE_DESKTOP_CLIENT_SECRET=file-client-secret\n',
      ),
    });

    expect(environment).toMatchObject({
      DRIFTING_GOOGLE_DESKTOP_CLIENT_ID: 'file-client-id',
      DRIFTING_GOOGLE_DESKTOP_CLIENT_SECRET: 'file-client-secret',
      VITE_LOCAL_ONLY_MODE: 'true',
      VITE_REQUIRE_AUTH: 'false',
      VITE_AI_TRANSPORT: 'direct',
    });
    expect(describeDesktopOauthConfiguration(environment)).toEqual({
      googleDriveOAuthConfigured: true,
    });
  });

  it('keeps explicit shell or CI values authoritative', () => {
    const environment = createDesktopTauriEnvironment({
      baseEnvironment: {
        DRIFTING_GOOGLE_DESKTOP_CLIENT_ID: 'explicit-client-id',
        DRIFTING_DB_DIR: '/tmp/drifting-explicit-database',
      },
      envFile: localEnv(
        'DRIFTING_GOOGLE_DESKTOP_CLIENT_ID=file-client-id\n' +
          'DRIFTING_DB_DIR=file-database\n',
      ),
    });

    expect(environment.DRIFTING_GOOGLE_DESKTOP_CLIENT_ID).toBe('explicit-client-id');
    expect(environment.DRIFTING_DB_DIR).toBe('/tmp/drifting-explicit-database');
  });

  it('fails closed without configuration and never includes values in its summary', () => {
    const environment = createDesktopTauriEnvironment({
      baseEnvironment: {},
      envFile: path.join(tmpdir(), 'missing-drifting-env-file'),
      mode: 'online',
    });
    const summary = describeDesktopOauthConfiguration(environment);

    expect(summary).toEqual({ googleDriveOAuthConfigured: false });
    expect(JSON.stringify(summary)).not.toMatch(/client[_-]?(id|secret)/iu);
    expect(environment).toMatchObject({
      VITE_LOCAL_ONLY_MODE: 'false',
      VITE_REQUIRE_AUTH: 'true',
      VITE_AI_TRANSPORT: 'proxy',
    });
  });
});
