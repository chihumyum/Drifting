import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The executable Node launcher intentionally lives outside the renderer TS graph.
import * as mobileLauncher from '../../../scripts/run-mobile-dev.mjs';

const {
  createMobileEnvironment,
  describeMobileOauthConfiguration,
  writeIosGoogleOauthLocalConfig,
} = mobileLauncher;

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-mobile-env-'));
  temporaryDirectories.push(directory);
  return directory;
}

function localEnv(contents: string): string {
  const filePath = path.join(temporaryDirectory(), '.env.local');
  writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('mobile Tauri environment', () => {
  it('passes ignored root env values to both native mobile build chains', () => {
    const iosClientId = '123456789012-ios.apps.googleusercontent.com';
    const iosReversedClientId = 'com.googleusercontent.apps.123456789012-ios';
    const androidClientId = '123456789012-android.apps.googleusercontent.com';
    const envFile = localEnv(
      [
        `DRIFTING_GOOGLE_IOS_CLIENT_ID=${iosClientId}`,
        `DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID=${iosReversedClientId}`,
        `DRIFTING_GOOGLE_ANDROID_CLIENT_ID=${androidClientId}`,
      ].join('\n'),
    );
    const ndkHome = temporaryDirectory();

    const ios = createMobileEnvironment('ios', { baseEnvironment: {}, envFile });
    const android = createMobileEnvironment('android', {
      baseEnvironment: { NDK_HOME: ndkHome },
      envFile,
    });

    expect(ios).toMatchObject({
      DRIFTING_GOOGLE_IOS_CLIENT_ID: iosClientId,
      DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID: iosReversedClientId,
      VITE_LOCAL_ONLY_MODE: 'true',
      VITE_REQUIRE_AUTH: 'false',
      VITE_AI_TRANSPORT: 'direct',
    });
    expect(android).toMatchObject({
      DRIFTING_GOOGLE_ANDROID_CLIENT_ID: androidClientId,
      NDK_HOME: ndkHome,
      VITE_LOCAL_ONLY_MODE: 'true',
    });
  });

  it('keeps explicit shell or CI values authoritative', () => {
    const envFile = localEnv(
      'DRIFTING_GOOGLE_ANDROID_CLIENT_ID=123456789012-file.apps.googleusercontent.com\n',
    );
    const ndkHome = temporaryDirectory();
    const environment = createMobileEnvironment('android', {
      baseEnvironment: {
        DRIFTING_GOOGLE_ANDROID_CLIENT_ID:
          '123456789012-explicit.apps.googleusercontent.com',
        NDK_HOME: ndkHome,
        VITE_LOCAL_ONLY_MODE: 'false',
      },
      envFile,
    });

    expect(environment.DRIFTING_GOOGLE_ANDROID_CLIENT_ID).toBe(
      '123456789012-explicit.apps.googleusercontent.com',
    );
    expect(environment.VITE_LOCAL_ONLY_MODE).toBe('false');
    expect(environment.VITE_REQUIRE_AUTH).toBe('true');
  });

  it('writes an ignored owner-only iOS build setting without exposing values in status', () => {
    const clientId = '123456789012-ios.apps.googleusercontent.com';
    const reversedClientId = 'com.googleusercontent.apps.123456789012-ios';
    const destination = path.join(temporaryDirectory(), 'GoogleOAuth.local.xcconfig');
    const environment = {
      DRIFTING_GOOGLE_IOS_CLIENT_ID: clientId,
      DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID: reversedClientId,
    };

    const summary = writeIosGoogleOauthLocalConfig(environment, destination);
    const generated = readFileSync(destination, 'utf8');

    expect(summary).toEqual({ googleDriveOAuthConfigured: true });
    expect(generated).toContain(`DRIFTING_GOOGLE_IOS_CLIENT_ID = ${clientId}`);
    expect(generated).toContain(
      `DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID = ${reversedClientId}`,
    );
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(summary)).not.toContain(clientId);
    expect(JSON.stringify(summary)).not.toContain(reversedClientId);
  });

  it('fails closed for missing or mismatched mobile configuration', () => {
    const destination = path.join(temporaryDirectory(), 'GoogleOAuth.local.xcconfig');
    const mismatched = {
      DRIFTING_GOOGLE_IOS_CLIENT_ID: '123456789012-ios.apps.googleusercontent.com',
      DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID: 'com.googleusercontent.apps.wrong',
    };

    expect(describeMobileOauthConfiguration('ios', mismatched)).toEqual({
      googleDriveOAuthConfigured: false,
    });
    expect(describeMobileOauthConfiguration('android', {})).toEqual({
      googleDriveOAuthConfigured: false,
    });
    expect(writeIosGoogleOauthLocalConfig(mismatched, destination)).toEqual({
      googleDriveOAuthConfigured: false,
    });
    const generated = readFileSync(destination, 'utf8');
    expect(generated).toContain('DRIFTING_GOOGLE_IOS_CLIENT_ID = \n');
    expect(generated).toContain('DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID = \n');
    expect(generated).not.toContain('com.googleusercontent.apps.wrong');
  });

  it('keeps the iOS plist and Android SDK connected to Rust build configuration', () => {
    const read = (relativePath: string) =>
      readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
    const xcconfig = read('src-tauri/gen/apple/GoogleOAuth.xcconfig');
    const plist = read('src-tauri/gen/apple/drifting_iOS/Info.plist');
    const rust = read('src-tauri/src/google_drive_sync.rs');
    const swift = read(
      'src-tauri/plugins/drifting-google-drive-oauth/ios/Sources/GoogleDriveOAuthPlugin.swift',
    );
    const kotlin = read(
      'src-tauri/plugins/drifting-google-drive-oauth/android/src/main/java/GoogleDriveOAuthPlugin.kt',
    );

    expect(xcconfig).toContain('#include? "GoogleOAuth.local.xcconfig"');
    expect(plist).toContain('$(DRIFTING_GOOGLE_IOS_CLIENT_ID)');
    expect(plist).toContain('$(DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID)');
    expect(rust).toContain('option_env!("DRIFTING_GOOGLE_IOS_CLIENT_ID")');
    expect(rust).toContain('option_env!("DRIFTING_GOOGLE_ANDROID_CLIENT_ID")');
    expect(swift).toContain('GIDConfiguration(clientID: args.clientId)');
    expect(kotlin).toContain('if (!validClientId(args.clientId)');
  });
});
