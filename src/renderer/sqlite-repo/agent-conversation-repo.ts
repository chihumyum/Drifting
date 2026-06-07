/**
 * Local SQLite repo for Agent conversations (right-sidebar chat history).
 *
 * Local-only: not wired to the sync outbox. The display transcript lives in
 * messages_json; resuming context is the SDK's job via sdkSessionId. Soft-delete
 * via deletedAt to match the rest of the schema.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { AgentConversationTable } from '../schema/drizzle';
import type {
  AgentChatMessage,
  AgentConversation,
  AgentConversationSummary,
  AgentConvMode,
} from '../domain/agent-conversation';

function parseMessages(json: string | null | undefined): AgentChatMessage[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as AgentChatMessage[]) : [];
  } catch {
    return [];
  }
}

function coerceMode(mode: string): AgentConvMode {
  return mode === 'hosted' ? 'hosted' : 'byok';
}

function recordToDomain(record: typeof AgentConversationTable.$inferSelect): AgentConversation {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    sdkSessionId: record.sdkSessionId ?? null,
    mode: coerceMode(record.mode),
    messages: parseMessages(record.messagesJson),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface CreateAgentConversationInput {
  id: string;
  projectId: string;
  title: string;
  mode: AgentConvMode;
  messages: AgentChatMessage[];
  sdkSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateAgentConversationInput {
  title?: string;
  mode?: AgentConvMode;
  messages?: AgentChatMessage[];
  sdkSessionId?: string | null;
  updatedAt?: string;
}

/** Per-conversation token/cost totals, summed from its transcript usage rows. */
export interface AgentConversationUsage {
  id: string;
  title: string;
  updatedAt: string;
  /** Soft-delete marker — null while live. Deleted rows still count toward usage
   *  totals (the spend happened) but drop out of the manageable history list. */
  deletedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

export interface AgentConversationRepository {
  listByProject(projectId: string): Promise<AgentConversationSummary[]>;
  get(id: string): Promise<AgentConversation | null>;
  create(input: CreateAgentConversationInput): Promise<void>;
  update(id: string, patch: UpdateAgentConversationInput): Promise<void>;
  softDelete(id: string, deletedAt: string): Promise<void>;
  /** Soft-delete every live conversation in a project (one UPDATE). */
  softDeleteAllByProject(projectId: string, deletedAt: string): Promise<void>;
  /**
   * Per-conversation token/cost usage for a project (most-recent first).
   * `opts.since` (ISO) scopes the sum to usage entries stamped at/after it — e.g.
   * the start of the month; omit for all-time. Every conversation is still
   * returned (usage 0 when none in-window) so the row stays manageable.
   */
  usageByProject(
    projectId: string,
    opts?: { since?: string },
  ): Promise<AgentConversationUsage[]>;
}

export function createAgentConversationRepository(): AgentConversationRepository {
  return {
    async listByProject(projectId) {
      const rows = await getDb()
        .select({
          id: AgentConversationTable.id,
          title: AgentConversationTable.title,
          mode: AgentConversationTable.mode,
          updatedAt: AgentConversationTable.updatedAt,
        })
        .from(AgentConversationTable)
        .where(
          and(
            eq(AgentConversationTable.projectId, projectId),
            isNull(AgentConversationTable.deletedAt),
          ),
        )
        .orderBy(desc(AgentConversationTable.updatedAt));
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        mode: coerceMode(r.mode),
        updatedAt: r.updatedAt,
      }));
    },

    async usageByProject(projectId, opts) {
      const since = opts?.since;
      // Includes soft-deleted conversations on purpose: the tokens/cost were
      // really spent, so usage totals must survive a deleted chat. Callers split
      // live vs deleted via the returned `deletedAt`.
      const rows = await getDb()
        .select({
          id: AgentConversationTable.id,
          title: AgentConversationTable.title,
          updatedAt: AgentConversationTable.updatedAt,
          deletedAt: AgentConversationTable.deletedAt,
          messagesJson: AgentConversationTable.messagesJson,
        })
        .from(AgentConversationTable)
        .where(eq(AgentConversationTable.projectId, projectId))
        .orderBy(desc(AgentConversationTable.updatedAt));
      return rows.map((r) => {
        let inputTokens = 0;
        let outputTokens = 0;
        let costUsd = 0;
        let turns = 0;
        for (const m of parseMessages(r.messagesJson)) {
          if (m.kind !== 'usage') continue;
          // Time-scoped window: count only entries stamped at/after `since`.
          // Entries written before `at` existed are undated, so they fall
          // outside any bounded window (they still count for all-time).
          if (since && !(m.at && m.at >= since)) continue;
          inputTokens += m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens;
          outputTokens += m.outputTokens;
          costUsd += m.costUsd;
          turns += m.turns;
        }
        return {
          id: r.id,
          title: r.title,
          updatedAt: r.updatedAt,
          deletedAt: r.deletedAt ?? null,
          inputTokens,
          outputTokens,
          costUsd,
          turns,
        };
      });
    },

    async get(id) {
      const rows = await getDb()
        .select()
        .from(AgentConversationTable)
        .where(eq(AgentConversationTable.id, id))
        .limit(1);
      return rows[0] ? recordToDomain(rows[0]) : null;
    },

    async create(input) {
      const row: typeof AgentConversationTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
        title: input.title,
        mode: input.mode,
        messagesJson: JSON.stringify(input.messages),
        sdkSessionId: input.sdkSessionId ?? null,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      await getDb().insert(AgentConversationTable).values(row);
    },

    async update(id, patch) {
      const set: Partial<typeof AgentConversationTable.$inferInsert> = {};
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.mode !== undefined) set.mode = patch.mode;
      if (patch.messages !== undefined) set.messagesJson = JSON.stringify(patch.messages);
      if (patch.sdkSessionId !== undefined) set.sdkSessionId = patch.sdkSessionId;
      if (patch.updatedAt !== undefined) set.updatedAt = patch.updatedAt;
      await getDb()
        .update(AgentConversationTable)
        .set(set)
        .where(eq(AgentConversationTable.id, id));
    },

    async softDelete(id, deletedAt) {
      await getDb()
        .update(AgentConversationTable)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(eq(AgentConversationTable.id, id));
    },

    async softDeleteAllByProject(projectId, deletedAt) {
      await getDb()
        .update(AgentConversationTable)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(
          and(
            eq(AgentConversationTable.projectId, projectId),
            isNull(AgentConversationTable.deletedAt),
          ),
        );
    },
  };
}
