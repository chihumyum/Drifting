import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('library backup acceptance', () => {
  it('offers backup and restore in local data settings, gated on a local library', () => {
    const panel = source('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const settings = source('src/renderer/features/settings/panels/LibraryBackupSettings.tsx');
    expect(panel).toMatch(/settings\.sync\.local_data[\s\S]*?<LibraryBackupSettings \/>/);
    expect(settings).toContain("authority.status === 'local'");
    expect(settings).toContain("getPlatformRuntime().target !== 'desktop'");
    expect(settings).toContain('discardBackup(inspected.restoreId)');
    expect(settings).toContain('destructive: true');
  });

  it('keeps packaging, verification and replacement in drifting-core', () => {
    const adapter = source('src-tauri/src/library_backup.rs');
    const core = source('crates/drifting-core/src/library_backup.rs');
    const gateway = source('crates/drifting-core/src/database.rs');
    const commands = source('src-tauri/src/lib.rs');
    for (const command of ['export', 'inspect', 'restore', 'discard', 'open_safety_directory']) {
      expect(commands).toContain(`library_backup::library_backup_${command},`);
    }
    expect(adapter).not.toMatch(/ZipArchive|VACUUM INTO|sync_generation_writer_state/);
    expect(core).toContain('require_local_authority');
    expect(core).toContain('UPDATE sync_generation_writer_state SET retired_at');
    expect(core).toContain('durable_replace_file(&candidate, database_path)');
    expect(gateway).toContain('Request::Begin { .. } | Request::SnapshotActiveDatabase { .. } => true');
  });

  it('documents the format, restore order and sync boundary', () => {
    const doc = source('docs/library-backup.md');
    for (const phrase of ['manifest.json', 'library.sqlite', 'pre-restore', 'library-sync-connected', 'additively']) {
      expect(doc).toContain(phrase);
    }
    expect(source('docs/README.md')).toContain('(library-backup.md)');
    expect(source('docs/local-data-export.md')).toContain('(library-backup.md)');
  });

  it('localizes every backup message in both languages', () => {
    const keys = (locale: string) => {
      const sync = JSON.parse(source(`src/renderer/locales/${locale}.json`)).settings.sync.backup as Record<string, unknown>;
      return Object.keys(sync).sort();
    };
    expect(keys('zh-CN')).toEqual(keys('en'));
    const used = [...source('src/renderer/features/settings/panels/LibraryBackupSettings.tsx')
      .matchAll(/settings\.sync\.backup\.([a-zA-Z]+)/g)].map((match) => match[1]);
    for (const key of used) expect(keys('en')).toContain(key);
  });
});
