import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(process.cwd(), 'src/renderer/sync/providers/local-folder');

describe('LocalFolder provider architecture', () => {
  it('keeps production provider modules free of filesystem, Tauri, DB, Yjs, and domain imports', () => {
    for (const name of ['provider.ts', 'transport.ts', 'index.ts']) {
      const source = fs.readFileSync(path.join(root, name), 'utf8');
      expect(source, name).not.toMatch(/from ['"]node:/u);
      expect(source, name).not.toMatch(/from ['"]@tauri-apps/u);
      expect(source, name).not.toMatch(/from ['"]drizzle-orm/u);
      expect(source, name).not.toMatch(/(?:schema|lib\/db|usecase|domain|yjs)/u);
      expect(source, name).not.toMatch(/Uint8Array/u);
    }
  });

  it('exposes only opaque source/destination and root references at the provider boundary', () => {
    const source = fs.readFileSync(path.join(root, 'transport.ts'), 'utf8');
    expect(source).toMatch(/sourceRef: LocalObjectRef/u);
    expect(source).toMatch(/destinationRef: LocalObjectRef/u);
    expect(source).toMatch(/rootSecretRef: string/u);
    expect(source).not.toMatch(/(?:sourcePath|destinationPath|rootPath|absolutePath)/u);
  });
});
