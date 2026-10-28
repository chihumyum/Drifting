import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('retired client integrations', () => {
  it('removes Drive native commands, renderer ports and SDK dependencies', () => {
    for (const file of [
      'src-tauri/src/lib.rs', 'src-tauri/Cargo.toml',
      'src/renderer/platform/contracts.ts', 'src/renderer/platform/types.ts',
      'src/renderer/platform/tauri.ts', 'src-tauri/gen/apple/project.yml',
      'src-tauri/gen/apple/drifting_iOS/Info.plist',
    ]) {
      expect(read(file), file).not.toMatch(/google_drive|googleDrive|GoogleDrive|DRIFTING_GOOGLE/);
    }
    for (const file of [
      'src-tauri/src/google_drive_sync.rs',
      'src-tauri/gen/apple/Sources/drifting/AppAuthIOSCategoryBridge.m',
      'src-tauri/plugins/drifting-google-drive-oauth/Cargo.toml',
      'src/renderer/sync/providers/google-drive/index.ts',
      'src/renderer/sync/restore/google-drive-product-connect.ts',
      'native/apple/project.yml', 'crates/drifting-apple-bridge/Cargo.toml',
    ]) expect(existsSync(resolve(process.cwd(), file)), file).toBe(false);
  });

  it('keeps Hosted provisioning and removes experimental build gates', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(Object.keys(scripts).filter(key => /^(apple:|mobile:google-drive:)/u.test(key))).toEqual([]);
    expect(read('.github/workflows/ci.yml')).not.toMatch(/apple-native:|pnpm apple:/);
    expect(read('src/renderer/sync/provision/hosted-runtime.ts')).toContain("ensureAndListPending('hosted')");
    expect(read('src/renderer/sync/provision/hosted-runtime.ts')).not.toMatch(/GoogleDrive|google-drive/);
  });

  it('preserves the published database baseline and shared Tauri persistence crates', () => {
    expect(createHash('sha256').update(read('drizzle/0000_local_first_baseline.sql')).digest('hex'))
      .toBe('2ee852a7490b3dfb8fb9095a29d90d8c54c0b2bbfc0d00e0c7567be15f38c1e2');
    expect(read('src-tauri/Cargo.toml')).toContain('drifting-core = { path = "../crates/drifting-core" }');
    expect(read('src-tauri/Cargo.toml')).toContain('drifting-prose = { path = "../crates/drifting-prose" }');
    expect(read('crates/drifting-prose/Cargo.toml')).toContain('drifting-document');
    expect(read('src-tauri/src/secure_storage.rs')).toContain('"sync.google-drive."');
    expect(existsSync(resolve(process.cwd(), 'src/renderer/sync/hosted/adopt-drive.integration.test.ts'))).toBe(true);
  });
});
