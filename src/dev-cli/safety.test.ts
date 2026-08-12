import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOfflineWriteAuthorized, backupDatabase, resolveDatabaseTarget } from './safety';

const directories: string[] = [];
afterEach(async () => {
  delete process.env.DRIFTING_CLI_ALLOW_NON_USERDATA_WRITE;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('offline database safety', () => {
  it('refuses a non-userdata mutation unless the isolated-fixture override is explicit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-cli-safety-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'fixture.db');
    await writeFile(databasePath, '');
    const target = await resolveDatabaseTarget(databasePath, true);
    expect(() =>
      assertOfflineWriteAuthorized({ target, offlineUserdata: true, yes: true }),
    ).toThrow(/outside Drifting user data/u);
    process.env.DRIFTING_CLI_ALLOW_NON_USERDATA_WRITE = '1';
    expect(() =>
      assertOfflineWriteAuthorized({ target, offlineUserdata: true, yes: true }),
    ).not.toThrow();
  });

  it('requires both the offline selector and non-interactive confirmation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-cli-safety-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'fixture.db');
    await writeFile(databasePath, '');
    const target = await resolveDatabaseTarget(databasePath, false);
    expect(() =>
      assertOfflineWriteAuthorized({ target, offlineUserdata: false, yes: true }),
    ).toThrow(/both --offline-userdata and --yes/u);
  });

  it('creates a consistent SQLite backup before mutation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-cli-backup-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'fixture.db');
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE evidence (value TEXT NOT NULL); INSERT INTO evidence VALUES ('durable');",
    );
    database.close();
    const backupPath = await backupDatabase(databasePath, 'request-1');
    const copy = new DatabaseSync(backupPath, { readOnly: true });
    try {
      expect(copy.prepare('SELECT value FROM evidence').get()).toEqual({ value: 'durable' });
    } finally {
      copy.close();
    }
  });
});
