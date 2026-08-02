import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from './p3-file-backed-sqlite';

const DRIZZLE_DIRECTORY = new URL('../../../../../../drizzle/', import.meta.url);

describe('product file-backed migration acceptance', () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    directories.clear();
  });

  it('follows the checked-in journal and reopens idempotently', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'drifting-product-migrations-'),
    );
    directories.add(directory);
    const databasePath = path.join(directory, 'drifting.db');
    const journal = JSON.parse(
      readFileSync(
        new URL('meta/_journal.json', DRIZZLE_DIRECTORY),
        'utf8',
      ),
    ) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const latest = journal.entries[journal.entries.length - 1]!;
    const latestBytes = readFileSync(
      new URL(`${latest.tag}.sql`, DRIZZLE_DIRECTORY),
    );

    const first = new ProductFileBackedSqliteGateway(databasePath);
    expect((await first.open('drifting.db')).migrationsApplied).toBe(
      journal.entries.length,
    );
    expect(
      first.database
        .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: journal.entries.length });
    expect(
      first.database
        .prepare(
          'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1',
        )
        .get(),
    ).toEqual({
      hash: createHash('sha256').update(latestBytes).digest('hex'),
      created_at: latest.when,
    });
    expect(
      first.database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('book_node', 'node_content', 'yjs_updates', 'agent_runtime_write_effect', 'entity_snapshot_history')",
        )
        .get(),
    ).toEqual({ count: 5 });
    expect(
      first.database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_user_checkpoint%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    const conversationColumns = first.database
      .prepare("PRAGMA table_info('agent_conversation')")
      .all() as Array<{ name: string }>;
    expect(conversationColumns.map((column) => column.name)).not.toContain('fork_checkpoint_id');
    expect(conversationColumns.map((column) => column.name)).not.toContain(
      'parent_conversation_id',
    );
    await first.close();

    const reopened = new ProductFileBackedSqliteGateway(databasePath);
    expect((await reopened.open('drifting.db')).migrationsApplied).toBe(0);
    expect(
      reopened.database
        .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: journal.entries.length });
    await reopened.close();
  });
});
