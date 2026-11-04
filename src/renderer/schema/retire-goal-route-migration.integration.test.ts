import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const DRIZZLE_DIRECTORY = new URL('../../../drizzle/', import.meta.url);
const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8')) as {
  entries: Array<{ tag: string }>;
};
const RETIRE_MIGRATION = '0017_retire_goal_route_and_sdk_session';
const NOW = '2026-11-05T00:00:00.000Z';
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

/** A database at the previous public schema with one chat conversation, its
 *  runtime session, one turn and one committed write effect. */
function previousDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const tags = journal.entries.map((entry) => entry.tag);
  migrate(database, tags.slice(0, tags.indexOf(RETIRE_MIGRATION)));
  database.exec(`
    INSERT INTO project (id, name, user_id, created_at, updated_at)
      VALUES ('project-1', 'Migration', 'local-user', '${NOW}', '${NOW}');
    INSERT INTO agent_conversation (id, project_id, title, sdk_session_id, created_at, updated_at)
      VALUES ('conversation-1', 'project-1', 'Chat', 'claude-sdk-session', '${NOW}', '${NOW}');
    INSERT INTO agent_conversation (id, project_id, title, created_at, updated_at)
      VALUES ('conversation-2', 'project-1', 'Other chat', '${NOW}', '${NOW}');
    INSERT INTO agent_runtime_session (id, project_id, route_kind, conversation_id, provider, created_at, updated_at)
      VALUES ('session-1', 'project-1', 'chat', 'conversation-1', 'deepseek', '${NOW}', '${NOW}');
    INSERT INTO agent_runtime_turn (id, session_id, ordinal, accepted_at, updated_at)
      VALUES ('turn-1', 'session-1', 0, '${NOW}', '${NOW}');
    INSERT INTO agent_runtime_tool_call (id, session_id, turn_id, call_id, name, access, idempotency_key, arguments_json, created_at)
      VALUES ('tool-1', 'session-1', 'turn-1', 'call-1', 'revise_chapter', 'write', 'idem-1', '{}', '${NOW}');
    INSERT INTO agent_runtime_write_effect (
      id, project_id, route_kind, conversation_id, session_id, turn_id, tool_call_id, call_id,
      tool_name, tool_access, idempotency_key, arguments_json, claimed_at, updated_at)
      VALUES ('effect-1', 'project-1', 'chat', 'conversation-1', 'session-1', 'turn-1', 'tool-1', 'call-1',
      'revise_chapter', 'write', 'idem-1', '{}', '${NOW}', '${NOW}');
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

describe('0017 retire Goal route and SDK session migration', () => {
  it('drops the retired columns and keeps every chat runtime row and reference', () => {
    const database = previousDatabase();

    migrate(database, [RETIRE_MIGRATION]);

    expect(columns(database, 'agent_conversation')).not.toContain('sdk_session_id');
    expect(columns(database, 'agent_runtime_session')).not.toContain('goal_run_id');
    expect(columns(database, 'agent_runtime_session')).not.toContain('chapter_id');
    expect(columns(database, 'agent_runtime_write_effect')).not.toContain('goal_run_id');
    expect(columns(database, 'agent_runtime_write_effect')).not.toContain('chapter_id');
    expect(
      database.prepare(`SELECT id, conversation_id FROM agent_runtime_session`).all(),
    ).toEqual([{ id: 'session-1', conversation_id: 'conversation-1' }]);
    expect(database.prepare(`SELECT id FROM agent_runtime_turn`).all()).toEqual([{ id: 'turn-1' }]);
    expect(database.prepare(`SELECT id FROM agent_runtime_write_effect`).all()).toEqual([
      { id: 'effect-1' },
    ]);
    expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(database.prepare(`PRAGMA integrity_check`).get()).toEqual({ integrity_check: 'ok' });
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_runtime_session_goal'`)
        .all(),
    ).toEqual([]);
  });

  it('keeps the route-provenance and chat-queue triggers working on the rebuilt table', () => {
    const database = previousDatabase();
    migrate(database, [RETIRE_MIGRATION]);

    database.exec(`
      INSERT INTO agent_runtime_tool_call (id, session_id, turn_id, call_id, name, access, idempotency_key, arguments_json, created_at)
        VALUES ('tool-2', 'session-1', 'turn-1', 'call-2', 'revise_chapter', 'write', 'idem-2', '{}', '${NOW}');
    `);
    expect(() =>
      database.exec(`
        INSERT INTO agent_runtime_write_effect (
          id, project_id, route_kind, conversation_id, session_id, turn_id, tool_call_id, call_id,
          tool_name, tool_access, idempotency_key, arguments_json, claimed_at, updated_at)
          VALUES ('effect-2', 'project-1', 'chat', 'conversation-2', 'session-1', 'turn-1', 'tool-2', 'call-2',
          'revise_chapter', 'write', 'idem-2', '{}', '${NOW}', '${NOW}');
      `),
    ).toThrow(/agent write effect route provenance mismatch/u);
    expect(() =>
      database.exec(`UPDATE agent_runtime_session SET conversation_id = 'conversation-2' WHERE id = 'session-1'`),
    ).toThrow(/agent runtime session route has durable write effects/u);
    expect(() =>
      database.exec(`
        INSERT INTO agent_runtime_session (id, project_id, route_kind, provider, created_at, updated_at)
          VALUES ('session-goal', 'project-1', 'goal', 'deepseek', '${NOW}', '${NOW}');
      `),
    ).toThrow(/CHECK constraint failed/u);

    database.exec(`DELETE FROM agent_chat_queue`);
    database.exec(`UPDATE agent_runtime_turn SET status = 'completed' WHERE id = 'turn-1'`);
    expect(database.prepare(`SELECT conversation_id FROM agent_chat_queue`).all()).toEqual([
      { conversation_id: 'conversation-1' },
    ]);
  });

  it('refuses a database that still holds a Goal session instead of discarding it', () => {
    const database = previousDatabase();
    database.exec(`
      INSERT INTO agent_runtime_session (id, project_id, route_kind, goal_run_id, chapter_id, provider, created_at, updated_at)
        VALUES ('session-goal', 'project-1', 'goal', 'goal-run-1', 'chapter-1', 'deepseek', '${NOW}', '${NOW}');
    `);

    expect(() => migrate(database, [RETIRE_MIGRATION])).toThrow(/CHECK constraint failed/u);
    expect(columns(database, 'agent_runtime_session')).toContain('goal_run_id');
    expect(columns(database, 'agent_conversation')).toContain('sdk_session_id');
    expect(
      database.prepare(`SELECT id FROM agent_runtime_session ORDER BY id`).all(),
    ).toEqual([{ id: 'session-1' }, { id: 'session-goal' }]);
  });
});
