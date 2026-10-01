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
  it('explicit iOS online mode uses one validated origin despite local defaults', () => {
    const envFile = localEnv('VITE_LOCAL_ONLY_MODE=true\nVITE_API_BASE_URL=http://localhost:3000\nDRIFTING_HOSTED_ORIGIN=https://service.example.test\n');
    const environment = createMobileEnvironment('ios', { baseEnvironment: {}, envFile, mode: 'online' });
    expect(environment).toMatchObject({ VITE_LOCAL_ONLY_MODE: 'false', VITE_REQUIRE_AUTH: 'false',
      VITE_API_BASE_URL: 'https://service.example.test', API_BASE_URL: 'https://service.example.test',
      DRIFTING_HOSTED_ORIGIN: 'https://service.example.test' });
    const override = createMobileEnvironment('ios', { envFile, mode: 'online', baseEnvironment: { VITE_API_BASE_URL: 'https://override.example.test/' } });
    expect(override.DRIFTING_HOSTED_ORIGIN).toBe('https://override.example.test');
    expect(createMobileEnvironment('ios', { envFile, baseEnvironment: {} }).VITE_LOCAL_ONLY_MODE).toBe('true');
    for (const origin of ['https://secret@service.example.test', 'https://service.example.test/api', 'https://service.example.test?key=secret']) {
      expect(() => createMobileEnvironment('ios', { envFile, mode: 'online', baseEnvironment: { DRIFTING_HOSTED_ORIGIN: origin } })).toThrow(/exact HTTP/);
    }
  });
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
    expect(environment.VITE_REQUIRE_AUTH).toBe('false');
    expect(environment.VITE_AI_TRANSPORT).toBe('direct');
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

  it('exports the canonical Hosted origin through xcconfig and clears it for local builds', () => {
    const destination = path.join(temporaryDirectory(), 'GoogleOAuth.local.xcconfig');
    const environment = { VITE_LOCAL_ONLY_MODE: 'false', DRIFTING_HOSTED_ORIGIN: 'https://SERVICE.example.test:8443/' };
    writeIosGoogleOauthLocalConfig(environment, destination);
    expect(readFileSync(destination, 'utf8')).toContain('DRIFTING_HOSTED_ORIGIN = https:/$()/service.example.test:8443\n');
    writeIosGoogleOauthLocalConfig({ ...environment, VITE_LOCAL_ONLY_MODE: 'true' }, destination);
    expect(readFileSync(destination, 'utf8')).toContain('DRIFTING_HOSTED_ORIGIN = \n');
    expect(readFileSync(destination, 'utf8')).not.toContain('service.example.test');
    writeIosGoogleOauthLocalConfig({ ...environment, DRIFTING_HOSTED_ORIGIN: 'http://[::1]:3000' }, destination);
    expect(readFileSync(destination, 'utf8')).toContain('DRIFTING_HOSTED_ORIGIN = http:/$()/[::1]:3000\n');
    for (const origin of [undefined, 'https://service.example.test/api', 'https://$(SECRET).example.test']) {
      expect(() => writeIosGoogleOauthLocalConfig({ ...environment, DRIFTING_HOSTED_ORIGIN: origin }, destination)).toThrow();
    }
  });

  it('keeps the iOS plist and Android SDK connected to Rust build configuration', () => {
    const read = (relativePath: string) =>
      readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
    const xcconfig = read('src-tauri/gen/apple/GoogleOAuth.xcconfig');
    const xcodeProject = read('src-tauri/gen/apple/drifting.xcodeproj/project.pbxproj');
    const plist = read('src-tauri/gen/apple/drifting_iOS/Info.plist');
    const rust = read('src-tauri/src/google_drive_sync.rs');
    const swift = read(
      'src-tauri/plugins/drifting-google-drive-oauth/ios/Sources/GoogleDriveOAuthPlugin.swift',
    );
    const kotlin = read(
      'src-tauri/plugins/drifting-google-drive-oauth/android/src/main/java/GoogleDriveOAuthPlugin.kt',
    );

    expect(xcconfig).toContain('#include? "GoogleOAuth.local.xcconfig"');
    expect(xcconfig).toMatch(/^DRIFTING_HOSTED_ORIGIN =$/m);
    // Both Debug and Release must export native settings to the Rust build phase.
    const configurationId = xcodeProject.match(/(\w+) \/\* GoogleOAuth.xcconfig \*\/ = \{isa = PBXFileReference/)?.[1];
    expect(configurationId).toBeTruthy();
    expect(xcodeProject.match(new RegExp(`baseConfigurationReference = ${configurationId}`, 'g'))).toHaveLength(2);
    expect(read('scripts/run-hosted-client.mjs')).toContain("writeIosGoogleOauthLocalConfig(createMobileEnvironment('ios'");
    expect(plist).toContain('$(DRIFTING_GOOGLE_IOS_CLIENT_ID)');
    expect(plist).toContain('$(DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID)');
    expect(rust).toContain('option_env!("DRIFTING_GOOGLE_IOS_CLIENT_ID")');
    expect(rust).toContain('option_env!("DRIFTING_GOOGLE_ANDROID_CLIENT_ID")');
    expect(swift).toContain('GIDConfiguration(clientID: args.clientId)');
    expect(kotlin).toContain('if (!validClientId(args.clientId)');
  });
});
