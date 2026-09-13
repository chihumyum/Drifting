import { sql, type SQLWrapper } from 'drizzle-orm';

/**
 * Match only the exact retained digest emitted by the repository. Only canonical
 * retained digests are omitted here; JSON is never parsed in this SQL filter.
 * The literal expression also defines the partial index in migration 0003.
 */
export function fullAgentCheckpointPredicate(table: { contextJson: SQLWrapper; contextHash: SQLWrapper }) {
  return sql`${table.contextJson} != json_object('contextHash', ${table.contextHash}, 'format', 'drifting.agent-runtime-checkpoint-digest', 'schemaVersion', 1)`;
}
