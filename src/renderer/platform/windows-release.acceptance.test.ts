import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// @ts-expect-error The executable Node script intentionally lives outside the renderer TS graph.
import { mergeUpdateManifest } from '../../../scripts/merge-update-manifest.mjs';

const source = (path: string) => readFileSync(path, 'utf8');

const macManifest = {
  version: '0.1.0-alpha.8',
  notes: 'Notes',
  pub_date: '2026-11-05T00:00:00.000Z',
  platforms: { 'darwin-aarch64': { signature: 'mac-signature', url: 'https://example.test/Drifting.app.tar.gz' } },
};

describe('Windows releases (docs/windows.md)', () => {
  it('adds a Windows platform to the macOS updater manifest without touching macOS', () => {
    const merged = mergeUpdateManifest(macManifest, {
      platform: 'windows-x86_64',
      url: 'https://example.test/Drifting_0.1.0-alpha.8_windows_x64-setup.exe',
      signature: 'windows-signature\n',
      version: '0.1.0-alpha.8',
    });
    expect(merged.platforms['darwin-aarch64']).toEqual(macManifest.platforms['darwin-aarch64']);
    expect(merged.platforms['windows-x86_64']).toEqual({
      signature: 'windows-signature',
      url: 'https://example.test/Drifting_0.1.0-alpha.8_windows_x64-setup.exe',
    });
    expect(merged.version).toBe(macManifest.version);
    expect(merged.notes).toBe(macManifest.notes);
  });

  it('refuses a mismatched version, plain HTTP, an empty signature or an unknown platform', () => {
    const entry = { platform: 'windows-aarch64', url: 'https://example.test/a.exe', signature: 's', version: '0.1.0-alpha.8' };
    expect(() => mergeUpdateManifest(macManifest, { ...entry, version: '0.1.0-alpha.9' })).toThrow(/not 0\.1\.0-alpha\.9/);
    expect(() => mergeUpdateManifest(macManifest, { ...entry, url: 'http://example.test/a.exe' })).toThrow(/HTTPS/);
    expect(() => mergeUpdateManifest(macManifest, { ...entry, signature: ' \n' })).toThrow(/empty/);
    expect(() => mergeUpdateManifest(macManifest, { ...entry, platform: 'windows-arm64' })).toThrow(/Unknown/);
  });

  it('builds both Windows installers after the macOS draft and never holds the macOS release back', () => {
    const release = source('.github/workflows/release.yml');
    expect(release).toMatch(/^ {2}build-windows:\n {4}name: .*\n {4}needs: verify$/mu);
    expect(release).toMatch(/^ {2}release-windows:\n {4}name: .*\n {4}needs: \[build, build-windows\]$/mu);
    for (const target of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) expect(release).toContain(`target: ${target}`);
    expect(release).toContain('--bundles nsis');
    expect(release).toContain('for pair in x64:windows-x86_64 arm64:windows-aarch64; do');
    expect(release).toContain('node scripts/merge-update-manifest.mjs');
  });

  it('installs per user and builds preview installers on Windows runners', () => {
    const windowsConfig = JSON.parse(source('src-tauri/tauri.windows.conf.json'));
    expect(windowsConfig.bundle.windows.nsis.installMode).toBe('currentUser');
    const preview = source('.github/workflows/windows.yml');
    expect(preview).toContain('runner: windows-latest');
    expect(preview).toContain('runner: windows-11-arm');
    expect(preview).toContain('cargo test --manifest-path src-tauri/Cargo.toml --locked --lib');
  });
});
