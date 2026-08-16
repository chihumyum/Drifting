import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const providerRoot = path.resolve(process.cwd(), 'src/renderer/sync/providers/google-drive');
const platformContracts = path.resolve(process.cwd(), 'src/renderer/platform/contracts.ts');
const nativeSource = path.resolve(process.cwd(), 'src-tauri/src/google_drive_sync.rs');

describe('Google Drive native transport architecture', () => {
  it('keeps the provider contract free of DB, domain, Yjs, raw HTTP and Tauri imports', () => {
    for (const name of ['provider.ts', 'transport.ts']) {
      const source = fs.readFileSync(path.join(providerRoot, name), 'utf8');
      expect(source, name).not.toMatch(/from ['"]@tauri-apps/u);
      expect(source, name).not.toMatch(/from ['"]drizzle-orm/u);
      expect(source, name).not.toMatch(/(?:schema|lib\/db|sqlite-repo|usecase|domain|yjs)/u);
      expect(source, name).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b/u);
    }
  });

  it('does not project credential/session/path fields through Drive renderer DTOs', () => {
    const source = fs.readFileSync(platformContracts, 'utf8');
    const start = source.indexOf('export type GoogleDriveNativeErrorCode');
    const end = source.indexOf('export interface DeepLinkEventPayload');
    const driveDtos = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(driveDtos).not.toMatch(
      /accessToken|refreshToken|bearerToken|sessionUri|resumableUri|filePath|absolutePath/u,
    );
  });

  it('locks native Drive to appDataFolder, root-confined uploads and durable downloads', () => {
    const source = fs.readFileSync(nativeSource, 'utf8');
    expect(source).toContain('https://www.googleapis.com/auth/drive.appdata');
    expect(source).not.toMatch(/googleapis\.com\/auth\/drive(?:\.file)?["\s]/u);
    expect(source).toContain('const APP_DATA_FOLDER: &str = "appDataFolder"');
    expect(source).toContain('validate_upload_ref(');
    expect(source).toContain('resolve_download_destination_ref(');
    expect(source).toContain('durable_replace_file(');
    expect(source).not.toMatch(/println!|eprintln!|dbg!|tracing::|log::/u);
  });
});
