import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

/** Tracked files that may still name the retired sync provider. */
const RETIRED_PROVIDER_RECORDS = new Set([
  'AGENTS.md',
  // Published schema history and the migration that retired the provider.
  'drizzle/0000_local_first_baseline.sql',
  'drizzle/0014_retire_google_drive_sync.sql',
  'drizzle/meta/_journal.json',
  // The schema mirror of the published CHECK constraints.
  'src/renderer/schema/drizzle.ts',
  // Tests proving old Drive libraries migrate and Drive values are refused.
  'src/renderer/lib/agent/runtime/acceptance/p3-product-migrations.integration.test.ts',
  'src/renderer/schema/retire-google-drive-migration.integration.test.ts',
  'src/renderer/sync/app-authority.test.ts',
  'src/renderer/sync/app-authority-repository.integration.test.ts',
  'src/renderer/sync/hosted/hosted.integration.test.ts',
  'src/renderer/architecture/retired-client-integrations.acceptance.test.ts',
]);

function trackedFilesMatching(pattern: string): string[] {
  try {
    return execFileSync('git', ['grep', '-l', '-I', '-i', '-E', pattern, '--', '.'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).split('\n').filter(Boolean);
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

describe('retired client integrations', () => {
  it('keeps Google Drive sync out of the source tree', () => {
    const files = trackedFilesMatching('google[ _-]?drive|googledrive|DRIFTING_GOOGLE_|appDataFolder')
      .filter(file => !RETIRED_PROVIDER_RECORDS.has(file))
      .filter(file => !/^drizzle\/meta\/\d{4}_snapshot\.json$/u.test(file))
      // Dated acceptance evidence records the test names of its own run.
      .filter(file => !/^docs\/.+\/acceptance\/.+\.json$/u.test(file));
    expect(files).toEqual([]);
  });

  it('keeps the standalone Apple-native front-end out of the source tree', () => {
    for (const path of ['native', 'crates/drifting-apple-bridge']) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
    }
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(Object.keys(scripts).filter(key => key.startsWith('apple:'))).toEqual([]);
  });

  it('preserves the published database baseline and shared Tauri persistence crates', () => {
    expect(createHash('sha256').update(read('drizzle/0000_local_first_baseline.sql')).digest('hex'))
      .toBe('2ee852a7490b3dfb8fb9095a29d90d8c54c0b2bbfc0d00e0c7567be15f38c1e2');
    expect(read('src-tauri/Cargo.toml')).toContain('drifting-core = { path = "../crates/drifting-core" }');
    expect(read('src-tauri/Cargo.toml')).toContain('drifting-prose = { path = "../crates/drifting-prose" }');
    expect(read('crates/drifting-prose/Cargo.toml')).toContain('drifting-document');
  });
});
