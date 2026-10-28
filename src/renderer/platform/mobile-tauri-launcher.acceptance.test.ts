import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The executable Node launcher intentionally lives outside the renderer TS graph.
import * as mobileLauncher from '../../../scripts/run-mobile-dev.mjs';

const {
  createMobileEnvironment,
  writeIosLocalBuildConfig,
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

  it('loads operator signing settings while explicit shell values win', () => {
    const envFile = localEnv('DRIFTING_APPLE_DEVELOPMENT_TEAM=SYNTH00001\n');
    expect(createMobileEnvironment('ios', { envFile, baseEnvironment: {} }).DRIFTING_APPLE_DEVELOPMENT_TEAM)
      .toBe('SYNTH00001');
    expect(createMobileEnvironment('ios', { envFile, baseEnvironment: {
      DRIFTING_APPLE_DEVELOPMENT_TEAM: 'SYNTH00002',
    } }).DRIFTING_APPLE_DEVELOPMENT_TEAM).toBe('SYNTH00002');
  });

  it('writes owner-only signing configuration and clears invalid or missing team settings', () => {
    const destination = path.join(temporaryDirectory(), 'LocalBuild.local.xcconfig');
    writeIosLocalBuildConfig({ DRIFTING_APPLE_DEVELOPMENT_TEAM: 'SYNTH00001' }, destination);
    expect(readFileSync(destination, 'utf8')).toContain('DEVELOPMENT_TEAM = SYNTH00001\n');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    for (const team of ['invalid team', undefined]) {
      writeIosLocalBuildConfig({ DRIFTING_APPLE_DEVELOPMENT_TEAM: team }, destination);
      expect(readFileSync(destination, 'utf8')).toContain('DEVELOPMENT_TEAM = \n');
      expect(readFileSync(destination, 'utf8')).not.toContain('SYNTH00001');
    }
  });

  it('exports the canonical Hosted origin through xcconfig and clears it for local builds', () => {
    const destination = path.join(temporaryDirectory(), 'LocalBuild.local.xcconfig');
    const environment = { VITE_LOCAL_ONLY_MODE: 'false', DRIFTING_HOSTED_ORIGIN: 'https://SERVICE.example.test:8443/' };
    writeIosLocalBuildConfig(environment, destination);
    expect(readFileSync(destination, 'utf8')).toContain('DRIFTING_HOSTED_ORIGIN = https:/$()/service.example.test:8443\n');
    writeIosLocalBuildConfig({ ...environment, VITE_LOCAL_ONLY_MODE: 'true' }, destination);
    expect(readFileSync(destination, 'utf8')).toContain('DRIFTING_HOSTED_ORIGIN = \n');
    expect(readFileSync(destination, 'utf8')).not.toContain('service.example.test');
    writeIosLocalBuildConfig({ ...environment, DRIFTING_HOSTED_ORIGIN: 'http://[::1]:3000' }, destination);
    expect(readFileSync(destination, 'utf8')).toContain('DRIFTING_HOSTED_ORIGIN = http:/$()/[::1]:3000\n');
    for (const origin of [undefined, 'https://service.example.test/api', 'https://$(SECRET).example.test']) {
      expect(() => writeIosLocalBuildConfig({ ...environment, DRIFTING_HOSTED_ORIGIN: origin }, destination)).toThrow();
    }
  });

});
