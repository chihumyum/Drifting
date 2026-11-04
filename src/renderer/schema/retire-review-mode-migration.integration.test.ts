import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const DRIZZLE_DIRECTORY = new URL('../../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const RETIRE_MIGRATION = '0018_retire_review_mode';
const NOW = '2026-11-05T00:00:00.000Z';
const LATER = '2026-11-05T00:00:01.000Z';
const RETIRED_REVIEW_COLUMNS = [
  'decision_note_json',
  'revert_effect_json',
  'error_code',
  'error_message',
  'rejected_at',
  'revert_started_at',
];
const RETIRED_BLOCK_COLUMNS = [
  'decision_note_json',
  'revert_effect_json',
  'error_code',
  'error_message',
  'revert_started_at',
];
const databases: DatabaseSync[] = [];

/** Applies journal entries like the native migrator: one transaction, foreign keys off. */
function migrate(database: DatabaseSync, tags: readonly string[]): void {
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const tag of tags) {
      const sql = readFileSync(new URL(`${tag}.sql`, DRIZZLE_DIRECTORY), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (statement.trim()) database.exec(statement);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

/** One committed write effect per call, each with a settlement receipt. */
function insertEffect(database: DatabaseSync, index: number): void {
  database.exec(`
    INSERT INTO agent_runtime_tool_call (id, session_id, turn_id, call_id, name, access, idempotency_key, arguments_json, created_at)
      VALUES ('tool-${index}', 'session-1', 'turn-1', 'call-${index}', 'revise_chapter', 'write', 'idem-${index}', '{}', '${NOW}');
    INSERT INTO agent_runtime_write_effect (
      id, project_id, route_kind, conversation_id, session_id, turn_id, tool_call_id, call_id,
      tool_name, tool_access, idempotency_key, arguments_json, phase, claimed_at, updated_at)
      VALUES ('effect-${index}', 'project-1', 'chat', 'conversation-1', 'session-1', 'turn-1', 'tool-${index}', 'call-${index}',
      'revise_chapter', 'write', 'idem-${index}', '{}', 'result_committed', '${NOW}', '${NOW}');
  `);
}

/** A database at the previous public schema holding settlement receipts. */
function previousDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const tags = journal.entries.map((entry) => entry.tag);
  migrate(database, tags.slice(0, tags.indexOf(RETIRE_MIGRATION)));
  database.exec(`
    INSERT INTO project (id, name, user_id, created_at, updated_at)
      VALUES ('project-1', 'Migration', 'local-user', '${NOW}', '${NOW}');
    INSERT INTO agent_conversation (id, project_id, title, created_at, updated_at)
      VALUES ('conversation-1', 'project-1', 'Chat', '${NOW}', '${NOW}');
    INSERT INTO agent_runtime_session (id, project_id, route_kind, conversation_id, provider, created_at, updated_at)
      VALUES ('session-1', 'project-1', 'chat', 'conversation-1', 'deepseek', '${NOW}', '${NOW}');
    INSERT INTO agent_runtime_turn (id, session_id, ordinal, accepted_at, updated_at)
      VALUES ('turn-1', 'session-1', 0, '${NOW}', '${NOW}');
  `);
  for (const index of [1, 2]) insertEffect(database, index);
  database.exec(`
    INSERT INTO agent_runtime_write_review (
      id, effect_id, session_id, turn_id, tool_call_id, status, decision_note_json,
      created_at, accepted_at, settled_at, updated_at)
      VALUES ('review-1', 'effect-1', 'session-1', 'turn-1', 'tool-1', 'accepted_effect', '"auto mode"',
      '${NOW}', '${NOW}', '${LATER}', '${LATER}');
    INSERT INTO agent_runtime_write_review (id, effect_id, session_id, turn_id, tool_call_id, status, created_at, updated_at)
      VALUES ('review-2', 'effect-2', 'session-1', 'turn-1', 'tool-2', 'pending', '${NOW}', '${NOW}');
    INSERT INTO agent_runtime_write_review_block (review_id, effect_id, block_id, ordinal, status, created_at, settled_at, updated_at)
      VALUES ('review-2', 'effect-2', 'block-a', 0, 'accepted', '${NOW}', '${LATER}', '${LATER}');
    INSERT INTO agent_runtime_write_review_block (review_id, effect_id, block_id, ordinal, status, created_at, updated_at)
      VALUES ('review-2', 'effect-2', 'block-b', 1, 'pending', '${NOW}', '${NOW}');
  `);
  return database;
}

function columns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('0018 retire review mode migration', () => {
  it('drops the reject/revert columns and keeps every settlement receipt and block', () => {
    const database = previousDatabase();

    migrate(database, [RETIRE_MIGRATION]);

    for (const column of RETIRED_REVIEW_COLUMNS) {
      expect(columns(database, 'agent_runtime_write_review')).not.toContain(column);
    }
    for (const column of RETIRED_BLOCK_COLUMNS) {
      expect(columns(database, 'agent_runtime_write_review_block')).not.toContain(column);
    }
    expect(
      database
        .prepare(
          `SELECT id, effect_id, status, accepted_at, settled_at FROM agent_runtime_write_review ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: 'review-1', effect_id: 'effect-1', status: 'accepted_effect', accepted_at: NOW, settled_at: LATER },
      { id: 'review-2', effect_id: 'effect-2', status: 'pending', accepted_at: null, settled_at: null },
    ]);
    expect(
      database
        .prepare(
          `SELECT review_id, block_id, ordinal, status, settled_at FROM agent_runtime_write_review_block ORDER BY ordinal`,
        )
        .all(),
    ).toEqual([
      { review_id: 'review-2', block_id: 'block-a', ordinal: 0, status: 'accepted', settled_at: LATER },
      { review_id: 'review-2', block_id: 'block-b', ordinal: 1, status: 'pending', settled_at: null },
    ]);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'agent_runtime_write_review%' ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: 'idx_agent_runtime_write_review_block_status' },
      { name: 'idx_agent_runtime_write_review_session_status' },
      { name: 'sqlite_autoindex_agent_runtime_write_review_1' },
      { name: 'sqlite_autoindex_agent_runtime_write_review_block_1' },
      { name: 'uniq_agent_runtime_write_review_block_ordinal' },
      { name: 'uniq_agent_runtime_write_review_effect' },
      { name: 'uniq_agent_runtime_write_review_provenance' },
    ]);
    expect(database.prepare(`SELECT name FROM sqlite_temp_master`).all()).toEqual([]);
    expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(database.prepare(`PRAGMA integrity_check`).get()).toEqual({ integrity_check: 'ok' });
  });

  it('keeps the receipt references and cascades working after the column drops', () => {
    const database = previousDatabase();
    migrate(database, [RETIRE_MIGRATION]);

    expect(() =>
      database.exec(`
        INSERT INTO agent_runtime_write_review_block (review_id, effect_id, block_id, ordinal, status, created_at, updated_at)
          VALUES ('review-2', 'effect-1', 'block-c', 2, 'pending', '${NOW}', '${NOW}');
      `),
    ).toThrow(/FOREIGN KEY constraint failed/u);
    database.exec(`DELETE FROM agent_runtime_write_effect WHERE id = 'effect-2'`);
    expect(database.prepare(`SELECT id FROM agent_runtime_write_review`).all()).toEqual([
      { id: 'review-1' },
    ]);
    expect(database.prepare(`SELECT count(*) AS count FROM agent_runtime_write_review_block`).get()).toEqual({
      count: 0,
    });
  });

  it.each([
    ['review', `UPDATE agent_runtime_write_review SET status = 'reverted', rejected_at = '${LATER}' WHERE id = 'review-1'`],
    ['block', `UPDATE agent_runtime_write_review_block SET status = 'revert_failed', error_code = 'WRITE_BLOCK_REVERT_FAILED' WHERE block_id = 'block-b'`],
  ])('refuses a database holding a %s reject decision and leaves it unchanged', (_kind, decision) => {
    const database = previousDatabase();
    database.exec(decision);
    const before = {
      reviews: database.prepare(`SELECT * FROM agent_runtime_write_review ORDER BY id`).all(),
      blocks: database.prepare(`SELECT * FROM agent_runtime_write_review_block ORDER BY ordinal`).all(),
    };

    expect(() => migrate(database, [RETIRE_MIGRATION])).toThrow(/CHECK constraint failed/u);

    for (const column of RETIRED_REVIEW_COLUMNS) {
      expect(columns(database, 'agent_runtime_write_review')).toContain(column);
    }
    for (const column of RETIRED_BLOCK_COLUMNS) {
      expect(columns(database, 'agent_runtime_write_review_block')).toContain(column);
    }
    expect({
      reviews: database.prepare(`SELECT * FROM agent_runtime_write_review ORDER BY id`).all(),
      blocks: database.prepare(`SELECT * FROM agent_runtime_write_review_block ORDER BY ordinal`).all(),
    }).toEqual(before);
    expect(database.prepare(`SELECT name FROM sqlite_temp_master`).all()).toEqual([]);
  });
});
